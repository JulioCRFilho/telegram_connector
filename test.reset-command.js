// test.reset-command.js
// Regression test for the /reset chat command: it must zero EVERY key×model
// cooldown record (in-memory map AND persisted agents.cooldowns.json), clear
// the in-memory model-limit marks, wake a PARKED wrapper immediately (probe a
// fresh combo instead of sleeping out the cooldown), and reply with a
// confirmation that says how many records were cleared.
// Run:  node test.reset-command.js
const TEST_PROJECT = 'RESETT';
process.argv.push(TEST_PROJECT);
process.env.TELEGRAM_BOT_TOKEN = '123456789:TEST';
process.env[`TELEGRAM_BOT_TOKEN_${TEST_PROJECT}`] = '123456789:TEST';
process.env.TELEGRAM_API_KEYS = 'sk-x-a, sk-x-b';
process.env.TELEGRAM_AVAILABLE_MODELS = 'z-ai/glm-5.3-flash, deepseek/deepseek-v4-flash';
process.env.TELEGRAM_MODEL_PRIORITY = 'z-ai/glm-5.3-flash, deepseek/deepseek-v4-flash';
process.env.TELEGRAM_RESTART_DELAY_MS = '30';
process.env.TELEGRAM_PROBE_ENABLED = '0';     // start is a synchronous doStart → deterministic override capture
process.env.TELEGRAM_PROBE_HTTP = '1';
process.env.TELEGRAM_API_BASE = 'https://mock-provider.test';
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
const supervisor = require('./lib/supervisor');   // same configured instance (module cache)
const chat = require('./lib/chat');
const cooldowns = require('./lib/cooldowns');

let pass = 0, fail = 0;
function t(cond, name) {
  if (cond) { pass++; process.stdout.write(`  ok - ${name}\n`); }
  else { fail++; process.stdout.write(`  FAIL - ${name}\n`); }
}
const KEY_CNT = 2, MODEL_CNT = 2;
const blockAll = (unblockAt) => {
  for (let k = 0; k < KEY_CNT; k++) {
    for (let mo = 0; mo < MODEL_CNT; mo++) {
      m.blockedCombos.set(`${k}:${mo}`, { unblockAt, blockedAt: Date.now(), cooldownMs: Math.max(unblockAt - Date.now(), 1000), reason: 'daily limit (test)', detail: '' });
    }
  }
};

(async () => {
  fs.rmSync(tmpCooldowns, { force: true });
  fs.rmSync(tmpPids, { force: true });
  m.blockedCombos.clear();
  const started = [];
  supervisor._setStartOverride((k, mo) => started.push([k, mo]));

  // ── 1) resetAll zeroes memory, marks, AND the persisted file ───────────────
  blockAll(Date.now() + 5 * 3600 * 1000);
  const st = require('./lib/state');
  st.modelLimitHit.add(0);
  st.modelLimitHit.add(1);
  cooldowns.save();                       // put records on disk
  t(m.blockedCombos.size === 4, 'grid seeded with 4 blocked combos');
  const cleared = cooldowns.resetAll();
  t(cleared === 4, `resetAll() returned the cleared count (got ${cleared})`);
  t(m.blockedCombos.size === 0, 'in-memory grid is empty after reset');
  t(st.modelLimitHit.size === 0, 'in-memory model-limit marks are cleared');
  t(JSON.stringify(JSON.parse(fs.readFileSync(tmpCooldowns, 'utf8'))) === '{}', 'persisted cooldowns file is `{}` after reset');
  const rec2 = cooldowns.resetAll();
  t(rec2 === 0 && JSON.stringify(JSON.parse(fs.readFileSync(tmpCooldowns, 'utf8'))) === '{}', 'second reset is a no-op and stays clean');

  // ── 2) parked wrapper wakes and starts a fresh combo on /reset ─────────────
  blockAll(Date.now() + 5 * 3600 * 1000);
  supervisor.parkOnCooldown(0, 0, 5 * 3600 * 1000);   // park as if every combo is cooling
  t(supervisor._isParkActive(), 'wrapper is parked before /reset');
  supervisor.resetAndWake();
  await new Promise((r) => setTimeout(r, 150));       // RESTART_DELAY_MS = 30ms
  t(!supervisor._isParkActive(), 'park was cleared by the reset');
  t(started.length === 1 && started[0][0] === 0 && started[0][1] === 0, `woken wrapper probed the top-priority combo (got ${JSON.stringify(started)})`);
  supervisor.clearParkMonitor();
  supervisor._setStartOverride(null);

  // ── 3) the chat command replies with a human confirmation ──────────────────
  m.blockedCombos.clear();
  blockAll(Date.now() + 5 * 3600 * 1000);
  const replies = [];
  const origSend = chat.sendTelegramMessage;
  chat.sendTelegramMessage = async (id, text) => { replies.push(text); return true; };
  const reply = chat.handleResetCommand();
  chat.sendTelegramMessage = origSend;
  t(/Cleared 4 cooldown record/.test(reply), `reply states the cleared count (got "${reply.slice(0, 60)}…")`);
  t(/2 key\(s\) × 2 model\(s\)/.test(reply), 'reply names the full key×model matrix');
  t(m.blockedCombos.size === 0, 'grid is empty after the command ran');

  const line = `${pass} passed, ${fail} failed`;
  process.stdout.write(`\n${'.'.repeat(line.length)}\n${line}\n${'.'.repeat(line.length)}\n`);

  // ── 4) the standalone CLI (reset-grid.js) works with NO agent ──────────────
  // Run as a child process against the same temp files: it must zero the grid
  // file and nudge the (registered, live) test process via SIGUSR2. The SIGUSR2
  // handler registered by supervisor is what a real wrapper runs.
  const { spawnSync } = require('child_process');
  blockAll(Date.now() + 5 * 3600 * 1000);
  cooldowns.save();
  fs.writeFileSync(tmpPids, JSON.stringify({ RESETT: { pid: process.pid, instance: 'RESETT' } }));
  const res = spawnSync(process.execPath, [path.join(__dirname, 'reset-grid.js')], { encoding: 'utf8' });
  t(res.status === 0, `reset-grid.js exits 0 (got ${res.status})`);
  t(/Cleared 4 cooldown record/.test(res.stdout), `CLI reports the cleared count (got: ${(res.stdout || '').trim().split('\n')[0]})`);
  t(JSON.stringify(JSON.parse(fs.readFileSync(tmpCooldowns, 'utf8'))) === '{}', 'CLI zeroes the persisted grid file');
  t(/nudged RESETT/.test(res.stdout), 'CLI nudges the live wrapper registered in agents.pids.json');
  await new Promise((r) => setTimeout(r, 150));
  t(m.blockedCombos.size === 0, 'SIGUSR2 nudge cleared the running wrapper in-memory grid too');

  fs.rmSync(tmpCooldowns, { force: true });
  fs.rmSync(tmpPids, { force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
