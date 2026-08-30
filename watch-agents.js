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
const INTERVAL_MS = 60 * 1000;
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

function restartInstance(name) {
  // Skip instances that never booted here (no env file — nothing to relaunch
  // with); restart-agent.sh would abort anyway, but this avoids log spam.
  if (!fs.existsSync(path.join(DIR, `agents.env-${name}.json`))) {
    note(`instance ${name}: no agents.env-${name}.json; skipping (never booted here).`);
    return;
  }
  const r = spawnSync('bash', [RESTART, name, '--force'], { encoding: 'utf8', timeout: RESTART_TIMEOUT_MS });
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

const mode = process.argv[2] || 'loop';
if (mode === 'once') {
  const dead = checkOnce();
  process.exit(dead.length ? 0 : 0);   // check-only: never fail the cron
}

note(`watcher started (check every ${INTERVAL_MS / 1000}s).`);
checkOnce();
setInterval(checkOnce, INTERVAL_MS);