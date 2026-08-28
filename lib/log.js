const fs = require('fs');
const config = require('./config');

// All diagnostics go to connector.log AND stdout, so "no log" can't hide
// anything even when stdout is not redirected.
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  try {
    fs.appendFileSync(config.WRAPPER_LOG, line + '\n');
  } catch (_) { }
  console.log(line);
}

module.exports = log;