const config = require('./config');
const log = require('./log');
const state = require('./state');
const tasks = require('./tasks');
const rotation = require('./rotation');
const lastmessage = require('./lastmessage');

// ── Telegram notification + turn UX ─────────────────────────────────────────
// sendTelegramMessage/notifyUser deliver wrapper-initiated notices; the turn
// machinery acknowledges long-running tasks in the chat with LIVE task-list
// status (progress + current item) so they don't feel stuck, and surfaces
// progress in the wrapper log.
// ─────────────────────────────────────────────────────────────────────────────

const TURN_PING_INTERVAL_MS = 5 * 60 * 1000; // progress ping cadence (every 5 min)
const TURN_MAX_PINGS = 12;                   // safety cap (~60 min of pings)
const TURN_ACK_THROTTLE_MS = 15 * 1000;      // don't re-ack bursts of messages
const TURN_ACK_DELAY_MS = 3 * 60 * 1000;     // ack only if no reply lands by then (3 min)

let activeTurn = null;                       // { chatId, startedAt, pings, timer }
let pendingAck = null;                       // { chatId, timer } — ack not yet sent
let lastAckAt = 0;

// ── Real turn feedback ─────────────────────────────────────────────────────
// The ack/pings report what is ACTUALLY happening, read live from the
// workspace task list (counts + the first unchecked item = what the agent is
// on right now). No task list → a short honest note, never an invented ETA.
function cleanTaskItem(text) {
  return String(text || '')
    .replace(/\*\*/g, '')       // strip markdown bold markers
    .replace(/`/g, '')          // strip backticks (inline-code fences)
    .replace(/\s+/g, ' ')
    .trim();
}

// Live one-liner: "4/8 tasks done (50%) — on: …" or null when nothing tracked.
function taskStatusText() {
  const p = tasks.getTaskProgress();
  if (!p) return null;
  if (p.done >= p.total) return `📋 ${p.done}/${p.total} tasks done — wrapping up`;
  const pct = Math.round((p.done / p.total) * 100);
  // First unchecked item = what the agent is on right now. Truncate at a word
  // boundary so the preview never ends mid-word.
  const MAX_ITEM = 90;
  let active = cleanTaskItem(p.pending[0] || '');
  if (active.length > MAX_ITEM) {
    const cut = active.slice(0, MAX_ITEM).lastIndexOf(' ');
    active = `${active.slice(0, cut > 40 ? cut : MAX_ITEM)}…`;
  }
  if (!active) return `📋 ${p.done}/${p.total} tasks done (${pct}%)`;
  return `📋 ${p.done}/${p.total} tasks done (${pct}%) — on: “${active}”`;
}

// Acknowledgement sent when a task is clearly long-running.
// Includes the current key/model and cooldown grid so the user sees the real state.
function turnAckText() {
  const status = taskStatusText();
  const key = state.curKeyIndex;
  const model = state.curModelIndex;
  const modelName = config.MODELS[model] || `model#${model}`;
  const base = status
    ? `🛠️ On it — ${status}`
    : '🛠️ On it';
  return `${base}.\n🔑 Using key #${key} / ${modelName}\n${rotation.gridSummary()}\nThe answer will land in this chat when it's done.`;
}

// Progress ping: the same live status, prefixed with elapsed time.
// Includes the current key/model and cooldown grid so the user always sees
// the real state instead of a generic "still working" message.
function turnPingText(mins) {
  const status = taskStatusText();
  const key = state.curKeyIndex;
  const model = state.curModelIndex;
  const modelName = config.MODELS[model] || `model#${model}`;
  const base = status
    ? `⏳ ${mins} min in — ${status}`
    : `⏳ Still working after ${mins} min`;
  return `${base}.\n🔑 Using key #${key} / ${modelName}\n${rotation.gridSummary()}`;
}

// Sends a chat message through the Telegram Bot API as the same bot.
async function sendTelegramMessage(chatId, text) {
  try {
    log(`[Telegram] → chat ${chatId}: ${text.replace(/\n/g, ' | ')}`);
    const res = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_notification: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) log(`[Telegram] sendMessage failed: ${body.description || `HTTP ${res.status}`}`);
    return body.ok === true;
  } catch (err) {
    log(`[Telegram] sendMessage error: ${err.message}`);
    return false;
  }
}

