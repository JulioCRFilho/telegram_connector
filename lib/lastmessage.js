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

function save(chatId, text) {
  try {
    fs.writeFileSync(config.STATE_FILE, JSON.stringify({ chatId, text, updatedAt: Date.now() }));
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

module.exports = { save, clear, load };