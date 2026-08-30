// test.watch-park.js
// Regression test for the park↔restart freeze loop (2026-08-30): the health
// watcher's "no connector child" check restarted PARKED wrappers every 10
// minutes — parked wrappers have no connector BY DESIGN (the wrapper polls
// Telegram itself while every key×model combo is on cooldown), so the agents
// reboot-looped and never sat out their cooldown. The wrapper now advertises
// `parkedUntil` in the pid registry (procs.markParked) and the watcher skips
// parked instances (watch-agents.isParkedEntry).
// Run:  node test.watch-park.js
const TEST_PROJECT = 'PARKTEST';
process.argv.push(TEST_PROJECT);
process.env.TELEGRAM_BOT_TOKEN = '123456789:TEST';
process.env[`TELEGRAM_BOT_TOKEN_${TEST_PROJECT}`] = '123456789:TEST';
process.env.TELEGRAM_API_KEYS = 'sk-park-a';
process.env.TELEGRAM_AVAILABLE_MODELS = 'z-ai/glm-5.3-flash';
process.env.TELEGRAM_RESTART_DELAY_MS = '30';
process.env.TELEGRAM_PROBE_HTTP = '1';
process.env.TELEGRAM_API_BASE = 'https://mock-provider.test';
process.env.TELEGRAM_TASKS_DIR = require('os').tmpdir();
process.env.TELEGRAM_ALLOWED_USER_ID = '123456789';
process.env.PATH = '';
const os = require('os');
const fs = require('fs');
const path = require('path');
const tmpPids = path.join(os.tmpdir(), `pids-${TEST_PROJECT}-${process.pid}.json`);
const tmpCooldowns = path.join(os.tmpdir(), `cooldowns-${TEST_PROJECT}-${process.pid}.json`);
process.env.TELEGRAM_PIDS_FILE = tmpPids;
process.env.TELEGRAM_COOLDOWNS_FILE = tmpCooldowns;

const m = require('./main.js');
const procs = require('./lib/procs');   // same configured instance (shared module cache)
const watcher = require('./watch-agents.js');

let pass = 0, fail = 0;
function t(cond, name) {
  if (cond) { pass++; process.stdout.write(`  ok - ${name}\n`); }
  else { fail++; process.stdout.write(`  FAIL - ${name}\n`); }
}

(async () => {
  fs.rmSync(tmpPids, { force: true });
  fs.rmSync(tmpCooldowns, { force: true });

  // Register the instance, then park it (as supervisor.startParkMonitor does).
  procs.writePidEntry();
  procs.markParked(Date.now() + 60 * 60 * 1000);
  let entry = procs.readPidFile()[TEST_PROJECT];
  t(entry && entry.parkedUntil > Date.now(), 'markParked(future) writes parkedUntil into the registry');

  // The watcher must treat a parked instance as healthy.
  t(watcher.isParkedEntry(entry) === true, 'isParkedEntry: parked instance is recognized');
  t(watcher.isParkedEntry({ wrapperPid: 1 }) === false, 'isParkedEntry: missing flag = not parked');
  t(watcher.isParkedEntry({ wrapperPid: 1, parkedUntil: Date.now() - 10 * 1000 }) === true,
    'isParkedEntry: just-expired park is still within the wake grace window');
  t(watcher.isParkedEntry({ wrapperPid: 1, parkedUntil: Date.now() - 5 * 60 * 1000 }) === false,
    'isParkedEntry: long-expired park is NOT parked (real degradation possible)');

  // Waking up (connector starting) clears the flag.
  procs.markParked(0);
  entry = procs.readPidFile()[TEST_PROJECT];
  t(entry && entry.parkedUntil === undefined, 'markParked(0) clears the flag (connector starting again)');
  t(watcher.isParkedEntry(entry) === false, 'cleared entry is no longer parked');

  const line = `${pass} passed, ${fail} failed`;
  process.stdout.write(`\n${'.'.repeat(line.length)}\n${line}\n${'.'.repeat(line.length)}\n`);
  fs.rmSync(tmpPids, { force: true });
  fs.rmSync(tmpCooldowns, { force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
