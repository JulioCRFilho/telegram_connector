// test.park-stale-grid.js
// Regression test for the "agents frozen" bug: after a config change (models or
// keys removed), the persisted cooldown grid can contain records whose key/model
// indexes no longer exist. scanFromCurrent() ignores those out-of-grid slots,
// but earliestUnblock() counted them — an expired stale record collapsed the
// park wait to the 30s floor, producing the "re-parking ... for 1m" busy loop
// seen in wrapper-EVOL.out (no connector running for hours).
// The fix: bounds-check on load/save (lib/cooldowns) AND ignore them in
// earliestUnblock (lib/rotation).
// Run:  node test.park-stale-grid.js
process.env.TELEGRAM_BOT_TOKEN = '123456789:TEST';
const TEST_PROJECT = process.argv[2] || 'STALEGRID';
if (!process.argv[2]) process.argv.push(TEST_PROJECT);
process.env[`TELEGRAM_BOT_TOKEN_${TEST_PROJECT}`] = '123456789:TEST';
process.env.TELEGRAM_API_KEYS = 'k0,k1,k2,k3,k4,k5';        // 6 keys
process.env.TELEGRAM_AVAILABLE_MODELS = 'model-a,model-b,model-c'; // 3 models
// Never touch the live repo grid.
const tmpFile = require('path').join(require('os').tmpdir(), `cooldowns-${TEST_PROJECT}.json`);
process.env.TELEGRAM_COOLDOWNS_FILE = tmpFile;
process.env.TELEGRAM_STATE_FILE = require('path').join(require('os').tmpdir(), 'state-park-stale-grid-' + Date.now() + '.json');
const fs = require('fs');
fs.rmSync(tmpFile, { force: true });

const cooldowns = require('/Users/thetod/Projects/telegram_connector/lib/cooldowns');
const rotation = require('/Users/thetod/Projects/telegram_connector/lib/rotation');
const state = require('/Users/thetod/Projects/telegram_connector/lib/state');

let pass = 0, fail = 0;
function t(cond, name) {
  if (cond) { pass++; console.log(`  ok - ${name}`); }
  else { fail++; console.error(`  FAIL - ${name}`); }
}

const now = Date.now();
const HOUR = 3600 * 1000;

// ── 1) load() drops + heals out-of-grid records ─────────────────────────────
const poisoned = {
  '0:0': { unblockAt: now + 14 * HOUR, blockedAt: now, cooldownMs: 14 * HOUR, reason: 'daily free limit', detail: '' },
  '5:2': { unblockAt: now + 14 * HOUR, blockedAt: now, cooldownMs: 14 * HOUR, reason: 'daily free limit', detail: '' },
  '0:3': { unblockAt: now - 60 * 1000, blockedAt: now, cooldownMs: 0, reason: 'old config (model #3 no longer exists)', detail: '' }, // STALE POISON
  '7:1': { unblockAt: now + 14 * HOUR, blockedAt: now, cooldownMs: 14 * HOUR, reason: 'old config (key #7 no longer exists)', detail: '' },
  _models_: [0, 1, 2],  // LEGACY metadata: poison — the file must hold ONLY "k:m" records
};
fs.writeFileSync(tmpFile, JSON.stringify(poisoned));
cooldowns.load();
t(state.modelLimitHit.size === 0, 'legacy "_models_" metadata is NOT resurrected into modelLimitHit (in-memory only)');
t(state.blockedCombos.size === 2 && !state.blockedCombos.has('0:3') && !state.blockedCombos.has('7:1'),
  'load() keeps only in-grid records (2) and drops the 2 stale ones');
const healed = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
t(!healed['0:3'] && !healed['7:1'] && healed._models_ === undefined,
  'load() healed the persisted file (no stale records, no "_models_" left on disk)');

// ── 1b) grid helpers: 18 rounds, bounds-checked free check ──────────────────
t(cooldowns.totalCombos() === 18, 'totalCombos() = 6 keys × 3 models = 18 rounds (derived from config, never stored)');
t(cooldowns.isComboFree(0, 0) === false, 'isComboFree: blocked combo reports false');
t(cooldowns.isComboFree(5, 2) === false, 'isComboFree: second blocked combo reports false');
t(cooldowns.isComboFree(1, 1) === true, 'isComboFree: unblocked combo reports true');
t(cooldowns.isComboFree(6, 0) === false && cooldowns.isComboFree(0, 3) === false,
  'isComboFree: out-of-grid slots are never "free"');

// ── 1c) save() must NEVER write non-record keys, even with modelLimitHit set ─
state.modelLimitHit.add(0);
state.modelLimitHit.add(1);
cooldowns.scheduleSave();
cooldowns.save();
const afterSave = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
t(Object.keys(afterSave).every((k) => /^\d+:\d+$/.test(k)),
  `save() writes only "k:m" records even when modelLimitHit is set (got: ${Object.keys(afterSave).join(', ')})`);
state.modelLimitHit.clear();

// ── 2) earliestUnblock/pickNextCombo honor the REAL earliest despite poisons ─
state.blockedCombos.clear();
// Block EVERY in-grid combo (14h) — so the scan finds nothing free — THEN add
// the expired poison that used to collapse the park to the 30s floor.
for (let m = 0; m < 3; m++) {
  for (let k = 0; k < 6; k++) {
    state.blockedCombos.set(`${k}:${m}`, { unblockAt: now + 14 * HOUR, blockedAt: now, cooldownMs: 14 * HOUR });
  }
}
state.blockedCombos.set('0:3', { unblockAt: now - 60 * 1000, blockedAt: now, cooldownMs: 0 }); // expired poison
state.blockedCombos.set('7:1', { unblockAt: now + 14 * HOUR, blockedAt: now, cooldownMs: 14 * HOUR });
const p = rotation.pickNextCombo();
t(p.waitMs > 13 * HOUR, `park wait honors the REAL earliest unblock, not the stale floor (got ${Math.round(p.waitMs / 60000)}m, expected >780m)`);
t(p.key === 0 && p.model === 0, 'parks on the earliest-free in-grid combo (key #0 / model #0)');

// ── 3) resolveStartCombo (used right before a start) agrees ────────────────
const r = rotation.resolveStartCombo(0, 0);
t(!r.available && r.waitMs > 13 * HOUR, 'resolveStartCombo reports unavailable with the real wait (>780m)');

fs.rmSync(tmpFile, { force: true });
const line = `${pass} passed, ${fail} failed`;
console.log(`\n${'.'.repeat(line.length)}\n${line}\n${'.'.repeat(line.length)}`);
process.exit(fail ? 1 : 0);