// Chat id for wrapper-initiated notices: the allowed user (DM chat id equals
// the user id), else the last chat seen in the connector logs.
function noticeChatId() {
  return config.ALLOWED_USER_ID || state.lastSeenChatId || null;
}

// Best-effort notice to the user; never throws or blocks the rotation path.
function notifyUser(text) {
  const chatId = noticeChatId();
  if (!chatId || state.shuttingDown) return;
  sendTelegramMessage(chatId, text);
}

// ── Park-time message queue ──────────────────────────────────────────────────
// While EVERY key×model combo is on cooldown there is no connector running, so
// a user message would otherwise sit unread for up to ~24h — the "agents are
// frozen" symptom. The wrapper polls Telegram getUpdates itself (the bot token
// is free: no connector holds getUpdates while parked), acknowledges each new
// message with a "queued" notice and PERSISTS it, so the auto-resume picks the
// work up the moment a combo frees.
let parkUpdateOffset = 0;   // last consumed update_id+1, per wrapper process
let parkPollInFlight = false;   // guard: never run two getUpdates calls at once

async function ackQueuedDuringPark(earliestUnblockAt) {
  if (!config.TELEGRAM_BOT_TOKEN || state.shuttingDown) return;
  if (parkPollInFlight) return;          // a slow fetch must not overlap the next poll (Telegram 409)
  parkPollInFlight = true;
  try {
    let body;
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/getUpdates?timeout=0&offset=${parkUpdateOffset}`,
        { signal: AbortSignal.timeout(15000) }
      );
      body = await res.json().catch(() => ({}));
    } catch (err) {
      log(`[Park] getUpdates poll failed: ${err.message}`);
      return;
    }
    if (!body.ok) return;                 // transient API error — next tick retries

    const minsLeft = Math.max(1, Math.round((earliestUnblockAt - Date.now()) / 60000));
    const when = new Date(earliestUnblockAt).toISOString().slice(11, 16);
    for (const u of body.result || []) {
      if (!u || !u.update_id) continue;
      parkUpdateOffset = Math.max(parkUpdateOffset, u.update_id + 1);
      const msg = u.message || u.channel_post;
      if (!msg) continue;
      const chatId = String((msg.chat && msg.chat.id) || '');
      const fromId = String((msg.from && msg.from.id) || '');
      const text = (msg.text || msg.caption || '').trim();
      if (!chatId || !text) continue;
      if (text.startsWith('/')) continue;              // commands wait for the real connector
      if (config.ALLOWED_USER_ID && String(config.ALLOWED_USER_ID) !== fromId && String(config.ALLOWED_USER_ID) !== chatId) continue;

      // Persist the FULL message so the auto-resume retries exactly this request.
      state.lastSeenChatId = chatId;
      state.lastUserMessage = text;
      state.resumeAttempts = 0;                        // fresh request: resume retry budget restarts
      lastmessage.save(chatId, text);
      log(`[Park] User message queued (chat ${chatId}): "${text.slice(0, 80)}"`);
      sendTelegramMessage(chatId, `⏳ Got it — queued. All API keys/models are on cooldown until ~${when} UTC (${minsLeft}m). I'll auto-resume and answer as soon as quota frees up.`);
    }
  } finally {
    parkPollInFlight = false;
  }
}

// The shared cline.log line is a single JSON object. Parsing the WHOLE line
// lets textPreview / threadId / sessionId be decoded once by JSON.parse
// (escaping handled correctly) instead of regex-slicing a fragment and
// re-wrapping it in a JS string literal (which breaks the auto-resume input
// when the user's text contains quotes). Returns null for non-JSON lines.
function parseLogLine(line) {
  try { return JSON.parse(line); } catch (_) { return null; }
}

// Turns "telegram:123456" thread ids (also works for group ids) into chat ids.
// Prefers the parsed JSON object when available; falls back to the regex on
// the raw line, and finally to the last chat seen in the logs.
function extractChatId(line, obj) {
  if (obj && typeof obj.threadId === 'string') {
    const m = obj.threadId.match(/^telegram:(-?\d+)$/);
    if (m) {
      state.lastSeenChatId = m[1];
      return m[1];
    }
  }
  const m = line.match(/"threadId":"telegram:(-?\d+)"/);
  if (m) {
    state.lastSeenChatId = m[1];
    return m[1];
  }
  return state.lastSeenChatId;               // fallback: last chat seen in the logs
}

