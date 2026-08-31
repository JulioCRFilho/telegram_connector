#!/usr/bin/env node
// watch-agents.js — auto-heal for wrapper instances.
// AGENTS.md mandates keeping EVOL/FSCENE/MANAGER online; this implements that
// without manual poking. Every INTERVAL_MS it reads agents.pids.json and checks
// each registered instance: if the wrapper pid is dead OR no longer runs
// `node main.js <NAME>`, it relaunches via `restart-agent.sh <NAME> --force`
// (which restores the environment from agents.env-<NAME>.json — the wrapper
// writes that file at every boot).
//
//   node watch-agents.js once      single check (cron-friendly), exit code 0/1
//   node watch-agents.js           loop forever (the watcher daemon)
//
// Beyond the 1-minute liveness pass, a HEALTH check runs every 10 minutes and
// catches the two failure modes liveness cannot see: a wrapper alive whose
// connector child died (no `cline connect telegram` child), and a stalled
// turn — the log keeps printing "Still working after N min" but no completion
// ever lands (observed live with EVOL, 2026-08-30: 18 min without a reply).
// Stalled/degraded instances get a GRACEFUL restart (SIGTERM first, unlike the
// forced relaunch used for dead pids) so the rotator can stop cleanly.
//
// A cross-process lock (agents.watch.lock, O_EXCL + stale-steal like
// procs.js) keeps concurrent watchers/cron and manual restarts from double-
// launching. Logs to restart-schedule.log.
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const PIDS_FILE = path.join(DIR, 'agents.pids.json');
const LOCK_FILE = path.join(DIR, 'agents.watch.lock');
const LOG_FILE = path.join(DIR, 'restart-schedule.log');
const RESTART = path.join(DIR, 'restart-agent.sh');
const INTERVAL_MS = 60 * 1000;          // liveness pass (dead pid → relaunch)
const HEALTH_INTERVAL_MS = 10 * 60 * 1000; // deep health pass (stall detection)
// A turn "in flight" this long is considered stalled. DELIBERATELY high: a
// restart mid-task throws away ALL tokens the task already spent (the auto-
// resume re-runs it from scratch in a fresh session), so killing a merely
// LONG task re-burns its whole cost every cycle — the token treadmill. 90 min
// still catches true hangs while leaving real long-running work alone.
const STALLED_TURN_MIN = 90;
const STALE_LOG_MIN = 10;               // no log line newer than this = hung
const STALE_LOCK_MS = 60 * 1000;
const RESTART_TIMEOUT_MS = 90 * 1000;   // graceful stop waits up to ~30s inside restart-agent.sh

function stamp() { return new Date().toISOString(); }

