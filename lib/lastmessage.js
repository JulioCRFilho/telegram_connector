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

function noteProgress(line) {
  const s = String(line || '').trim();
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

function save(chatId, text) {
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

module.exports = { save, clear, load, noteProgress, dossierSnapshot };