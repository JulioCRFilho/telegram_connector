const config = require('./config');
const log = require('./log');
const state = require('./state');
const tasks = require('./tasks');
const rotation = require('./rotation');
const lastmessage = require('./lastmessage');
const interrupted = require('./interrupted');

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
// Health-check feedback — every 10 min of working the user gets an explicit
// "still alive and on it" line (distinct from the progress ping, which only
// fires when the task-list count advanced). Override for tests with
// TELEGRAM_HEALTH_INTERVAL_MS.
const TURN_HEALTH_INTERVAL_MS = parseInt(process.env.TELEGRAM_HEALTH_INTERVAL_MS, 10) || 10 * 60 * 1000;

let activeTurn = null;                       // { chatId, startedAt, pings, timer }
let pendingAck = null;                       // { chatId, timer } — ack not yet sent
let lastAckAt = 0;
let resetHandler = null;                     // set by supervisor (avoids circular require)
let healthProvider = null;                   // set by supervisor: () => ({ alive })

// Liveness provider for the 10-min health-check feedback — supervisor
// registers this so chat can report connector status without requiring it.
function setHealthProvider(fn) {
  healthProvider = typeof fn === 'function' ? fn : null;
}

// /reset wiring: supervisor registers the grid-clearing + park-wake logic here
// so the chat command stays a thin dispatcher.
function setResetHandler(fn) {
  resetHandler = typeof fn === 'function' ? fn : null;
}

// Runs the registered /reset handler and builds the user-facing confirmation.
function handleResetCommand() {
  if (!resetHandler) return 'Reset is not available yet — try again in a moment.';
  const cleared = resetHandler();
  return `♻️ Cleared ${cleared} cooldown record(s) — all ${config.API_KEYS.length} key(s) × ${config.MODELS.length} model(s) are marked available again. Picking a fresh combo now…`;
}

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
  // The "on:" claim is only trustworthy when the file actually LOOKS like the
  // agent's task list (tasks/todo/tasklist/…). A random doc that merely
  // contains checkboxes (e.g. an old analysis write-up) gets the counts but
  // NOT a fabricated current item — and its basename is shown so the user can
  // tell where the number came from.
  if (p.basename && !tasks.isTaskListName(p.basename)) {
    return `📋 ${p.done}/${p.total} tasks done (${pct}%) (${p.basename})`;
  }
  if (!active) return `📋 ${p.done}/${p.total} tasks done (${pct}%)`;
  return `📋 ${p.done}/${p.total} tasks done (${pct}%) — on: “${active}”`;
}

// Acknowledgement sent when a task is clearly long-running. Event-driven UX:
// ONE short human line — no key/model, no cooldown grid, no % preview. All
// the internal detail lives in the explicit /status command instead.
function turnAckText() {
  return 'Got it — working on it now. I\'ll send the result here as soon as it\'s done.';
}

// Progress update — sent ONLY when the task-list completion count actually
// ADVANCED since the last message (never repeats the same state). No elapsed
// time, no key/model, no item preview — just what changed.
function turnPingText(done, total) {
  return `Quick update: ${done} of ${total} tasks done.`;
}

// Health-check feedback — every TURN_HEALTH_INTERVAL_MS of working. Unlike the
// progress ping this fires on the clock, not on task-list changes, so a task
// with no checkbox movement still proves liveness to the user every 10 min.
function healthFeedbackText(mins, done, total, alive) {
  const progress = (done >= 0 && total > 0) ? ` (${done}/${total} tasks done)` : '';
  const status = alive ? 'connector alive' : 'reconnecting in the background';
  return `🩺 Health check — ${mins} min in, still on it${progress}. ${status}.`;
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
      state.resumeProviderRetries = 0;
      state.resumeParkRetries = 0;
      lastmessage.save(chatId, text);
      log(`[Park] User message queued (chat ${chatId}): "${text.slice(0, 80)}"`);
      sendTelegramMessage(chatId, `Got it — you're queued behind the current rate limit (frees up ~${when} UTC). I'll start on this automatically and send the result here.`);
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
  if (activeTurn && activeTurn.healthTimer) clearInterval(activeTurn.healthTimer);
  activeTurn = null;
  cancelPendingAck();
}

