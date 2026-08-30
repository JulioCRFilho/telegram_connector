const { execFileSync } = require('child_process');
const fs = require('fs');
const config = require('./config');
const log = require('./log');
const state = require('./state');

// ── Process-tree attribution ────────────────────────────────────────────────
// The `cline` launcher is a Node shim that spawns the real connector binary as
// a child — and it is the REAL binary that writes cline.log. Log lines
// therefore carry the grandchild's pid, never the shim's pid we get back from
// spawn(). Comparing log pids against currentClinePid alone would reject EVERY
// line, so we resolve the whole descendant tree (pgrep -P, walked recursively)
// and match against that set. Results are cached briefly: resolving runs on
// every telegram-connect line lacking a botUserId, and pollLogs fires once per
// second.
const DESCENDANT_CACHE_TTL_MS = 10 * 1000;
let descendantCache = { rootPid: null, pids: new Set(), at: 0 };

// Retired-pid memo (state.knownPids) bounds. A dying connector's final log
// line is only ever relevant around its own shutdown, so pids older than an
// hour — or a set grown past this cap — are pruned instead of accumulating
// forever across hundreds of restarts/rotations.
const KNOWN_PIDS_MAX = 512;
const KNOWN_PIDS_MAX_AGE_MS = 60 * 60 * 1000;

function collectDescendants(rootPid) {
  const now = Date.now();
  if (descendantCache.rootPid === rootPid && now - descendantCache.at < DESCENDANT_CACHE_TTL_MS) {
    return descendantCache.pids;
  }
  const pids = new Set();
  const walk = (pid) => {
    let out = '';
    try {
      out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
    } catch (_) {
      return;                          // no children (or pgrep missing) — leaf
    }
    for (const raw of out.split('\n')) {
      const childPid = parseInt(raw, 10);
      if (childPid && !pids.has(childPid)) {
        pids.add(childPid);
        walk(childPid);
      }
    }
  };
  walk(rootPid);
  descendantCache = { rootPid, pids, at: now };
  return pids;
}

// Every pid that can legitimately appear on a log line written by one of OUR
// connector processes: the live child, its descendants, and recently retired
// ones. Descendants seen while alive are folded into knownPids so their final
// log lines still match after they exit.
function ourProcessPids() {
  // Prune retired pids once the memo gets big (or entries age out): a final
  // log line from hours-old restarts is never relevant, and an unbounded set
  // slows every log-line attribution check.
  if (state.knownPids.size > KNOWN_PIDS_MAX) {
    const now = Date.now();
    for (const [pid, at] of state.knownPids) {
      if (now - at > KNOWN_PIDS_MAX_AGE_MS) state.knownPids.delete(pid);
    }
  }
  const pids = new Set(state.knownPids.keys());
  if (state.currentClinePid !== null) {
    pids.add(state.currentClinePid);
    for (const pid of collectDescendants(state.currentClinePid)) {
      pids.add(pid);
      state.knownPids.set(pid, Date.now());
    }
  }
  return pids;
}

// Filter: is this log line from OUR bot? Uses botUserId where available, then
// falls back to the process tree of our child. This prevents cross-talk
// between duplicated instances that share the same ~/.cline/data/logs/cline.log.
// When the pid is neither ours nor in our tree, we check whether it's a STALE
// connector still running our bot token (orphan from a crashed wrapper). Those
// errors are ours to act on — otherwise a stale connector hits a limit, reports
// it under its own pid, and the wrapper that owns the bot never rotates.
function isOurBot(line) {
  const m = line.match(config.BOT_USER_ID_RE);
  if (m) return m[1] === config.BOT_USER_ID;
  const pidMatch = line.match(config.PID_RE);
  if (pidMatch) {
    const pid = parseInt(pidMatch[1], 10);
    if (pid === state.currentClinePid) return true;
    if (ourProcessPids().has(pid)) return true;
    // Not our process — check if it's a stale connector running our bot token.
    try {
      const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
      if (cmd.includes('connect telegram') && cmd.includes(config.TELEGRAM_BOT_TOKEN)) return true;
    } catch (_) { }  // process vanished — fall through
    return false;
  }
  // Can't determine bot identity — accept as potential match (best-effort).
  return true;
}

