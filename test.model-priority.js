// test.model-priority.js
// Regression test for capacity-priority model selection: the agents must
// prefer z-ai/glm-5.3-flash, then deepseek/deepseek-v4-flash, then any other
// model — regardless of the order the models appear in
// TELEGRAM_AVAILABLE_MODELS. Boot (recommendCombo), rotation
// (pickNextCombo) and the cooldown grid all go through the same priority
// scan; a model blocked by a daily limit is skipped in favor of the next
// priority model.
// Run:  node test.model-priority.js
process.env.TELEGRAM_BOT_TOKEN = '123456789:TEST';
const TEST_PROJECT = process.argv[2] || 'PRIO';
if (!process.argv[2]) process.argv.push(TEST_PROJECT);
process.env[`TELEGRAM_BOT_TOKEN_${TEST_PROJECT}`] = '123456789:TEST';
process.env.TELEGRAM_API_KEYS = 'sk-prio-a, sk-prio-b';
// Deliberately REVERSE order: poolside first in the env list, so picking it
// would mean priority is ignored.
process.env.TELEGRAM_AVAILABLE_MODELS = 'poolside/laguna-s-2.1:free, z-ai/glm-5.3-flash, deepseek/deepseek-v4-flash';
process.env.TELEGRAM_MODEL_PRIORITY = 'z-ai/glm-5.3-flash, deepseek/deepseek-v4-flash';
process.env.TELEGRAM_RESTART_DELAY_MS = '30';
process.env.TELEGRAM_PROBE_HTTP = '1';
process.env.TELEGRAM_API_BASE = 'https://mock-provider.test';
process.env.TELEGRAM_STATE_FILE = require('path').join(require('os').tmpdir(), 'state-test.model-priority-' + Date.now() + '.json');
process.env.TELEGRAM_TASKS_DIR = require('os').tmpdir();
process.env.TELEGRAM_ALLOWED_USER_ID = '123456789';
process.env.PATH = '';
const fs = require('fs');
const tmpCooldowns = require('path').join(require('os').tmpdir(), 'cooldowns-PRIO.json');
process.env.TELEGRAM_COOLDOWNS_FILE = tmpCooldowns;

const m = require('./main.js');

let pass = 0, fail = 0;
function t(cond, name) {
  if (cond) { pass++; process.stdout.write(`  ok - ${name}\n`); }
  else { fail++; process.stdout.write(`  FAIL - ${name}\n`); }
}
const blockAll = (modelIdx) => {
  for (let k = 0; k < 2; k++) {
    m.blockedCombos.set(`${k}:${modelIdx}`, { unblockAt: Date.now() + 3600000, blockedAt: Date.now(), cooldownMs: 3600000, reason: 'daily limit (test)', detail: '' });
  }
};

(async () => {
  fs.rmSync(tmpCooldowns, { force: true });
  m.blockedCombos.clear();

  // ── 1) ranking itself ──────────────────────────────────────────────────────
  t(m.modelRank(1) === 0, 'glm-5.3-flash ranks 0 (highest capacity)');
  t(m.modelRank(2) === 1, 'deepseek-v4-flash ranks 1');
  t(m.modelRank(0) === 2, 'poolside falls into the "any" tier');
  t(m.modelsByPriority().join(',') === '1,2,0', 'priority order is glm → deepseek → poolside despite env order');

  // ── 2) boot pick: clean grid → glm, never the first env slot ──────────────
  const boot = m.recommendCombo();
  t(boot.waitMs === 0 && boot.model === 1, `clean grid boot picks glm (got model #${boot.model}, ${boot.waitMs}ms wait)`);

  // ── 3) glm exhausted → deepseek; deepseek exhausted → poolside ────────────
  blockAll(1);
  let rec = m.recommendCombo();
  t(rec.model === 2, 'all glm keys blocked → deepseek chosen');
  blockAll(2);
  rec = m.recommendCombo();
  t(rec.model === 0, 'glm + deepseek blocked → poolside ("any" tier) chosen');

  // ── 4) runtime rotation (pickNextCombo) follows the same priority ─────────
  m.blockedCombos.clear();
  m._test.setCurrentCombo(0, 1);          // running glm on key #0
  blockAll(1);                            // glm dies (model-scoped)
  const next = m.pickNextCombo ? m.pickNextCombo() : null;
  t(next && next.model === 2, 'runtime rotation skips dead glm → deepseek');

  // ── 5) priority models recover → agents move BACK up the ladder ──────────
  m.blockedCombos.clear();
  m._test.setCurrentCombo(0, 0);          // running poolside
  const backUp = m.pickNextCombo();
  t(backUp.model === 1, 'when glm frees up, rotation climbs back to the top-priority model');

  const line = `${pass} passed, ${fail} failed`;
  process.stdout.write(`\n${'.'.repeat(line.length)}\n${line}\n${'.'.repeat(line.length)}\n`);
  fs.rmSync(tmpCooldowns, { force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
