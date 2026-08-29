const fs = require('fs');
const config = require('./config');
const state = require('./state');
const log = require('./log');

// ── Persisted cooldown grid ──────────────────────────────────────────────────
// Daily-limit blocks are LONG (up to ~24h) and wrappers restart often — an
// in-memory block grid forgets a daily limit on the very next restart and the
// connector re-hits the same combo immediately. So the grid lives in a per-
// instance JSON file and is reloaded at boot. The agent / user can consult it
// (agents.cooldowns-<NAME>.json and the /keys chat command) to see exactly
// which (key, model) pair is available and when each blocked pair frees up —
// and rotation consults the grid instead of picking randomly.
//
// File shape:
//   {
//     "0:0": { "unblockAt": 1789…, "blockedAt": 1788…, "cooldownMs": 76200000,
//              "reason": "quota/rate limit", "detail": "Error 429: …" },
//     …
//     "_models_": [0, 1]
//   }
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RECORD_AGE_MS = 26 * 60 * 60 * 1000;   // safety cap: never revive >24h-old blocks

// Rebuilds state.blockedCombos / state.modelLimitHit from the persisted file.
// Expired records (unblockAt in the past) are dropped, so the grid only ever
// reflects REAL outstanding cooldowns.
function load() {
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(config.COOLDOWNS_FILE, 'utf8'));
  } catch (_) {
    return; // no file yet (or unreadable) — start with an empty grid
  }

  const now = Date.now();
  state.blockedCombos.clear();
  if (data && typeof data === 'object') {
    for (const [key, rec] of Object.entries(data)) {
      if (key === '_models_') continue;
      if (!rec || !rec.unblockAt) continue;
      if (rec.unblockAt <= now) continue;                 // already freed
      if (now - (rec.blockedAt || 0) > MAX_RECORD_AGE_MS) continue; // stale safety net
      state.blockedCombos.set(key, {
        unblockAt: rec.unblockAt,
        blockedAt: rec.blockedAt || Date.now(),
        cooldownMs: rec.cooldownMs || 0,
        reason: rec.reason || 'unknown',
        detail: rec.detail || '',
      });
    }
  }

  state.modelLimitHit.clear();
  if (data && Array.isArray(data._models_)) {
    for (const m of data._models_) {
      if (Number.isInteger(m) && m >= 0 && m < config.MODELS.length) state.modelLimitHit.add(m);
    }
  }

  if (state.blockedCombos.size > 0) {
    log(`[Cooldown] Loaded ${state.blockedCombos.size} persisted block(s) from ${config.COOLDOWNS_FILE} — rotation resumes with the real cooldown grid.`);
  }
}

// Serializes the CURRENT grid. Expired entries are dropped on write so the file
// never grows stale (a combo unblocks exactly on its quoted time).
function save() {
  const now = Date.now();
  const out = {};
  for (const [key, rec] of state.blockedCombos.entries()) {
    if (!rec || rec.unblockAt <= now) continue;
    out[key] = {
      unblockAt: rec.unblockAt,
      blockedAt: rec.blockedAt,
      cooldownMs: rec.cooldownMs,
      reason: rec.reason,
      detail: rec.detail ? rec.detail.slice(0, 500) : '',
    };
  }
  if (state.modelLimitHit.size > 0) out._models_ = [...state.modelLimitHit];
  try {
    fs.writeFileSync(config.COOLDOWNS_FILE, JSON.stringify(out, null, 2) + '\n');
  } catch (err) {
    log(`[Cooldown] Couldn't persist cooldown grid: ${err.message}`);
  }
}

// Write-through after every change; debounced so a dense block/rotate sweep
// (probe rejects each combo in quick succession) does one file write, not many.
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save();
  }, 250);
}

module.exports = { load, save, scheduleSave, MAX_RECORD_AGE_MS };