// Kills any connector still polling this bot token from an earlier run. Leftover
// background daemons steal Telegram updates and answer the user — the wrapper
// never hears the errors they get.
// NOTE: The pgrep pattern is scoped to THIS bot token so that multiple
// duplicated instances (each with a different TELEGRAM_BOT_TOKEN) don't
// kill each other's connectors. `cline connect --stop` is avoided on purpose —
// that's a global command that stops ANY connector, not just ours.
function purgeStale() {
  try {
    // Only match processes carrying THIS bot token — not generic "connect
    // telegram" which would catch and kill other bot instances.
    const pattern = `connect telegram.*${config.TELEGRAM_BOT_TOKEN}`;
    const out = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
    const myPid = process.pid;
    const own = ourProcessPids();        // our live child + its descendants
    for (const raw of out.split('\n')) {
      const pid = parseInt(raw, 10);
      // NOTE: no childPid skip — if our own child ignored SIGTERM and is hung,
      // this SIGKILL is the only thing that will actually stop it. Without it,
      // the hung connector keeps polling the bot and replying with limit
      // errors while its replacement fights it over getUpdates.
      if (!pid || pid === myPid) continue;
      if (own.has(pid)) continue;        // our own tree — stopCurrent owns it
      // Only kill ORPHANED matches (reparented to launchd, ppid=1). A match
      // whose parent is still alive belongs to a LIVE owner: either us
      // (stopCurrent handles it) or ANOTHER wrapper instance running the same
      // bot token. Killing that other wrapper's connector made the two
      // wrappers endlessly kill and restart each other's connectors — the
      // "restarting automatically" loop. Orphans from crashed runs keep ppid 1.
      let ppid = 0;
      try {
        ppid = parseInt(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim(), 10) || 0;
      } catch (_) {
        continue;                        // process vanished — nothing to kill
      }
      if (ppid !== 1) {
        log(`[Rotator] Connector pid ${pid} matches this token but is owned by a live process (ppid ${ppid}); leaving it alone.`);
        continue;
      }
      try {
        process.kill(pid, 'SIGKILL');
        log(`[Rotator] Killed stale connector pid ${pid}`);
      } catch (_) { }
    }
  } catch (_) {
    // pgrep absent, no matching processes, or token pattern didn't match — nothing to purge.
  }
}

// ── Duplicate-instance guard (agents.pids.json) ─────────────────────────────
// Two wrappers on the same bot token fight over Telegram getUpdates AND used to
// kill each other's connectors via purgeStale, producing an endless
// "Connector exited unexpectedly" restart loop. The instance's pid is recorded
// in agents.pids.json; a second wrapper for the same instance name refuses to
// start while the first is still alive.
// ─────────────────────────────────────────────────────────────────────────────

// Cross-process mutual exclusion for the shared agents.pids.json. Boot races
// (two wrappers starting at the same instant) used to read-modify-write the
// file concurrently: each snapshot missed the other's fresh entry, so the last
// writer's contents won and the first instance silently vanished from the file
// (observed live with EVOL+FSCENE 2026-08-29). The lock file is created with
// O_EXCL — atomic on POSIX — and only held for the duration of one read+write;
// a lock surviving longer than that belongs to a crashed writer and is stolen.
function withPidLock(fn) {
  const lockPath = config.PIDS_FILE + '.lock';
  const PID_LOCK_MAX_WAIT_MS = 5000;
  const PID_LOCK_STALE_MS = 1000;
  const scratch = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + PID_LOCK_MAX_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');   // O_CREAT|O_EXCL — atomic grab
      fs.closeSync(fd);
      break;                                    // lock acquired
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > PID_LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);              // previous writer crashed mid-write
          continue;
        }
      } catch (_) { continue; }                 // lock vanished while we looked
    }
    if (Date.now() >= deadline) throw new Error('timed out acquiring pid file lock');
    Atomics.wait(scratch, 0, 0, 25);            // synchronous ~25ms busy-wait
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch (_) { }
  }
}

