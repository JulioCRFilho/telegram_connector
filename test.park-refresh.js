// test.park-refresh.js
// Regression test for the park REFRESH ROUND (adds to the park↔restart fix):
// whenever ALL key×model combos are on cooldown, the parked wrapper re-
// consults the persisted cooldown grid every interval instead of blindly
// sleeping until the quoted unblock time. If a combo frees early (record
// healed, peer cleared it, over-quoted time), the park EXITS right away and
// starts on that combo; if peers moved the earliest unblock earlier, the wake
// timer re-arms; otherwise the park stays untouched.
// Run:  node test.park-refresh.js
const TEST_PROJECT = 'REFRESHT';
process.argv.push(TEST_PROJECT);
process.env.TELEGRAM_BOT_TOKEN = '123456789:TEST';
process.env[`TELEGRAM_BOT_TOKEN_${TEST_PROJECT}`] = '123456789:TEST';
process.env.TELEGRAM_API_KEYS = 'sk-r-a, sk-r-b';
process.env.TELEGRAM_AVAILABLE_MODELS = 'z-ai/glm-5.3-flash, deepseek/deepseek-v4-flash';
process.env.TELEGRAM_MODEL_PRIORITY = 'z-ai/glm-5.3-flash, deepseek/deepseek-v4-flash';
process.env.TELEGRAM_RESTART_DELAY_MS = '30';
process.env.TELEGRAM_PROBE_ENABLED = '0';     // start is a synchronous doStart → deterministic override capture
process.env.TELEGRAM_PROBE_HTTP = '1';
process.env.TELEGRAM_API_BASE = 'https://mock-provider.test';
process.env.TELEGRAM_STATE_FILE = require('path').join(require('os').tmpdir(), 'state-test.park-refresh-' + Date.now() + '.json');
process.env.TELEGRAM_TASKS_DIR = require('os').tmpdir();
process.env.TELEGRAM_ALLOWED_USER_ID = '123456789';
process.env.PATH = '';
const os = require('os');
const fs = require('fs');
const path = require('path');
const tmpPids = path.join(os.tmpdir(), `pids-${TEST_PROJECT}-${process.pid}.json`);
const tmpCooldowns = path.join(os.tmpdir(), `cooldowns-${TEST_PROJECT}-${process.pid}.json`);
process.env.TELEGRAM_PIDS_FILE = tmpPids;
process.env.TELEGRAM_COOLDOWNS_FILE = tmpCooldowns;

const m = require('./main.js');
const procs = require('./lib/procs');
const supervisor = require('./lib/supervisor');   // same configured instance (module cache)

let pass = 0, fail = 0;
function t(cond, name) {
  if (cond) { pass++; process.stdout.write(`  ok - ${name}\n`); }
  else { fail++; process.stdout.write(`  FAIL - ${name}\n`); }
}
const KEY_CNT = 2, MODEL_CNT = 2;        // 2×2 = 4 combos (mechanic is N×M-generic)
const blockAll = (unblockAt) => {
  for (let k = 0; k < KEY_CNT; k++) {
    for (let mo = 0; mo < MODEL_CNT; mo++) {
      m.blockedCombos.set(`${k}:${mo}`, { unblockAt, blockedAt: Date.now(), cooldownMs: Math.max(unblockAt - Date.now(), 1000), reason: 'daily limit (test)', detail: '' });
    }
  }
};

(async () => {
  fs.rmSync(tmpPids, { force: true });
  fs.rmSync(tmpCooldowns, { force: true });
  procs.writePidEntry();

  const started = [];
  m._test.setStartOverride((k, mo) => { started.push([k, mo]); });

  // ── 1) all combos blocked → park → the wake timer is armed ────────────────
  const far = Date.now() + 600 * 1000;
  blockAll(far);
  m._cooldowns.save();                       // persist, like production park state
  m._test.setRestarting(false);
  m._test.setStartPending(false);
  supervisor.parkOnCooldown(0, 0, 600 * 1000);
  t(m._test.isParkActive() === true, 'park arms the wake timer when every combo is cooling');
  const parkedUntil0 = procs.readPidFile()[TEST_PROJECT].parkedUntil;
  t(parkedUntil0 > Date.now() + 60 * 1000, `park advertises parkedUntil (~${Math.round((parkedUntil0 - Date.now()) / 60000)}m from now)`);

  // ── 2) refresh round with an unchanged grid → park stays untouched ────────
  m._test.parkRefresh();
  t(m._test.isParkActive() === true, 'refresh round: still all cooling → stays parked');
  t(started.length === 0, 'refresh round: no connector started while still blocked');
  t(procs.readPidFile()[TEST_PROJECT].parkedUntil === parkedUntil0, 'refresh round: wake unchanged (no re-arm churn)');

  // ── 3) a combo frees early → refresh round EXITS the park and starts on it ─
  m.blockedCombos.delete('0:0');             // simulate peer clearing / record healing
  m._cooldowns.save();
  m._test.parkRefresh();
  t(m._test.isParkActive() === false, 'refresh round: combo freed early → leaves park');
  t(started.length === 1 && started[0][0] === 0 && started[0][1] === 0,
    `refresh round: started on the freed combo key #${(started[0] && started[0][0]) ?? '-'} / model #${(started[0] && started[0][1]) ?? '-'} (expected 0:0)`);

  // ── 4) peers move earliest earlier → refresh round re-arms the wake ───────
  started.length = 0;
  blockAll(far);                             // park again at the far wake
  m._cooldowns.save();
  m._test.setRestarting(false);
  m._test.setStartPending(false);
  supervisor.parkOnCooldown(0, 0, 600 * 1000);
  const parkedUntil1 = procs.readPidFile()[TEST_PROJECT].parkedUntil;
  // Shorten the earliest block (was now+600s → now+120s) so a fresh scan sees
  // an earlier unblock than the armed wake.
  const sooner = Date.now() + 120 * 1000;
  blockAll(sooner);
  m._cooldowns.save();
  m._test.parkRefresh();
  const parkedUntil2 = procs.readPidFile()[TEST_PROJECT].parkedUntil;
  t(m._test.isParkActive() === true, 'refresh round: still all cooling → stays parked (case 4)');
  t(parkedUntil2 < parkedUntil1, `refresh round: earlier unblock re-arms the wake (${Math.round((parkedUntil2 - Date.now()) / 60000)}m vs ${Math.round((parkedUntil1 - Date.now()) / 60000)}m)`);

  m._test.clearParkMonitor();
  m._test.setStartOverride(null);
  const line = `${pass} passed, ${fail} failed`;
  process.stdout.write(`\n${'.'.repeat(line.length)}\n${line}\n${'.'.repeat(line.length)}\n`);
  fs.rmSync(tmpPids, { force: true });
  fs.rmSync(tmpCooldowns, { force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });