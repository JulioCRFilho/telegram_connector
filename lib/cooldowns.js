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
// File shape (ONE record per blocked key×model combo — nothing else):
//   {
//     "0:0": { "unblockAt": 1789…, "blockedAt": 1788…, "cooldownMs": 76200000,
//              "reason": "quota/rate limit", "detail": "Error 429: …" },
//     …
//   }
// A model-scoped daily limit is expressed by blocking ALL its key records
// (6 keys × 3 models = 18 records when everything is cooling) — there is NO
// extra metadata key in the file. Anything reading the grid must go through
// the helpers below (gridKeyValid / totalCombos / isComboFree) instead of
// assuming every JSON key is a "k:m" record.
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
      if (!gridKeyValid(key)) { droppedInvalid = true; continue; }   // "_models_" and friends: poison, heal on save
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

  if (state.blockedCombos.size > 0) {
    log(`[Cooldown] Loaded ${state.blockedCombos.size} persisted block(s) from ${config.COOLDOWNS_FILE} — rotation resumes with the real cooldown grid.`);
  }
  if (droppedInvalid) {
    // Heal the file: stale out-of-grid records AND non-record keys (the old
    // "_models_" metadata) caused consumers walking the JSON to misparse it —
    // never let them survive on disk for the next process to load.
    log(`[Cooldown] Dropped invalid record(s)/key(s) from ${config.COOLDOWNS_FILE} (config changed or legacy metadata); rewriting.`);
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
  // NOTE: no extra metadata keys here — the file holds ONLY "k:m" records.
  // state.modelLimitHit is deliberately IN-MEMORY ONLY: the persisted grid
  // already expresses model-scoped limits as one record per key, and the old
  // "_models_" array in the JSON broke every consumer that walks the file.
  try {
    fs.writeFileSync(config.COOLDOWNS_FILE, JSON.stringify(out, null, 2) + '\n');
  } catch (err) {
    log(`[Cooldown] Couldn't persist cooldown grid: ${err.message}`);
  }
}

// ── Helpers for consumers (agents, /keys, tests) ────────────────────────────
// Total rounds in the grid: every key × every model (e.g. 6 keys × 3 models
// = 18 rounds). This is derived from the LIVE config, never stored.
function totalCombos() {
  return config.API_KEYS.length * config.MODELS.length;
}

// Is a specific (key, model) combo usable right now? Bounds-checked against
// the current grid — the single check any consumer needs.
function isComboFree(key, model) {
  if (key < 0 || key >= config.API_KEYS.length) return false;
  if (model < 0 || model >= config.MODELS.length) return false;
  const rec = state.blockedCombos.get(`${key}:${model}`);
  return !rec || rec.unblockAt <= Date.now();
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

module.exports = { load, save, scheduleSave, MAX_RECORD_AGE_MS, gridKeyValid, totalCombos, isComboFree };