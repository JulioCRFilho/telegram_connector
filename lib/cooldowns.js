const fs = require('fs');
const config = require('./config');
const state = require('./state');
const log = require('./log');

// ── Persisted cooldown grid ──────────────────────────────────────────────────
// Daily-limit blocks are LONG (up to ~24h) and wrappers restart often — an
// in-memory block grid forgets a daily limit on the very next restart and the
// connector re-hits the same combo immediately. So the grid lives in a per-
// instance JSON file and is reloaded at boot. The agent / user can consult it
// (agents.cooldowns.json and the /keys chat command) to see exactly
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

// A persisted record only makes sense when its key/model still exist in the
// CURRENT grid. After a config change (models/keys added or removed) stale
// records would otherwise survive load() and poison the park math:
// scanFromCurrent() ignores slots outside the grid, but earliestUnblock()
// still counts them — an expired out-of-grid record made the park recompute
// waitMs=30s forever (the "re-parking ... for 1m" loop in wrapper-EVOL.out)
// instead of sleeping until the REAL earliest unblock. Bounds-check everything
// that crosses the file boundary.
function gridKeyValid(recordKey) {
  const m = /^(\d+):(\d+)$/.exec(recordKey);
  if (!m) return false;
  const k = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  return k >= 0 && k < config.API_KEYS.length && mi >= 0 && mi < config.MODELS.length;
}

// Rebuilds state.blockedCombos / state.modelLimitHit from the persisted file.
// Expired records (unblockAt in the past) are dropped, so the grid only ever
// reflects REAL outstanding cooldowns. Out-of-grid records (from a past config)
// are dropped too AND removed from the file so they can't re-poison a future
// load or another instance's pickNextCombo.
function load() {
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(config.COOLDOWNS_FILE, 'utf8'));
  } catch (_) {
    return; // no file yet (or unreadable) — start with an empty grid
  }

  const now = Date.now();
  state.blockedCombos.clear();
  let droppedInvalid = false;
  if (data && typeof data === 'object') {
    for (const [key, rec] of Object.entries(data)) {
      if (key === '_models_') continue;
      if (!gridKeyValid(key)) { droppedInvalid = true; continue; }
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
  if (droppedInvalid) {
    // Heal the file: stale out-of-grid records caused the "re-parking for 1m"
    // busy loop — never let them survive on disk for the next process to load.
    log(`[Cooldown] Dropped out-of-grid record(s) from ${config.COOLDOWNS_FILE} (config changed since they were written); rewriting.`);
    save();
  }
}

// Serializes the CURRENT grid. Expired entries are dropped on write so the file
// never grows stale (a combo unblocks exactly on its quoted time) — and
// out-of-grid entries are never written at all (bounds-checked on the way out).
function save() {
  const now = Date.now();
  const out = {};
  for (const [key, rec] of state.blockedCombos.entries()) {
    if (!gridKeyValid(key)) continue;                    // stale config record — drop
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

module.exports = { load, save, scheduleSave, MAX_RECORD_AGE_MS, gridKeyValid };