// Atomic replace: write a unique temp file, then rename over the target, so a
// concurrent reader (the duplicate-instance guard in another wrapper, or
// restart-agent.sh) never sees a truncated / half-written JSON.
function writePidFile(all) {
  const tmp = `${config.PIDS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
  fs.renameSync(tmp, config.PIDS_FILE);
}

function readPidFile() {
  try { return JSON.parse(fs.readFileSync(config.PIDS_FILE, 'utf8')); } catch (_) { return {}; }
}

function writePidEntry() {
  try {
    withPidLock(() => {
      const all = readPidFile();
      all[config.INSTANCE_NAME] = { wrapperPid: process.pid, botUserId: config.BOT_USER_ID, hubPort: config.rpcPort };
      writePidFile(all);
    });
  } catch (err) {
    // Never fatal — a missed pid entry only costs a stale-guard recheck later.
    console.error(`[Rotator] Could not persist pid entry: ${err.message}`);
  }
}

function removePidEntry() {
  try {
    withPidLock(() => {
      const all = readPidFile();
      if (!all[config.INSTANCE_NAME]) return;
      delete all[config.INSTANCE_NAME];
      writePidFile(all);
    });
  } catch (err) {
    console.error(`[Rotator] Could not remove pid entry: ${err.message}`);
  }
}

// Advertises park state in the pid registry so the health watcher can tell a
// DELIBERATELY connector-less wrapper (parked on a cooldown grid) from a
// degraded one (alive but its connector died unexpectedly). `parkedUntil` is
// the wake epoch; 0/falsy clears the flag (connector starting again).
function markParked(parkedUntil) {
  try {
    withPidLock(() => {
      const all = readPidFile();
      const entry = all[config.INSTANCE_NAME];
      if (!entry) return;
      if (parkedUntil && parkedUntil > Date.now()) entry.parkedUntil = parkedUntil;
      else delete entry.parkedUntil;
      writePidFile(all);
    });
  } catch (err) {
    // Cosmetic only — a missing flag at worst costs one extra health restart.
    console.error(`[Rotator] Could not persist park state: ${err.message}`);
  }
}

function liveWrapperPid() {
  const entry = readPidFile()[config.INSTANCE_NAME];
  if (!entry || !entry.wrapperPid || entry.wrapperPid === process.pid) return null;
  try {
    process.kill(entry.wrapperPid, 0);           // liveness check (signal 0)
  } catch (_) {
    return null;                                 // entry is stale — safe to take over
  }
  // The pid is alive; make sure it really is a wrapper for this project and
  // not a recycled pid from some unrelated process.
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(entry.wrapperPid)], { encoding: 'utf8' });
    return cmd.includes('main.js') ? entry.wrapperPid : null;
  } catch (_) {
    return null;
  }
}

// Kills a connector pid if it is a STALE connector running our bot token
// (not our own child). When a limit line arrives from a pid that isn't ours,
// that pid is an orphan from a crashed wrapper — let the rotation path handle
// the key change AND kill the orphan so it stops stealing getUpdates.
function killIfStaleConnector(line) {
  const pidMatch = line.match(config.PID_RE);
  if (!pidMatch) return;
  const pid = parseInt(pidMatch[1], 10);
  if (pid === state.currentClinePid) return;       // ours — stopCurrent owns it
  if (ourProcessPids().has(pid)) return;            // our descendant — leave it
  try {
    const cmd = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
    if (cmd.includes('connect telegram') && cmd.includes(config.TELEGRAM_BOT_TOKEN)) {
      process.kill(pid, 'SIGKILL');
      log(`[Rotator] Killed stale connector pid ${pid} (detected from limit line)`);
    }
  } catch (_) { }  // process already gone — nothing to kill
}

module.exports = {
  collectDescendants,
  ourProcessPids,
  isOurBot,
  killIfStaleConnector,
  purgeStale,
  readPidFile,
  writePidEntry,
  removePidEntry,
  markParked,
  liveWrapperPid,
};