// Actually starts tracking a turn: sends a ONE-LINE acknowledgement, then only
// messages on real CHANGES. Every ping tick logs a wrapper heartbeat
// (`[Turn] Still working after N min`) so the health watcher can still detect
// a stalled turn — but the chat only gets an update when the task-list
// completion count actually advanced since the last one. No progress at all →
// no chat message (the connector's reply itself is the "done" signal).
function startTurn(chatId) {
  stopTurn();
  const initial = tasks.getTaskProgress();
  activeTurn = {
    chatId,
    startedAt: Date.now(),
    pings: 0,
    lastDone: initial ? initial.done : -1,
    timer: null,
  };
  const tick = () => {
    if (!activeTurn) return;
    const mins = Math.round((Date.now() - activeTurn.startedAt) / 60000);
    // Log-only heartbeat — feeds the watcher's stall detection; never spam.
    log(`[Turn] Still working after ${mins} min (chat ${activeTurn.chatId}).`);
    const p = tasks.getTaskProgress();
    if (!p || p.done <= activeTurn.lastDone) return;   // nothing changed → silent
    if (activeTurn.pings >= TURN_MAX_PINGS) return;    // cap reached; stay silent
    activeTurn.pings++;
    activeTurn.lastDone = p.done;
    sendTelegramMessage(activeTurn.chatId, turnPingText(p.done, p.total));
  };
  activeTurn.tick = tick;
  activeTurn.timer = setInterval(tick, TURN_PING_INTERVAL_MS);

  // Health-check feedback: an explicit "alive and working" line to the user
  // every 10 min of working, independent of task-list movement. Liveness comes
  // from the provider supervisor registers (setHealthProvider) — chat itself
  // never requires supervisor (circular dependency).
  const healthTick = () => {
    if (!activeTurn) return;
    const mins = Math.round((Date.now() - activeTurn.startedAt) / 60000);
    const p = tasks.getTaskProgress();
    const alive = healthProvider ? !!healthProvider().alive : true;
    log(`[Turn] Health check after ${mins} min (chat ${activeTurn.chatId}, connector ${alive ? 'alive' : 'restarting'}).`);
    sendTelegramMessage(activeTurn.chatId, healthFeedbackText(mins, p ? p.done : -1, p ? p.total : 0, alive));
  };
  activeTurn.healthTick = healthTick;
  activeTurn.healthTimer = setInterval(healthTick, TURN_HEALTH_INTERVAL_MS);

  // Ack — one short human line; when the queue is full say that plainly
  // (rate limits are the one thing worth telling the user up front).
  const allBlocked = rotation.pickNextCombo().waitMs > 0;
  const now = Date.now();
  if (now - lastAckAt < TURN_ACK_THROTTLE_MS) return;   // burst guard
  lastAckAt = now;
  log(`[Turn] Acknowledging chat ${chatId}${allBlocked ? ' (quota exhausted notice)' : ''}.`);
  sendTelegramMessage(chatId, allBlocked
    ? `⚠️ The AI provider is rate-limited right now (frees up ~${new Date(rotation.earliestUnblock()).toISOString().slice(11, 16)} UTC). Your request is queued — I'll start automatically as soon as capacity is back.`
    : turnAckText());
}

function cancelPendingAck() {
  if (pendingAck && pendingAck.timer) clearTimeout(pendingAck.timer);
  pendingAck = null;
}

// ── Mid-task interruption ──────────────────────────────────────────────────
// A new user message while the agent is working used to be IGNORED until the
// running task finished — and worse, onTurnDone then CLEARED it, silently
// losing the request. Now the running task is PAUSED (persisted to
// lib/interrupted.js, never lost), the connector restarts so the new message
// is answered first, and the paused task is re-queued automatically right
// after that answer lands.
// ────────────────────────────────────────────────────────────────────────────

// Indirection so tests can intercept the connector restart (the real trigger
// restarts on the CURRENT combo; rotation-free — the key/model didn't fail).
let restartTrigger = (chatId) => {
  const supervisor = require('./supervisor');
  state.restartFromRotation = true;
  supervisor.queueResume();
  supervisor.scheduleRestart(state.curKeyIndex, state.curModelIndex, config.RESTART_DELAY_MS);
};