function note(msg) {
  const line = `${stamp()} [watch] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) { }
  console.log(line);
}

// Alive AND still a wrapper for this project (guards against pid recycling).
function pidAlive(pid) {
  try { process.kill(pid, 0); } catch (_) { return false; }
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    return cmd.includes('main.js');
  } catch (_) {
    return false;
  }
}

function restartInstance(name, graceful = false) {
  // Skip instances that never booted here (no env file — nothing to relaunch
  // with); restart-agent.sh would abort anyway, but this avoids log spam.
  if (!fs.existsSync(path.join(DIR, `agents.env-${name}.json`))) {
    note(`instance ${name}: no agents.env-${name}.json; skipping (never booted here).`);
    return;
  }
  const args = graceful ? [RESTART, name] : [RESTART, name, '--force'];
  const r = spawnSync('bash', args, { encoding: 'utf8', timeout: RESTART_TIMEOUT_MS });
  if (r.status === 0) {
    note(`restarted ${name}: ${(r.stdout || '').trim() || 'ok'}`);
  } else {
    note(`restart FAILED for ${name}: ${(r.stderr || '').trim() || (r.stdout || '').trim() || `exit ${r.status}`}`);
  }
}

function acquireLock() {
  try {
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') return true;      // weird fs error — proceed rather than block healing
    try {
      if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > STALE_LOCK_MS) {
        fs.unlinkSync(LOCK_FILE);                 // previous watcher crashed mid-cycle
        return acquireLock();
      }
    } catch (_) { }
    return false;
  }
}
function releaseLock() { try { fs.unlinkSync(LOCK_FILE); } catch (_) { } }

function checkOnce() {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(PIDS_FILE, 'utf8')); } catch (_) { return []; }
  const dead = Object.entries(data)
    .filter(([, e]) => e && e.wrapperPid)
    .map(([name, e]) => ({ name, pid: e.wrapperPid }))
    .filter((x) => !pidAlive(x.pid));
  if (dead.length === 0) return [];
  if (!acquireLock()) {
    note('another watcher/manual restart is running; skipping this cycle.');
    return dead;
  }
  try {
    for (const x of dead) {
      note(`wrapper ${x.name} (pid ${x.pid}) is dead; relaunching.`);
      restartInstance(x.name);
    }
  } finally {
    releaseLock();
  }
  return dead;
}

// --- health check (every HEALTH_INTERVAL_MS) --------------------------------
// Catches degraded-but-alive instances the liveness pass cannot see:
//   1. wrapper pid alive but its connector child is gone;
//   2. a turn stuck in flight — the wrapper log's "Still working after N min"
//      counter keeps climbing (or the log went quiet mid-turn) with no
//      "Task completed|failed" ever landing.

// Read only the last `bytes` of a (potentially huge) wrapper log.
function tailFile(file, bytes = 16 * 1024) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - bytes);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (_) { return ''; }
}

// Minutes the in-flight turn has been running, or 0 if no turn is stuck.
// `nowMs` is injectable for tests. A turn counts as in-flight while the most
// recent turn signal is a "Still working after N min" line; any "Task
// completed/failed" after it clears the state. The effective age is the
// counter N — or the wall-clock age of the line itself if the wrapper hung
// and stopped logging (whichever is larger).
function stalledTurnMinutes(tail, nowMs = Date.now()) {
  let inFlight = null; // { minutes, lineMs }
  for (const line of tail.split('\n')) {
    const m = line.match(/Still working after (\d+) min/);
    if (m) {
      const t = line.match(/\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/);
      inFlight = { minutes: parseInt(m[1], 10), lineMs: t ? Date.parse(t[1]) : NaN };
    } else if (/\[Turn\] Task (completed|failed)/.test(line)) {
      inFlight = null;
    }
  }
  if (!inFlight) return 0;
  const wallClockMin = Number.isFinite(inFlight.lineMs)
    ? Math.floor((nowMs - inFlight.lineMs) / 60000)
    : 0;
  return Math.max(inFlight.minutes, wallClockMin);
}

// Direct child (`cline connect telegram`) still alive under the wrapper pid?
function hasConnectorChild(pid) {
  const r = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  return r.status === 0 && (r.stdout || '').trim().length > 0;
}

// Parked wrappers (every key×model combo on cooldown) run WITHOUT a connector
// by design — the wrapper polls Telegram itself until the grid frees up. The
// wrapper advertises this via `parkedUntil` (procs.markParked) in the pid
// registry; a parked instance is healthy, never restart-worthy. The grace
// window covers the wake race: at wake the flag clears just before the
// connector spawns, so a health pass landing in between must not kill it.
const PARK_GRACE_MS = 90 * 1000;
function isParkedEntry(entry, nowMs = Date.now()) {
  return Boolean(entry && entry.parkedUntil && entry.parkedUntil > nowMs - PARK_GRACE_MS);
}

function healthCheckOnce() {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(PIDS_FILE, 'utf8')); } catch (_) { return []; }
  const instances = Object.entries(data)
    .filter(([, e]) => e && e.wrapperPid && pidAlive(e.wrapperPid) && !isParkedEntry(e))
    .map(([name, e]) => ({ name, pid: e.wrapperPid }));
  const unhealthy = [];
  for (const x of instances) {
    if (!hasConnectorChild(x.pid)) {
      note(`health check: ${x.name} (pid ${x.pid}) has no connector child; restarting.`);
      unhealthy.push(x);
      continue;
    }
    const stalled = stalledTurnMinutes(tailFile(path.join(DIR, `wrapper-${x.name}.out`)));
    if (stalled >= STALLED_TURN_MIN) {
      note(`health check: ${x.name} (pid ${x.pid}) turn stalled for ${stalled} min; restarting.`);
      unhealthy.push(x);
    }
  }
  if (unhealthy.length === 0) return [];
  if (!acquireLock()) {
    note('another watcher/manual restart is running; skipping health cycle.');
    return unhealthy;
  }
  try {
    for (const x of unhealthy) restartInstance(x.name, true); // graceful: SIGTERM first
  } finally {
    releaseLock();
  }
  return unhealthy;
}

// Daemon entry point — only when run directly (require.main guard lets the
// regression test import the health helpers without starting intervals).
if (require.main === module) {
  const mode = process.argv[2] || 'loop';
  if (mode === 'once') {
    const dead = checkOnce();
    process.exit(dead.length ? 0 : 0);   // check-only: never fail the cron
  }

  note(`watcher started (liveness every ${INTERVAL_MS / 1000}s, health every ${HEALTH_INTERVAL_MS / 60000}min).`);
  checkOnce();
  setInterval(checkOnce, INTERVAL_MS);
  setTimeout(() => healthCheckOnce(), 60 * 1000);
  setInterval(healthCheckOnce, HEALTH_INTERVAL_MS);
}

module.exports = { tailFile, stalledTurnMinutes, isParkedEntry, PARK_GRACE_MS, STALLED_TURN_MIN, HEALTH_INTERVAL_MS };