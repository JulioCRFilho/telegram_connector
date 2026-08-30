// test.timeout-rotation.js
// Regression test for the "stuck on a timing-out combo" bug: cline's
// telegram-connect bridge fails turns with "The operation timed out." — a
// message that matches NO pattern in LIMIT_RE, so the wrapper never rotated.
// Observed live: 3 consecutive timeouts on key #2 / z-ai over 40 min, each
// turn acked with "On it" + "Still working after 5 min", every message
// silently dropped, no rotation.
//
// Fix under test: a TIMEOUT_RE branch in logs.js → supervisor.onTimeoutSignal,
// which (1) blocks ONLY the current combo with a SHORT cooldown (timeouts are
// transient, unlike daily-limit 429s), (2) rotates to the next combo, (3)
// escalates the cooldown after repeated consecutive strikes, (4) dedupes the
// bridge's double-logged failure ("reply failed" + "turn handling failed").
// Run:  node test.timeout-rotation.js
process.env.TELEGRAM_BOT_TOKEN = '123456789:TEST';
const TEST_PROJECT = process.argv[2] || 'TOSIM';
if (!process.argv[2]) process.argv.push(TEST_PROJECT);
process.env[`TELEGRAM_BOT_TOKEN_${TEST_PROJECT}`] = '123456789:TEST';
process.env.TELEGRAM_API_KEYS = 'sk-timeout-a, sk-timeout-b';
process.env.TELEGRAM_AVAILABLE_MODELS = 'z-ai/glm-5.3-flash, deepseek/deepseek-v4-flash';
process.env.TELEGRAM_RESTART_DELAY_MS = '30';
process.env.TELEGRAM_PROBE_HTTP = '1';
process.env.TELEGRAM_API_BASE = 'https://mock-provider.test';
process.env.TELEGRAM_TASKS_DIR = require('os').tmpdir();
process.env.TELEGRAM_ALLOWED_USER_ID = '123456789';
process.env.PATH = '';
const fs = require('fs');
const tmpCooldowns = require('path').join(require('os').tmpdir(), 'cooldowns-TOSIM.json');
process.env.TELEGRAM_COOLDOWNS_FILE = tmpCooldowns;

const m = require('./main.js');

const outLines = [];
console.log = (...a) => { outLines.push(a.join(' ')); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function t(cond, name) {
  if (cond) { pass++; process.stdout.write(`  ok - ${name}\n`); }
  else { fail++; process.stdout.write(`  FAIL - ${name}\n`); }
}

// The exact line shape the bridge writes (verified against the live cline.log).
const TIMEOUT_LINE = JSON.stringify({
  level: 50, time: new Date().toISOString(), pid: 88116, hostname: 'test',
  name: 'cline.cli', component: 'telegram-connect', transport: 'telegram',
  threadId: 'telegram:8844466799',
  err: { type: 'Error', message: 'The operation timed out.' },
  msg: 'Telegram turn handling failed',
});

(async () => {
  fs.rmSync(tmpCooldowns, { force: true });   // clean grid
  const started = [];
  m._test.setStartOverride((i, mi) => { started.push([i, mi]); });

  // ── 1) first timeout: current combo blocked SHORT, rotation fires ────────
  outLines.length = 0;
  m.onTimeoutSignal(TIMEOUT_LINE);
  t(m.getTimeoutStrikes() === 1, 'first timeout registers strike 1');
  t(/timeout cooldown 180s/.test(outLines.join('\n')), 'short 3-minute timeout cooldown applied (not a 429-style multi-hour block)');
  const rec = m.blockedCombos.get('0:0');
  t(rec && /timeout/.test(rec.reason || ''), 'the timed-out combo is blocked with a timeout reason');
  await sleep(400);   // let the scheduled restart's probe+start (mocked) land
  t(started.length === 1 && (started[0][0] !== 0 || started[0][1] !== 0), `rotated OFF the timing-out combo (started ${JSON.stringify(started)})`);

  // ── 2) bridge double-logs the failure → deduped, no second reaction ──────
  const startedAfterDedupe = started.length;
  m.onTimeoutSignal(TIMEOUT_LINE);            // "Telegram reply failed" twin, <5s later
  t(m.getTimeoutStrikes() === 1 && started.length === startedAfterDedupe, 'duplicate timeout line within the 5s window is ignored (bridge double-log)');

  // ── 3) repeated timeouts (new incidents) escalate the cooldown ───────────
  m._test.setLastLimitHandledAt(0);           // leave the dedupe window
  m.onTimeoutSignal(TIMEOUT_LINE);            // strike 2
  t(m.getTimeoutStrikes() === 2, 'second timeout incident → strike 2');
  m._test.setLastLimitHandledAt(0);
  outLines.length = 0;
  m.onTimeoutSignal(TIMEOUT_LINE);            // strike 3 → escalated
  t(m.getTimeoutStrikes() === 3, 'third consecutive timeout → strike 3');
  t(/escalated/.test(outLines.join('\n')), 'escalated after 3 consecutive strikes');
  t(/timeout cooldown 900s/.test(outLines.join('\n')), 'escalated cooldown is 15 minutes');

  // ── 4) a completed turn clears the strike counter ─────────────────────────
  m.clearTimeoutStrikes();
  t(m.getTimeoutStrikes() === 0, 'clearTimeoutStrikes resets the counter (healthy turn observed)');

  console.log = console.log; // keep captured logging through teardown
  const line = `${pass} passed, ${fail} failed`;
  process.stdout.write(`\n${'.'.repeat(line.length)}\n${line}\n${'.'.repeat(line.length)}\n`);
  fs.rmSync(tmpCooldowns, { force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
