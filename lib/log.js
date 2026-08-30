const fs = require('fs');
const config = require('./config');

// connector.log grows forever otherwise — rotate once (keep a single .1
// backup) past this size so the wrapper's own diagnostics can't balloon.
const MAX_LOG_BYTES = 5 * 1024 * 1024;

// All diagnostics go to connector.log AND stdout, so "no log" can't hide
// anything even when stdout is not redirected.
function log(...args) {
  const file = config.WRAPPER_LOG;
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  try {
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) {
        try { fs.renameSync(file, `${file}.1`); } catch (_) { }
      }
    } catch (_) { }
    fs.appendFileSync(file, line + '\n');
  } catch (_) { }
  console.log(line);
}

module.exports = log;