function stopTurn() {
  if (activeTurn && activeTurn.timer) clearInterval(activeTurn.timer);
  activeTurn = null;
  cancelPendingAck();
}

// Actually starts tracking a turn: sends the acknowledgement and begins the
// progress pings. Called only once it's clear the connector hasn't answered
// instantly, i.e. a genuinely long-running task.
function startTurn(chatId) {
  stopTurn();
  activeTurn = { chatId, startedAt: Date.now(), pings: 0, timer: null };
  activeTurn.timer = setInterval(() => {
    if (!activeTurn) return;
    if (activeTurn.pings >= TURN_MAX_PINGS) {
      log('[Turn] Ping cap reached; going quiet until the reply lands.');
      stopTurn();
      return;
    }
    activeTurn.pings++;
    const mins = Math.round((Date.now() - activeTurn.startedAt) / 60000);
    sendTelegramMessage(activeTurn.chatId, turnPingText(mins));
  }, TURN_PING_INTERVAL_MS);

  // Ack leads with live task-list status; if every key/model combo is parked
  // on quota, say that instead.
  const allBlocked = rotation.pickNextCombo().waitMs > 0;
  const now = Date.now();
  if (now - lastAckAt < TURN_ACK_THROTTLE_MS) return;   // burst guard
  lastAckAt = now;
  log(`[Turn] Acknowledging chat ${chatId}${allBlocked ? ' (quota exhausted notice)' : ''}.`);
  sendTelegramMessage(chatId, allBlocked
    ? `⛔ All API keys/models are on cooldown right now (until ${new Date(rotation.earliestUnblock()).toISOString().slice(11, 16)} UTC). Your message is queued — I'll answer when quota resets.`
    : turnAckText());
}

function cancelPendingAck() {
  if (pendingAck && pendingAck.timer) clearTimeout(pendingAck.timer);
  pendingAck = null;
}

// Fired when the connector logs that a user message arrived. The ack is
// DELAYED: if the connector replies quickly (chat commands like /new, or
// simple questions), the reply lands first and the ack is cancelled. It only
// fires when nothing has come back — a genuinely long-running task.
function onTurnStarted(line) {
  const obj = parseLogLine(line);
  const chatId = extractChatId(line, obj);
  if (!chatId) {
    log('[Turn] Message received, but no chat id found in the log line.');
    return;
  }

  // Slash commands (/new, /cwd, /tools, …) are handled instantly by the
  // connector — never treat them as heavy tasks. textPreview comes from the
  // parsed JSON object (plain text) or the regex as a last resort.
  const preview = (obj && typeof obj.textPreview === 'string')
    ? obj.textPreview
    : ((line.match(/"textPreview":"((?:[^"\\]|\\.)*)"/) || [])[1] || '');
  if (preview.startsWith('/')) {
    // Wrapper-level consultation commands: /keys (or /keymap, /cooldowns,
    // /combo) replies with the persisted cooldown grid; /status replies with
    // the instance's live runtime state. Any reply the connector itself makes
    // to the unknown command is harmless — these are the authoritative answers.
    if (/^\/(keys|keymap|cooldowns|combo)(\s|$)/i.test(preview)) {
      sendTelegramMessage(chatId, rotation.gridStatus());
      log(`[Turn] Command "${preview}" → served the persisted cooldown grid, no ack.`);
      return;
    }
    if (/^\/status(\s|$)/i.test(preview)) {
      sendTelegramMessage(chatId, statusText());
      log(`[Turn] Command "${preview}" → served instance status, no ack.`);
      return;
    }
    log(`[Turn] Command "${preview}" received — handled instantly, no ack.`);
    return;
  }

  // Remember the user's message (decoded from JSON escapes) so the auto-resume
  // can continue the interrupted conversation when no task list exists. Only
  // overwrite when a preview is actually present — a line without one must not
  // erase the captured request.
  if (preview) {
    // The parsed object already holds plain text; only the regex fallback
    // needs the JSON-string unescape wrapper.
    let decoded = preview;
    if (!obj) {
      try { decoded = JSON.parse(`"${preview}"`); } catch (_) { decoded = preview; }
    }
    state.lastUserMessage = decoded;
    state.resumeAttempts = 0;               // fresh user request: resume retry budget restarts
    // Persist immediately: a rotation that restarts the wrapper must still be
    // able to retry this message after the in-memory state is gone.
    lastmessage.save(chatId, decoded);
  }

  // Another message from the same chat while we're already working: just reset
  // the elapsed clock, no new acknowledgement.
  if (activeTurn && activeTurn.chatId === chatId) {
    activeTurn.startedAt = Date.now();
    activeTurn.pings = 0;
    log('[Turn] Follow-up message received; still working.');
    return;
  }

  cancelPendingAck();

  pendingAck = {
    chatId,
    timer: setTimeout(() => {
      pendingAck = null;
      log(`[Turn] No reply after ${TURN_ACK_DELAY_MS / 60000} min (chat ${chatId}) — acknowledging so it doesn't feel stuck.`);
      startTurn(chatId);
    }, TURN_ACK_DELAY_MS),
  };
}

