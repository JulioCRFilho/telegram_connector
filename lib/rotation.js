const config = require('./config');
const state = require('./state');
const cooldowns = require('./cooldowns');

// ── Cooldown grid ───────────────────────────────────────────────────────────
// Key `"<keyIdx>:<modelIdx>"` in state.blockedCombos -> rich record:
//   { unblockAt, blockedAt, cooldownMs, reason, detail }
// The grid is PERSISTED (lib/cooldowns.js) so daily-limit blocks survive
// wrapper restarts — the wrapper consults the real cooldown times to pick the
// next pair, never a random slot.
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

// Numeric unblock time for a combo (0 = never blocked). Reads the rich record
// so the rest of the code keeps comparing plain epochs.
function comboUnblockAt(key, model) {
  const rec = state.blockedCombos.get(`${key}:${model}`);
  return rec && rec.unblockAt > 0 ? rec.unblockAt : 0;
}

// Longest applicable unblock time for a combo — another signal may already have
// booked a longer cooldown (e.g. a 20h quota hit earlier than a short probe
// cooldown). Blocking NEVER shortens an existing block.
function probeBlockAt(key, model, cooldownMs) {
  const existing = comboUnblockAt(key, model);
  return Math.max(existing, Date.now() + cooldownMs);
}

// Blocks a (key, model) combo until now+cooldownMs (see probeBlockAt) and
// returns the unblock epoch. Keeps the QUOTED real cooldown + reason in the
// record and persists the grid so a wrapper restart can't forget a daily limit.
function blockCombo(key, model, cooldownMs, reason, detail) {
  const unblockAt = probeBlockAt(key, model, cooldownMs);
  const existing = state.blockedCombos.get(`${key}:${model}`);
  state.blockedCombos.set(`${key}:${model}`, {
    unblockAt,
    blockedAt: (existing && existing.blockedAt) || Date.now(),
    cooldownMs: Math.max(cooldownMs, existing ? existing.cooldownMs : 0),
    reason: reason || (existing && existing.reason) || 'unknown',
    detail: detail || (existing && existing.detail) || '',
  });
  cooldowns.scheduleSave();
  return unblockAt;
}

// Returns the next (key, model) pair that is NOT on cooldown, scanning across
// keys first, then models. Rotating the model matters: OpenRouter's "daily free
// limit" is per model, so a fresh model escapes a model-scoped limit even when
// every key is exhausted on the old one.
//
// When the current model has hit a rate limit (tracked in state.modelLimitHit),
// we prefer to rotate to a DIFFERENT model rather than trying more keys on the
// same exhausted model — a model-scoped limit affects all keys, so rotating
// keys within the same model is futile and just produces repeat errors.
function nextCombo() {
  const now = Date.now();
  const total = config.API_KEYS.length * config.MODELS.length;
  // Start one slot after the current combo so we always make progress.
  const start = state.curKeyIndex + state.curModelIndex * config.API_KEYS.length;

  // If the current model has hit a rate limit, prefer other models first.
  if (state.modelLimitHit.has(state.curModelIndex)) {
    for (let step = 1; step <= total; step++) {
      const slot = (start + step) % total;
      const k = slot % config.API_KEYS.length;
      const m = Math.floor(slot / config.API_KEYS.length);
      if (m === state.curModelIndex) continue; // skip the exhausted model
      const unblockAt = comboUnblockAt(k, m);
      if (unblockAt <= now) return [k, m];
    }
    // No other model is free; fall through to try the current model's remaining keys.
  }

  for (let step = 1; step <= total; step++) {
    const slot = (start + step) % total;
    const k = slot % config.API_KEYS.length;
    const m = Math.floor(slot / config.API_KEYS.length);
    const unblockAt = comboUnblockAt(k, m);
    if (unblockAt <= now) return [k, m];
  }
  return null;                          // every key × model combo is on cooldown
}

// Earliest unblock time across all combos, used to sleep until something frees.
function earliestUnblock() {
  let earliest = Infinity;
  for (const rec of state.blockedCombos.values()) {
    if (rec.unblockAt < earliest) earliest = rec.unblockAt;
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
      const unblockAt = comboUnblockAt(k, m);
      if (unblockAt < parkAt) { parkAt = unblockAt; parkKey = k; parkModel = m; }
    }
  }
  return { key: parkKey, model: parkModel, waitMs };
}

