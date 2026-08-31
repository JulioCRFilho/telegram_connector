const fs = require('fs');
const config = require('./config');
const log = require('./log');

// Persists the last UNANSWERED user message per instance so the auto-resume
// can retry it after a rotation even when the wrapper itself was restarted —
// the in-memory state (state.lastUserMessage) dies with the process, and a
// rotation often IS a restart. The entry is cleared as soon as the message is
// answered (normal reply lands, or the auto-resume completes successfully),
// so a persisted record is always a genuinely unanswered request.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;   // safety cap: never resurrect messages older than a day

// ── Progress dossier ───────────────────────────────────────────────────────
// A fresh hub-resume session has NO conversation history — without extra
// context the model cannot know what was already done, and the pending task
// is effectively forgotten ("agent never remembers"). While a message is
// pending we therefore tail the connector's own stdout narration into a small
// in-memory ring buffer and persist it alongside the message, so the resume
// prompt can tell the fresh session exactly where the work left off.
const DOSSIER_MAX_LINES = 20;
const DOSSIER_LINE_MAX = 200;
const DOSSIER_FLUSH_MS = 2000;
const progressRing = [];
let dossierDirty = false;
let dossierTimer = null;

// Noisy/internal lines that carry no task context (keep the dossier lean).
const DOSSIER_SKIP_RE = /^\[(Rotator|Cooldown|Park|Resume|Interrupt|Probe|Health|Watch|Bridge)\]/;
// cline stdout lines are JSON log records — the raw line is unreadable garbage
// in a prompt, so extract the human message the same way the turn-event
// parser does, and drop pure bookkeeping events.
const DOSSIER_MSG_SKIP_RE = /Telegram (message received|reply completed|reply failed|turn handling failed)|thread (started|reusing) RPC|follow-?up/i;

function extractDossierText(line) {
  const s = String(line || '').trim();
  if (!s) return '';
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      const msg = obj && typeof obj.msg === 'string' ? obj.msg : '';
      return DOSSIER_MSG_SKIP_RE.test(msg) ? '' : msg;
    } catch (_) { return ''; }
  }
  return DOSSIER_MSG_SKIP_RE.test(s) ? '' : s;
}

function noteProgress(line) {
  const s = extractDossierText(line);
  if (!s || DOSSIER_SKIP_RE.test(s)) return;
  progressRing.push(s.length > DOSSIER_LINE_MAX ? s.slice(0, DOSSIER_LINE_MAX) + '…' : s);
  if (progressRing.length > DOSSIER_MAX_LINES) progressRing.shift();
  dossierDirty = true;
  if (!dossierTimer) {
    dossierTimer = setTimeout(() => {
      dossierTimer = null;
      if (!dossierDirty) return;
      dossierDirty = false;
      try {
        const rec = JSON.parse(fs.readFileSync(config.STATE_FILE, 'utf8'));
        rec.dossier = progressRing.slice();
        fs.writeFileSync(config.STATE_FILE, JSON.stringify(rec));
      } catch (_) { /* no pending record — nothing to attach to */ }
    }, DOSSIER_FLUSH_MS);
    dossierTimer.unref();
  }
}

function dossierSnapshot() {
  return progressRing.slice();
}

// Resets the ring and (optionally) seeds it — used when a NEW task becomes the
// pending one (a fresh task must never inherit the previous task's narration)
// and when a paused task is promoted back (its saved narration becomes the
// active ring again so further progress appends to it).
function resetDossier(seed) {
  progressRing.length = 0;
  if (Array.isArray(seed)) {
    for (const l of seed) {
      if (typeof l === 'string' && l) progressRing.push(l.slice(0, DOSSIER_LINE_MAX + 1));
    }
    while (progressRing.length > DOSSIER_MAX_LINES) progressRing.shift();
  }
  dossierDirty = false;
}

// ── Session topics from the cline log ──────────────────────────────────────
// The shared cline log records EVERY turn as JSON: "Telegram message received"
// (with textPreview) and reply records (with outputPreview), tagged with
// threadId "telegram:<chatId>". That is a durable transcript of the cut
// session on disk — the fresh hub session can be handed its recent topics
// instead of asking the user "what were we talking about?".
const TOPIC_TAIL_BYTES = 512 * 1024;   // read only the log's tail — topics are recent by definition
const TOPICS_MAX_USER = 5;
const TOPICS_MAX_REPLY = 2;
const TOPIC_PREVIEW_MAX = 200;

function collectSessionTopics(chatId) {
  const logFile = process.env.TELEGRAM_CLINE_LOG_FILE || config.SHARED_CLINE_LOG;
  const topics = [];
  if (!chatId || !logFile) return topics;
  let raw = '';
  try {
    const fd = fs.openSync(logFile, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TOPIC_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
  } catch (_) { return topics; }

  const threadTag = `"threadId":"telegram:${chatId}"`;
  for (const line of raw.split('\n')) {
    if (!line.includes(threadTag)) continue;
    let obj;
    try { obj = JSON.parse(line); } catch (_) { continue; }
    const msg = obj && obj.msg;
    let who = null, text = '';
    if (msg === 'Telegram message received' && obj.textPreview) {
      who = 'user';
      text = String(obj.textPreview);
    } else if (msg === 'Telegram reply completed' && obj.outputPreview) {
      who = 'you';
      text = String(obj.outputPreview);
    }
    if (!who || !text.trim()) continue;
    if (text.length > TOPIC_PREVIEW_MAX) text = text.slice(0, TOPIC_PREVIEW_MAX) + '…';
    // Dedupe consecutive identical previews (bridge double-logs some events).
    const prev = topics[topics.length - 1];
    if (prev && prev.who === who && prev.text === text) continue;
    topics.push({ who, text });
  }
  // Keep the LAST TOPICS_MAX_USER user turns and the LAST TOPICS_MAX_REPLY
  // replies (the tail of the conversation is what was in flight when cut).
  const users = topics.filter((t) => t.who === 'user').slice(-TOPICS_MAX_USER);
  const replies = topics.filter((t) => t.who === 'you').slice(-TOPICS_MAX_REPLY);
  return [...users, ...replies].map((t) => `${t.who === 'user' ? 'user said' : 'you replied'}: "${t.text}"`);
}

function save(chatId, text, dossier) {
  // A save WITHOUT an explicit dossier is a brand-new pending task: the ring
  // must start empty (otherwise the new task's resume would quote the
  // previous task's narration as its own progress). WITH a dossier (paused
  // task promotion) the saved narration is restored verbatim.
  resetDossier(dossier === undefined ? [] : dossier);
  try {
    fs.writeFileSync(config.STATE_FILE, JSON.stringify({ chatId, text, updatedAt: Date.now(), dossier: progressRing.slice() }));
  } catch (err) {
    log(`[Resume] Couldn't persist last user message: ${err.message}`);
  }
}

function clear() {
  try { fs.unlinkSync(config.STATE_FILE); } catch (_) { }
}

// Returns { chatId, text, updatedAt } or null. Entries older than MAX_AGE_MS
// are discarded (and removed) rather than retried.
function load() {
  try {
    const rec = JSON.parse(fs.readFileSync(config.STATE_FILE, 'utf8'));
    if (!rec || !rec.text) return null;
    if (Date.now() - (rec.updatedAt || 0) > MAX_AGE_MS) {
      log('[Resume] Discarding stale persisted user message (>24h old).');
      clear();
      return null;
    }
    return rec;
  } catch (_) {
    return null;
  }
}

module.exports = { save, clear, load, noteProgress, dossierSnapshot, resetDossier, collectSessionTopics };