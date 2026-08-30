// ─────────────────────────────────────────────────────────────────────────────
// Telegram connector rotator — entry point.
//
// A wrapper that keeps a `cline connect telegram` connector alive through a
// key×model rotation grid. On a rate limit / fast crash / failed pre-flight
// probe it rotates to the next available (key, model) combo — and BEFORE every
// start it PROBES the combo against the real API, so the connector only ever
// runs with a tested, available key+model.
//
// Configuration lives in lib/config.js (ALL values come from environment
// variables, none are embedded):
//
//   TELEGRAM_BOT_TOKEN_<NAME>       bot token for this instance (argv[2] = NAME)
//   TELEGRAM_API_KEYS                comma-separated keys to rotate
//   TELEGRAM_AVAILABLE_MODELS        comma-separated models to rotate (REQUIRED)
//   TELEGRAM_ALLOWED_USER_ID         restrict notices/turn acks to one user
//   TELEGRAM_RESTART_DELAY_MS        delay before restarting (default 2000)
//   TELEGRAM_TASKS_FILE / _DIR       task-list source for progress pings
//   TELEGRAM_PROBE_ENABLED           force the pre-flight probe on/off
//   TELEGRAM_API_BASE                provider endpoint for the probe
//   TELEGRAM_PROBE_MAX_TOKENS        probe max_tokens (default 1)
//   TELEGRAM_PROBE_TIMEOUT_MS        probe timeout (default 15000)
//
// Run:  node main.js <NAME>   (e.g. `node main.js MANAGER`).
// ─────────────────────────────────────────────────────────────────────────────
// Header comment documents boot and the config env; no runtime import here.
const config = require('./lib/config');        // validates env on load
const log = require('./lib/log');
const state = require('./lib/state');
const procs = require('./lib/procs');
const supervisor = require('./lib/supervisor');
const logs = require('./lib/logs');
const rotation = require('./lib/rotation');
const cooldowns = require('./lib/cooldowns');

// ─────────────────────────────────────────────────────────────────────────────
// WRAPPER LIFECYCLE (boot only). None of this runs when main.js is required as
// a module — the unit tests pull it in to drive the probe/rotation helpers
// directly without spawning connectors or polling logs.
// ─────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  // Clean shutdown: stop the child before the wrapper exits.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (state.shuttingDown) return;          // a repeated signal must not re-arm restarts
      state.shuttingDown = true;
      log(`[Rotator] ${sig} received; stopping connector.`);
      procs.removePidEntry();
      // Wait for the child to actually die (incl. SIGKILL escalation) so a hung
      // connector isn't orphaned to keep polling the bot after we exit.
      supervisor.stopCurrent(() => process.exit(0));
    });
  }

  // Duplicate-instance guard. Two wrappers running the same bot token fight over
  // Telegram getUpdates AND used to kill each other's connectors via purgeStale,
  // producing an endless "Connector exited unexpectedly" restart loop.
  const existingWrapperPid = procs.liveWrapperPid();
  if (existingWrapperPid) {
    console.error(`[Rotator] ERROR: another wrapper for "${config.INSTANCE_NAME}" is already running (pid ${existingWrapperPid}).`);
    console.error('[Rotator] Two wrappers on the same bot token restart-loop by killing each other\'s connectors.');
    console.error(`[Rotator] Stop the existing one first:  kill ${existingWrapperPid}`);
    process.exit(1);
  }
  procs.writePidEntry();

  // Starts the wrapper: purge stale connectors, then give them a moment to
  // release the bot token before our connector takes over.
  procs.purgeStale();
  // Reload the PERSISTED cooldown grid BEFORE the first start so daily-limit
  // blocks from previous runs are honored (the wrapper consults the real
  // cooldowns instead of starting on a random — possibly still-blocked — slot).
  cooldowns.load();
  log(`[Rotator] Stale connectors purged; starting in ${config.RESTART_DELAY_MS}ms...`);
  setInterval(logs.pollLogs, 1000);            // check cline's logs every second
  // Boot also goes through startVerified: the chosen (key, model) is probed,
  // not trusted, exactly like every post-rotation restart. The choice itself is
  // a CONSULT of the cooldown grid — the first combo that is free (or, when
  // every pair is on a daily-limit cooldown, the one that frees up first) —
  // never a random slot.
  const boot = rotation.recommendCombo();
  log(`[Rotator] Boot consulted cooldown grid → key #${boot.key}, model #${boot.model}${boot.waitMs > 0 ? ` (still cooling; earliest free in ${Math.round(boot.waitMs / 60000)}m)` : ''}.`);
  if (boot.waitMs > 0) {
    // Every combo is on cooldown — don't probe (the probe would pass because
    // the connector can connect to Telegram, but the combo can't make API
    // calls). Instead, park on the earliest-free combo and wait. The park
    // monitor acks user messages (getUpdates) and auto-resumes when a combo
    // frees.
    log(`[Rotator] All combos cooling; parking until cooldown expires.`);
    supervisor.parkOnCooldown(boot.key, boot.model, boot.waitMs);
  } else {
    setTimeout(() => supervisor.startVerified(boot.key, boot.model), config.RESTART_DELAY_MS);
  }
}

// Test hook: when main.js is required as a module (never executed directly) the
// boot lifecycle above is skipped; expose the probe/rotation internals instead.
if (require.main !== module) {
  const probe = require('./lib/probe');
  const rotation = require('./lib/rotation');
  const cooldowns = require('./lib/cooldowns');
  module.exports = {
    parseCooldownMs: rotation.parseCooldownMs,
    classifyProbeFailure: probe.classifyProbeFailure,
    probeCombo: probe.probeCombo,
    startVerified: supervisor.startVerified,
    onProbeReject: supervisor.onProbeReject,
    blockedCombos: state.blockedCombos,
    probeBlockAt: rotation.probeBlockAt,
    comboUnblockAt: rotation.comboUnblockAt,
    recommendCombo: rotation.recommendCombo,
    gridStatus: rotation.gridStatus,
    cooldownsFile: config.COOLDOWNS_FILE,
    _cooldowns: cooldowns,                      // test seam: save/load round-trip
    PROBE_ENABLED: probe.PROBE_ENABLED,
    // Test-only controls: reset rotation state between simulated scenarios.
    _test: {
      setRestarting(v) { state.restarting = v; },
      setStartPending(v) { state.startPending = v; },
      setLastProbeNoticeAt(v) { state.lastProbeNoticeAt = v; },
      setStartOverride(fn) { supervisor._setStartOverride(fn); },
      clearParkMonitor() { supervisor.clearParkMonitor(); },
    },
  };
}