// Picks the next (key, model) combo by scanning ALL slots from slot 0.
// Unlike pickNextCombo() which starts from the current position, this does
// a full loop to ensure every combo is tested. This is critical when the
// starting index is randomized - we must test ALL keys, not just the ones
// after the current position.
function pickNextComboFromStart() {
  const now = Date.now();
  const total = config.API_KEYS.length * config.MODELS.length;

  // Scan all slots from 0 to find the first available combo
  for (let slot = 0; slot < total; slot++) {
    const k = slot % config.API_KEYS.length;
    const m = Math.floor(slot / config.API_KEYS.length);
    const unblockAt = comboUnblockAt(k, m);
    if (unblockAt <= now) return { key: k, model: m, waitMs: 0 };
  }

  // All combos are blocked - park on the one that frees up first
  const waitMs = Math.max(earliestUnblock() - Date.now() + COOLDOWN_GRACE_MS, 30 * 1000);
  let parkKey = 0, parkModel = 0, parkAt = Infinity;
  for (let m = 0; m < config.MODELS.length; m++) {
    for (let k = 0; k < config.API_KEYS.length; k++) {
      const unblockAt = comboUnblockAt(k, m);
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
  if (comboUnblockAt(key, model) <= Date.now()) {
    return { key, model, waitMs: 0, available: true };
  }
  const next = pickNextCombo();
  return { key: next.key, model: next.model, waitMs: next.waitMs, available: next.waitMs === 0 };
}

// Deterministic consultation of the cooldown grid — the replacement for blind /
// random rotation. Returns the first combo that is free right now (slot 0
// scan), or — when every combo is on a daily-limit cooldown — the one that
// frees up FIRST with a positive waitMs telling the caller how long that takes.
// Boot, rotation and the /keys chat command all consult this same grid.
function recommendCombo() {
  return pickNextComboFromStart();
}

// Human-readable grid for the agent/user (the /keys chat command, cooldown
// notices, connector.log). Shows every key×model pair, its REAL quoted
// cooldown + reason, and the recommended next combo.
function gridStatus() {
  const now = Date.now();
  const rec = recommendCombo();
  const lines = [];
  lines.push(`🗂 Cooldown grid (${config.API_KEYS.length} key(s) × ${config.MODELS.length} model(s)):`);
  for (let m = 0; m < config.MODELS.length; m++) {
    for (let k = 0; k < config.API_KEYS.length; k++) {
      const key = `key #${k}`;
      const model = config.MODELS[m];
      const current = k === state.curKeyIndex && m === state.curModelIndex ? ' — CURRENT' : '';
      const record = state.blockedCombos.get(`${k}:${m}`);
      if (record && record.unblockAt > now) {
        const minsLeft = Math.max(1, Math.round((record.unblockAt - now) / 60000));
        const hh = String(Math.floor(minsLeft / 60)).padStart(2, '0');
        const mm = String(minsLeft % 60).padStart(2, '0');
        lines.push(`• ${key} / ${model} — ⏳ cooldown ${hh}h${mm}m (real: ${minsLeft}m)${current} — ${record.reason}${record.detail ? `: ${String(record.detail).slice(0, 80)}` : ''}`);
      } else {
        lines.push(`• ${key} / ${model} — ✅ available${current}`);
      }
    }
  }
  if (rec.waitMs > 0) {
    lines.push(`→ Next free ~${new Date(now + rec.waitMs).toISOString().slice(11, 16)} UTC → recommended key #${rec.key} / ${config.MODELS[rec.model]}`);
  } else {
    lines.push(`→ Recommended now: key #${rec.key} / ${config.MODELS[rec.model]}`);
  }
  return lines.join('\n');
}

module.exports = {
  COOLDOWN_DEFAULT_MS,
  COOLDOWN_GRACE_MS,
  CRASH_ROTATE_MS,
  CRASH_COOLDOWN_MS,
  parseCooldownMs,
  comboUnblockAt,
  probeBlockAt,
  blockCombo,
  nextCombo,
  earliestUnblock,
  pickNextCombo,
  pickNextComboFromStart,
  resolveStartCombo,
  recommendCombo,
  gridStatus,
};