function triggerRestartForInterrupt(chatId) {
  if (state.shuttingDown || state.restarting || state.startPending) {
    log('[Interrupt] Restart already in flight; the queued resume will pick the work up.');
    return false;
  }
  try {
    restartTrigger(chatId);
    return true;
  } catch (err) {
    log(`[Interrupt] Restart trigger failed: ${err.message}`);
    return false;
  }
}

// Called from onTurnStarted when a message lands for a chat that already has
// an active turn. Stashes the in-flight request and restarts the connector so
// the new message is answered first. Returns true when an interruption
// happened (identical text = user re-sending, not an interruption → false).
function pauseCurrentForNewMessage(chatId, newText) {
  const current = state.lastUserMessage;
  if (!current || current === newText) {
    log('[Interrupt] Follow-up is not a new task; keeping the current run.');
    return false;
  }
  // Capture the paused task's progress narration NOW (before the new message's
  // save resets the ring) — the promotion resume depends on it for context.
  const dossier = lastmessage.dossierSnapshot();
  const queued = interrupted.push(chatId, current, dossier);
  log(`[Interrupt] Pausing current task (${queued} paused, ${dossier.length} dossier line(s)): "${String(current).slice(0, 80)}"`);
  sendTelegramMessage(chatId,
    `Heads up — I've paused what I was on to handle your new message first. The earlier task is saved and I'll pick it back up right after.`
    + (queued > 1 ? ` (${queued - 1} earlier paused task(s) still queued.)` : ''));
  triggerRestartForInterrupt(chatId);
  return true;
}

// Called when a turn completes OK (and after a successful auto-resume): if a
// paused task is waiting, promote the oldest one back to the pending request
// and restart so the agent continues it. Returns true when a paused task was
// re-queued.
function resumeNextInterrupted() {
  if (state.shuttingDown) return false;
  if (state.pendingResume) {
    log('[Interrupt] A resume is already queued; paused task stays pending until it finishes.');
    return false;
  }
  const rec = interrupted.pop();
  if (!rec) return false;
  log(`[Interrupt] Resuming paused task: "${String(rec.text).slice(0, 80)}" (${(rec.dossier || []).length} dossier line(s) restored)`);
  state.lastUserMessage = rec.text;
  state.resumeAttempts = 0;
  state.resumeProviderRetries = 0;   // promoted task gets a fresh retry budget
  state.resumeParkRetries = 0;
  // Restore the paused task's narration as the pending record's dossier so the
  // fresh hub session knows where the interrupted run left off.
  // `front: true` — the paused task arrived BEFORE anything queued after it,
  // so it must become the FIFO head again, not re-queue at the back.
  lastmessage.save(rec.chatId, rec.text, rec.dossier || [], { front: true });
  sendTelegramMessage(rec.chatId,
    `Done with your latest request — picking the earlier task back up now: "${String(rec.text).slice(0, 300)}"`);
  triggerRestartForInterrupt(rec.chatId);
  return true;
}

