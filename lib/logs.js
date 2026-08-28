const fs = require('fs');
const path = require('path');
const config = require('./config');
const procs = require('./procs');
const chat = require('./chat');
const supervisor = require('./supervisor');

// ── Log tailing + polling ───────────────────────────────────────────────────
// Watches the files the `-i` connector writes and turns log lines into events:
// rate-limit signals ( → rotation) and turn lifecycle events ( → acks/pings).
// ─────────────────────────────────────────────────────────────────────────────

// Keeps the last-read byte offset per file.
const tailState = new Map();

// Tails a single file, calling onLine for every newly-appended complete line.
// Handles truncation/rotation by resetting the offset back to 0.
function tailLog(file, onLine) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch (_) {
    return;                            // file not there yet — try again next tick
  }
  const prev = tailState.get(file);
  if (prev === undefined) {
    tailState.set(file, size);         // first sight: don't react to old content
    return;
  }
  if (size < prev) {
    tailState.set(file, size);         // file was truncated/rotated
    return;
  }
  if (size === prev) return;

  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size - prev);
  fs.readSync(fd, buf, 0, buf.length, prev);
  fs.closeSync(fd);
  tailState.set(file, size);

  for (const line of buf.toString('utf8').split('\n')) {
    if (line.trim()) onLine(line);
  }
}

// Polls the connector's own logs. The shared cline.log carries the
// telegram-connect bridge errors (most reliable signal); the per-bot log is a
// secondary source. Both are filtered by isOurBot() so multiple duplicated
// instances don't cross-react to each other's log entries.
function pollLogs() {
  tailLog(config.SHARED_CLINE_LOG, (line) => {
    if (!config.IS_TELEGRAM_RE.test(line)) return;
    if (!procs.isOurBot(line)) return;
    if (config.LIMIT_RE.test(line)) {
      // This line is the failed turn itself: end the turn (stops progress
      // pings) before the rotation path takes over.
      chat.onTurnDone(false);
      supervisor.onLimitSignal(line);
      return;
    }
    chat.handleTurnEvent(line);
  });

  let botLogs = [];
  try {
    botLogs = fs.readdirSync(config.TELEGRAM_LOG_DIR)
      .filter((f) => f.endsWith('.log'))
      .map((f) => path.join(config.TELEGRAM_LOG_DIR, f));
  } catch (_) { }
  for (const file of botLogs) {
    tailLog(file, (line) => {
      if (config.LIMIT_RE.test(line) && procs.isOurBot(line)) supervisor.onLimitSignal(line);
    });
  }
}

module.exports = { pollLogs, tailLog };