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
  const pids = new Set(state.knownPids);
  if (state.currentClinePid !== null) {
    pids.add(state.currentClinePid);
    for (const pid of collectDescendants(state.currentClinePid)) {
      pids.add(pid);
      state.knownPids.add(pid);
    }
  }
  return pids;
}

// Filter: is this log line from OUR bot? Uses botUserId where available, then
// falls back to the process tree of our child. This prevents cross-talk
// between duplicated instances that share the same ~/.cline/data/logs/cline.log.
function isOurBot(line) {
  const m = line.match(config.BOT_USER_ID_RE);
  if (m) return m[1] === config.BOT_USER_ID;
  const pidMatch = line.match(config.PID_RE);
  if (pidMatch) {
    const pid = parseInt(pidMatch[1], 10);
    if (pid === state.currentClinePid) return true;
    return ourProcessPids().has(pid);
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

function readPidFile() {
  try { return JSON.parse(fs.readFileSync(config.PIDS_FILE, 'utf8')); } catch (_) { return {}; }
}

function writePidEntry() {
  const all = readPidFile();
  all[config.INSTANCE_NAME] = { wrapperPid: process.pid, botUserId: config.BOT_USER_ID, hubPort: config.rpcPort };
  try { fs.writeFileSync(config.PIDS_FILE, JSON.stringify(all, null, 2) + '\n'); } catch (_) { }
}

function removePidEntry() {
  const all = readPidFile();
  if (!all[config.INSTANCE_NAME]) return;
  delete all[config.INSTANCE_NAME];
  try { fs.writeFileSync(config.PIDS_FILE, JSON.stringify(all, null, 2) + '\n'); } catch (_) { }
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

module.exports = {
  collectDescendants,
  ourProcessPids,
  isOurBot,
  purgeStale,
  readPidFile,
  writePidEntry,
  removePidEntry,
  liveWrapperPid,
};