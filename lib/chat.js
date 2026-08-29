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
function turnAckText() {
  const status = taskStatusText();
  if (status) return `🛠️ On it — ${status}.\nThe answer will land in this chat when it's done.`;
  return '🛠️ On it — I\'ll post the result in this chat when it\'s done.';
}

// Progress ping: the same live status, prefixed with elapsed time.
function turnPingText(mins) {
  const status = taskStatusText();
  return status
    ? `⏳ ${mins} min in — ${status}.`
    : `⏳ Still working after ${mins} min.`;
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

// Turns "telegram:123456" thread ids (also works for group ids) into chat ids.
function extractChatId(line) {
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
  const allBlocked = rotation.nextCombo() === null;
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
  const chatId = extractChatId(line);
  if (!chatId) {
    log('[Turn] Message received, but no chat id found in the log line.');
    return;
  }

  // Slash commands (/new, /cwd, /tools, …) are handled instantly by the
  // connector — never treat them as heavy tasks.
  const preview = (line.match(/"textPreview":"((?:[^"\\]|\\.)*)"/) || [])[1] || '';
  if (preview.startsWith('/')) {
    log(`[Turn] Command "${preview}" received — handled instantly, no ack.`);
    return;
  }

  // Remember the user's message (decoded from JSON escapes) so the auto-resume
  // can continue the interrupted conversation when no task list exists. Only
  // overwrite when a preview is actually present — a line without one must not
  // erase the captured request.
  if (preview) {
    try {
      state.lastUserMessage = JSON.parse(`"${preview}"`);
    } catch (_) {
      state.lastUserMessage = preview;
    }
    // Persist immediately: a rotation that restarts the wrapper must still be
    // able to retry this message after the in-memory state is gone.
    lastmessage.save(chatId, state.lastUserMessage);
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
    lastmessage.clear();
  }
  if (!activeTurn) return;
  const mins = Math.round((Date.now() - activeTurn.startedAt) / 60000);
  log(`[Turn] Task ${ok ? 'completed' : 'failed'} after ~${mins} min (chat ${activeTurn.chatId}).`);
  stopTurn();
}

// Maps connector log messages to turn events.
function handleTurnEvent(line) {
  const msg = (line.match(/"msg":"([^"]+)"/) || [])[1] || '';

  if (msg === 'Telegram message received') { onTurnStarted(line); return; }
  if (msg === 'Telegram reply completed') { onTurnDone(true); return; }
  if (msg === 'Telegram reply failed' || msg === 'Telegram turn handling failed') {
    onTurnDone(false);   // the limit path logs the details
    return;
  }
  if (msg === 'Telegram thread started RPC session' || msg === 'Telegram thread reusing RPC session') {
    const sessionId = (line.match(/"sessionId":"([^"]+)"/) || [])[1] || '?';
    log(`[Turn] ${msg} (session ${sessionId})`);
  }
}

module.exports = {
  sendTelegramMessage,
  notifyUser,
  extractChatId,
  handleTurnEvent,
  onTurnDone,
  // Pure feedback builders — exported for tests.
  taskStatusText,
  turnAckText,
  turnPingText,
};
