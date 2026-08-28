const config = require('./config');
const state = require('./state');

// ── Cooldown grid ───────────────────────────────────────────────────────────
// Key `"<keyIdx>:<modelIdx>"` in state.blockedCombos -> unblock epoch ms.
// ─────────────────────────────────────────────────────────────────────────────

const COOLDOWN_DEFAULT_MS = 15 * 60 * 1000;      // fallback when no "try again in"
const COOLDOWN_GRACE_MS = 2 * 60 * 1000;         // extra safety beyond quoted time
// A connector that exits this quickly after start is rejecting its config
// (bad/exhausted key, bad model id), so the combo gets a short cooldown and
// the restart rotates — instead of crash-looping on the same key forever.
const CRASH_ROTATE_MS = 60 * 1000;
const CRASH_COOLDOWN_MS = 2 * 60 * 1000;

// Parses "Try again in 7h 3m" / "Try again after 7h 3m" (or "1h", "30m") out of
// an error line, returns ms. Same phrasing the provider cooldowns arrive in on
// both the runtime log lines and the pre-flight probe responses.
function parseCooldownMs(line) {
  const hm = line.match(/try again (?:in|after)\s+(\d+)h(?:\s+(\d+)m)?/i);
  if (hm) {
    const hours = parseInt(hm[1], 10);
    const mins = hm[2] ? parseInt(hm[2], 10) : 0;
    return (hours * 60 + mins) * 60 * 1000;
  }
  const m = line.match(/try again (?:in|after)\s+(\d+)m/i);
  if (m) return parseInt(m[1], 10) * 60 * 1000;
  return 0;
}

// Longest applicable unblock time for a combo — another signal may already have
// booked a longer cooldown (e.g. a 20h quota hit earlier than a short probe
// cooldown). Blocking NEVER shortens an existing block.
function probeBlockAt(key, model, cooldownMs) {
  const existing = state.blockedCombos.get(`${key}:${model}`) || 0;
  return Math.max(existing, Date.now() + cooldownMs);
}

// Blocks a (key, model) combo until now+cooldownMs (see probeBlockAt) and
// returns the unblock epoch.
function blockCombo(key, model, cooldownMs) {
  const unblockAt = probeBlockAt(key, model, cooldownMs);
  state.blockedCombos.set(`${key}:${model}`, unblockAt);
  return unblockAt;
}

// Returns the next (key, model) pair that is NOT on cooldown, scanning across
// keys first, then models. Rotating the model matters: OpenRouter's "daily free
// limit" is per model, so a fresh model escapes a model-scoped limit even when
// every key is exhausted on the old one.
function nextCombo() {
  const now = Date.now();
  const total = config.API_KEYS.length * config.MODELS.length;
  // Start one slot after the current combo so we always make progress.
  const start = state.curKeyIndex + state.curModelIndex * config.API_KEYS.length;
  for (let step = 1; step <= total; step++) {
    const slot = (start + step) % total;
    const k = slot % config.API_KEYS.length;
    const m = Math.floor(slot / config.API_KEYS.length);
    const unblockAt = state.blockedCombos.get(`${k}:${m}`) || 0;
    if (unblockAt <= now) return [k, m];
  }
  return null;                          // every key × model combo is on cooldown
}

// Earliest unblock time across all combos, used to sleep until something frees.
function earliestUnblock() {
  let earliest = Infinity;
  for (const unblockAt of state.blockedCombos.values()) {
    if (unblockAt < earliest) earliest = unblockAt;
  }
  return earliest === Infinity ? Date.now() + COOLDOWN_DEFAULT_MS : earliest;
}

// Picks the next (key, model) combo to run: the first slot not on cooldown,
// scanning one slot past the current combo so we always make progress. When
// EVERY combo is on cooldown, parks on the one that frees up first and
// reports how long the caller must wait before starting it.
function pickNextCombo() {
  const next = nextCombo();
  if (next) return { key: next[0], model: next[1], waitMs: 0 };
  const waitMs = Math.max(earliestUnblock() - Date.now() + COOLDOWN_GRACE_MS, 30 * 1000);
  let parkKey = 0, parkModel = 0, parkAt = Infinity;
  for (let m = 0; m < config.MODELS.length; m++) {
    for (let k = 0; k < config.API_KEYS.length; k++) {
      const unblockAt = state.blockedCombos.get(`${k}:${m}`) || 0;
      if (unblockAt < parkAt) { parkAt = unblockAt; parkKey = k; parkModel = m; }
    }
  }
  return { key: parkKey, model: parkModel, waitMs };
}

// Re-validates a (key, model) target AT START TIME. Returns the combo to start
// plus whether it is actually free (`available`) or how long to wait first.
// If the target itself has landed on cooldown (a later limit signal blocked it,
// or the quoted "try again in" turned out too short), falls back to
// pickNextCombo(). When EVERY combo is blocked, `available` is false and
// waitMs says when the earliest one frees up. Starting a blocked combo anyway
// is exactly what made the user see "daily limit reached" right after a
// rotation — this guard is checked by scheduleRestart before every start.
function resolveStartCombo(key, model) {
  if ((state.blockedCombos.get(`${key}:${model}`) || 0) <= Date.now()) {
    return { key, model, waitMs: 0, available: true };
  }
  const next = pickNextCombo();
  return { key: next.key, model: next.model, waitMs: next.waitMs, available: next.waitMs === 0 };
}

module.exports = {
  COOLDOWN_DEFAULT_MS,
  COOLDOWN_GRACE_MS,
  CRASH_ROTATE_MS,
  CRASH_COOLDOWN_MS,
  parseCooldownMs,
  probeBlockAt,
  blockCombo,
  nextCombo,
  earliestUnblock,
  pickNextCombo,
  resolveStartCombo,
};