// FIFO promotion: the answered message has just been removed from the pending
// store — if more messages are queued behind it, the OLDEST one becomes the
// active pending task and the connector is (re)started so it gets delivered.
// Returns true when a queued message was promoted. Only paused-interrupted
// tasks (a separate store) are handled by resumeNextInterrupted.
function promoteNextPending() {
  if (state.shuttingDown || state.pendingResume) return false;
  const next = lastmessage.load();
  if (!next) return false;
  if (state.lastUserMessage && state.lastUserMessage === next.text) return false; // already the active task
  state.lastUserMessage = next.text;
  state.resumeAttempts = 0;
  state.resumeProviderRetries = 0;   // promoted message gets a fresh retry budget
  state.resumeParkRetries = 0;
  lastmessage.resetDossier(next.dossier || []);
  log(`[Queue] Promoting next pending message: "${String(next.text).slice(0, 80)}" (${lastmessage.count() - 1} more behind it)`);
  triggerRestartForInterrupt(next.chatId);
  return true;
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
    // /reset (aliases: /resetkeys, /resetcooldowns, /resetgrid) — zero every
    // key×model cooldown so all combos are available again. Handler lives in
    // supervisor (registered via setResetHandler) because it may also wake a
    // parked wrapper. Confirmation includes the cleared count.
    if (/^\/(reset|resetkeys|resetcooldowns|resetgrid)(\s|$)/i.test(preview)) {
      const reply = handleResetCommand();
      sendTelegramMessage(chatId, reply);
      log(`[Turn] Command "${preview}" → reset the cooldown grid, no ack.`);
      return;
    }
    log(`[Turn] Command "${preview}" received — handled instantly, no ack.`);
    return;
  }

  // Remember the user's message (decoded from JSON escapes) so the auto-resume
  // can continue the interrupted conversation when no task list exists. Only
  // overwrite when a preview is actually present — a line without one must not
  // erase the captured request.
  // Capture the IN-FLIGHT task first: the preview block below overwrites
  // lastUserMessage with the new request, and the follow-up branch needs the
  // previous one to pause it.
  const inFlightTask = state.lastUserMessage;
  if (preview) {
    // The parsed object already holds plain text; only the regex fallback
    // needs the JSON-string unescape wrapper.
    let decoded = preview;
    if (!obj) {
      try { decoded = JSON.parse(`"${preview}"`); } catch (_) { decoded = preview; }
    }
    state.lastUserMessage = decoded;
    state.resumeAttempts = 0;               // fresh user request: resume retry budget restarts
    state.resumeParkRetries = 0;
    // Persist immediately: a rotation that restarts the wrapper must still be
    // able to retry this message after the in-memory state is gone.
    lastmessage.save(chatId, decoded);
  }

  // Another message from the same chat while we're already working: interrupt
  // the running task — pause it (persisted, resumable) and restart the
  // connector so the NEW message is answered first. Identical text (a re-send
  // / impatient nudge) just resets the elapsed clock like before.
  if (activeTurn && activeTurn.chatId === chatId) {
    activeTurn.startedAt = Date.now();
    activeTurn.pings = 0;
    const cp = tasks.getTaskProgress();
    activeTurn.lastDone = cp ? cp.done : -1;   // avoid echoing stale progress after a nudge
    if (preview) pauseCurrentForNewMessage(chatId, inFlightTask);
    else log('[Turn] Follow-up message received; still working.');
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
    // The user's message has been answered — remove ONLY that one from the
    // pending store so a later rotation doesn't retry an already-answered
    // request. Messages queued BEHIND it must survive (lossless FIFO): the
    // old whole-queue clear() is what erased the chest task when the user
    // sent "progress?" while the real task was pending.
    // A failed turn keeps the message: the auto-resume must retry exactly
    // this message after rotating.
    const answered = state.lastUserMessage;
    state.lastUserMessage = null;
    state.resumeAttempts = 0;
    state.resumeProviderRetries = 0;   // the pending message is answered — fresh budget for the next one
    state.resumeParkRetries = 0;
    if (answered) {
      lastmessage.clearOne(activeTurn ? activeTurn.chatId : (state.lastSeenChatId || config.ALLOWED_USER_ID), answered);
    }
  }
  if (!activeTurn) return;
  const mins = Math.round((Date.now() - activeTurn.startedAt) / 60000);
  log(`[Turn] Task ${ok ? 'completed' : 'failed'} after ~${mins} min (chat ${activeTurn.chatId}).`);
  stopTurn();
  // The newer request has been answered — first deliver whatever is queued in
  // the pending FIFO, then continue the oldest paused (interrupted) task, if
  // any. (A failed turn keeps the just-failed message pending via the normal
  // resume machinery; piling new work on top would muddle the retry.)
  if (ok && !(promoteNextPending())) resumeNextInterrupted();
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
  pauseCurrentForNewMessage,
  resumeNextInterrupted,
  promoteNextPending,
  setHealthProvider,
  // Pure feedback builders — exported for tests.
  taskStatusText,
  turnAckText,
  turnPingText,
  healthFeedbackText,
  statusText,
  isTurnActive() { return !!activeTurn; },
  setResetHandler,
  handleResetCommand,
  _test: {
    startTurn,
    stopTurn,
    pingTick() { if (activeTurn) activeTurn.tick(); },
    healthTick() { if (activeTurn) activeTurn.healthTick(); },
    hasHealthTimer() { return !!(activeTurn && activeTurn.healthTimer); },
    setRestartTrigger(fn) { restartTrigger = fn; },
  },
};
