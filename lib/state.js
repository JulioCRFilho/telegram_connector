// Central mutable state shared by every module of the rotator. Keeping it in
// one object avoids circular requires and makes the boot/testing wiring clear.
module.exports = {
  // Live connector child (set/cleared by lib/supervisor.js).
  clineProcess: null,
  currentClinePid: null,
  // Pids of our own retired connector processes (child + descendants). A limit
  // line written by a dying connector just before shutdown must still trigger a
  // rotation — its pid no longer resolves via the live tree, but the line is
  // still ours.
  knownPids: new Set(),

  // Current rotation position in the key×model grid.
  curKeyIndex: 0,
  curModelIndex: 0,
  // Remembers which (key, model) combos are on cooldown and until when, so a
  // model-scoped limit ("Daily free limit reached on model X") is not re-tried
  // every restart. Key `"<keyIdx>:<modelIdx>"` -> unblock epoch ms.
  blockedCombos: new Map(),

  // Guards the start window: while a pre-flight probe is in flight (or a spawn
  // is being arranged), a new scheduleRestart must not arm a parallel start —
  // it queues pendingRotation instead, and the in-flight start chain defers to
  // that target when the probe resolves.
  startPending: false,
  // If a restart is already pending when a limit rotation fires, remember the
  // rotation target so the next start doesn't loop back onto the exhausted key.
  pendingRotation: null,

  restarting: false,
  // Set by the rotation/crash restart paths so the next start skips the
  // startup resume notice — those paths already notify the user themselves.
  restartFromRotation: false,
  // Set by the rotation/crash paths; consumed by the next startCline.
  pendingResume: null,

  shuttingDown: false,
  // Last chat id seen in any telegram-connect log line (fallback chat id).
  lastSeenChatId: null,
  // Guards against reacting twice to the same underlying limit error.
  lastLimitHandledAt: 0,
  // Throttles the per-rejection "testing X next" notices during a dead-combo
  // sweep, and tracks whether the user was told a that a combo was rejected but
  // a new one hasn't been confirmed yet (so "back online" closes the loop).
  lastProbeNoticeAt: 0,
  probeRejectedRecently: false,
};