function onTurnDone(ok) {
  // Cancel any not-yet-sent ack FIRST — a fast reply (like /new) lands while
  // its acknowledgement is still waiting on the delay timer, and activeTurn
  // doesn't exist yet in that case.
  cancelPendingAck();
  if (ok) {
    // The user's last message has been answered — drop it so a later rotation
    // doesn't retry an already-answered request. This must happen BEFORE the
    // activeTurn guard: a fast reply completes with no active turn at all.
    // A failed turn keeps the message: the auto-resume must retry exactly
    // this message after rotating.
    state.lastUserMessage = null;
    state.resumeAttempts = 0;
    lastmessage.clear();
  }
  if (!activeTurn) return;
  const mins = Math.round((Date.now() - activeTurn.startedAt) / 60000);
  log(`[Turn] Task ${ok ? 'completed' : 'failed'} after ~${mins} min (chat ${activeTurn.chatId}).`);
  stopTurn();
}

// Maps connector log messages to turn events.
function handleTurnEvent(line) {
  const obj = parseLogLine(line);
  const msg = (obj && typeof obj.msg === 'string')
    ? obj.msg
    : ((line.match(/"msg":"([^"]+)"/) || [])[1] || '');

  if (msg === 'Telegram message received') { onTurnStarted(line); return; }
  if (msg === 'Telegram reply completed') { onTurnDone(true); return; }
  if (msg === 'Telegram reply failed' || msg === 'Telegram turn handling failed') {
    onTurnDone(false);   // the limit path logs the details
    return;
  }
  if (msg === 'Telegram thread started RPC session' || msg === 'Telegram thread reusing RPC session') {
    const sessionId = (obj && obj.sessionId) || (line.match(/"sessionId":"([^"]+)"/) || [])[1] || '?';
    log(`[Turn] ${msg} (session ${sessionId})`);
  }
}

// Live runtime snapshot for the /status chat command: instance identity, the
// current key/model, wrapper/connector pids and uptime, and the cooldown grid.
function statusText() {
  const rec = rotation.recommendCombo();
  return [
    `🤖 ${config.INSTANCE_NAME} — @${config.BOT_USER_ID || '?'}`,
    `🔑 Key #${state.curKeyIndex} / ${config.MODELS[state.curModelIndex] || '?'}`,
    `⚙️ Wrapper pid ${process.pid} — ${state.currentClinePid ? `connector pid ${state.currentClinePid}` : 'connector NOT running'}`,
    `🕐 Uptime ${Math.round(process.uptime() / 60)}m`,
    rotation.gridSummary(),
    rec.waitMs > 0
      ? `⏳ Next free ~${new Date(Date.now() + rec.waitMs).toISOString().slice(11, 16)} UTC`
      : `→ Ready: key #${rec.key} / ${config.MODELS[rec.model] || '?'}`,
  ].join('\n');
}

module.exports = {
  sendTelegramMessage,
  notifyUser,
  extractChatId,
  handleTurnEvent,
  onTurnDone,
  ackQueuedDuringPark,
  // Pure feedback builders — exported for tests.
  taskStatusText,
  turnAckText,
  turnPingText,
  statusText,
};
