// Simulation of the full rotation loop: "rotate → probe key/model → reject →
// rotate again" (the requirement), driving the REAL main.js code with a mocked
// provider endpoint so no real connector is launched.
// Run:  node test.rotation.sim.js
process.env.TELEGRAM_BOT_TOKEN = '123456789:TEST';
const TEST_PROJECT = process.argv[2] || 'SIMSIM';
if (!process.argv[2]) process.argv.push(TEST_PROJECT);
process.env[`TELEGRAM_BOT_TOKEN_${TEST_PROJECT}`] = '123456789:TEST';
process.env.TELEGRAM_API_KEYS = 'sk-or-v1-aaa, sk-or-v1-bbb';
process.env.TELEGRAM_AVAILABLE_MODELS = 'openrouter/auto, deepseek/deepseek-chat';
process.env.TELEGRAM_RESTART_DELAY_MS = '50';
// Tests drive the OPT-IN HTTP probe stage: DOUBLE opt-in — the test sets both
// TELEGRAM_PROBE_HTTP=1 and a mock provider base URL (the fetch mock below
// answers it). Production NEVER sets these for cline-default providers, so the
// probe stays on cline's own client (spawn-based).
process.env.TELEGRAM_PROBE_HTTP = '1';
process.env.TELEGRAM_API_BASE = 'https://mock-provider.test';
process.env.TELEGRAM_TASKS_DIR = require('os').tmpdir();
process.env.TELEGRAM_ALLOWED_USER_ID = '123456789'; // so notifyUser actually emits + logs
process.env.PATH = '';                    // any spawn attempt fails harmlessly (ENOENT)
// Persisted cooldown grid must go to the tmpdir (never the repo) in tests.
const tmpCooldowns = require('path').join(require('os').tmpdir(), 'cooldowns-SIMSIM.json');
process.env.TELEGRAM_COOLDOWNS_FILE = tmpCooldowns;
require('fs').rmSync(tmpCooldowns, { force: true });   // start from a clean grid

const m = require('./main.js');

// Capture the wrapper's own logging so we can assert on the rotation sequence.
const outLines = [];
const origLog = console.log;
console.log = (...a) => { outLines.push(a.join(' ')); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const err = (code, message) => ({
  status: code,
  headers: { get: () => null },
  json: async () => ({ error: { code, message } }),
});
// A "passing" provider returns a minimal chat completion payload.
const pass = () => ({
  status: 200,
  headers: { get: () => null },
  json: async () => ({ choices: [{ index: 0 }], model: 'mock' }),
});

let passCount = 0, failCount = 0;
function t(cond, name) {
  if (cond) { passCount++; process.stdout.write(`  ok - ${name}\n`); }
  else { failCount++; process.stdout.write(`  FAIL - ${name}\n`); }
}
// Restore console BEFORE printing results here.
function restoreLog() { if (console.log !== origLog) console.log = origLog; }

(async () => {
  // ── Scenario 1: every combo rejected → all block, then park ─────────────
  global.fetch = async () => err(429, 'Error 429: Daily free limit reached on model x. Try again in 21h 2m');
  await m.startVerified(0, 0);
  await sleep(700);                       // let the 2×2 grid sweep through all 4 combos

  const logS1 = outLines.join('\n');
  t(m.blockedCombos.size === 4, 'all 4 key×model combos got blocked by probe failures');
  t(/All 2×2 combos unavailable/.test(logS1), 'full-cooldown park engaged');
  t(/Blocked ALL .* keys on model #0 .* model-scoped limit/.test(logS1), 'model-scoped limit blocked every key of the model at once');
  const s1rec = m.blockedCombos.get('0:0');
  t(s1rec && Math.abs(s1rec.cooldownMs - (21 * 60 + 2) * 60 * 1000) < 5 * 60 * 1000, 'quoted 21h 2m cooldown persisted on the blocked combo');
  const startsS1 = (logS1.match(/Starting connector/g) || []).length;
  t(startsS1 === 0, 'no connector ever started — every combo was tested and rejected');

  // ── Scenario 2: key #0 always rejected, key #1 always OK ─────────────────
  // Reset rotation state left parked by scenario 1's 21h full-cooldown wait.
  // startVerified/scheduleRestart now reconcile with the PERSISTED grid (disk),
  // so a clean grid must be restored on disk too — just clearing the in-memory
  // map would re-poison the park with scenario 1's 21h records.
  m._test.clearParkMonitor();
  m._test.setRestarting(false);
  m._test.setStartPending(false);
  m._test.setLastProbeNoticeAt(0);
  m.blockedCombos.clear();
  require('fs').rmSync(tmpCooldowns, { force: true });
  outLines.length = 0;
  const started = [];                     // which combos were actually launched
  m._test.setStartOverride((i, mi) => { started.push([i, mi]); });
  global.fetch = async (url, opts) => {
    const auth = String(opts.headers.Authorization || '');
    return auth.startsWith('Bearer sk-or-v1-aaa') ? err(401, 'Invalid API key') : pass();
  };
  await m.startVerified(0, 0);
  await sleep(200);                       // probe → reject → re-probe → pass

  const logS2 = outLines.join('\n');
  t(m.blockedCombos.size === 1, `only the rejected combo (key 0 × model 0) was blocked [size=${m.blockedCombos.size}, keys=${[...m.blockedCombos.keys()].join(',')}]`);
  t(m.blockedCombos.has('0:0'), 'blocked combos contains "0:0"');
  t(/Blocked key #0 \+ model #0/.test(logS2), 'rejection was logged as a probe block');
  t(/Rotating to key #1, model #0/.test(logS2), 'wrapper rotated again → key #1 / model #0');
  t(JSON.stringify(started) === JSON.stringify([[1, 0]]), `only the PASSING combo (1,0) started — never the rejected one (got ${JSON.stringify(started)})`);
  t(/was rejected — trying another one/.test(logS2), 'user-facing rejection notice was queued');
  await sleep(300);                       // let the debounced cooldown-grid write land

  // ── Scenario 3: the grid is CONSULTED, not guessed ──────────────────────
  t(m.comboUnblockAt(0, 0) > Date.now(), 'comboUnblockAt(0,0) stays blocked with its real unblock epoch');
  t(m.comboUnblockAt(1, 0) === 0, 'comboUnblockAt(1,0) is free (0 = never blocked)');
  const rec = m.recommendCombo();
  t(rec.key === 1 && rec.model === 0 && rec.waitMs === 0, `recommendCombo consults the grid → first free (1,0) [got ${JSON.stringify(rec)}]`);
  const grid = m.gridStatus();
  t(grid.includes('Cooldown grid') && grid.includes('✅') && grid.includes('⏳'), 'gridStatus renders available + cooldown rows');
  t(/key #0 \/ openrouter\/auto — ⏳/.test(grid) && /cooldown/.test(grid), 'gridStatus shows the blocked combo with the real cooldown marker');

  // Persistence round-trip: the 401 block survives a "wrapper restart".
  m.blockedCombos.clear();
  m._cooldowns.load();                     // reload from the persisted file
  t(m.blockedCombos.has('0:0') && m.comboUnblockAt(0, 0) > Date.now(), 'persisted grid reloads after a wrapper restart (daily limit not forgotten)');

  restoreLog();
  const line = `${passCount} passed, ${failCount} failed`;
  console.log(`\n${'.'.repeat(line.length)}\n${line}\n${'.'.repeat(line.length)}`);
  process.exit(failCount ? 1 : 0);
})().catch((e) => {
  restoreLog();
  console.error('sim crashed:', e);
  process.exit(1);
});