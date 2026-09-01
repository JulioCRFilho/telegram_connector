// test.context-overflow.js
// Regression test for session-context overflow. When the connector's
// accumulated thread exceeds the model's context window (poolside rejected a
// turn with "Input length 273636 exceeds the maximum allowed input length of
// 262112 tokens"), the wrapper must:
//   • NOT treat it as a rate limit (the generic "inference request failed"
//     substring inside the error also matches LIMIT_RE — classification ORDER
//     matters): a perfectly healthy combo must NOT be blocked for a cooldown;
//   • queue the unanswered message + drive it through a FRESH hub session
//     (pendingResume) so the retry has zero accumulated context;
//   • restart the connector on the SAME combo (nothing is exhausted);
//   • dedupe the bridge's double-logged failure and keep a strike counter.
// Run:  node test.context-overflow.js
const TEST_PROJECT = 'CTXDUN';
process.argv.push(TEST_PROJECT);
process.env.TELEGRAM_BOT_TOKEN = '123456789:TEST';
process.env[`TELEGRAM_BOT_TOKEN_${TEST_PROJECT}`] = '123456789:TEST';
process.env.TELEGRAM_API_KEYS = 'sk-ctx-a, sk-ctx-b, sk-ctx-c';
process.env.TELEGRAM_AVAILABLE_MODELS = 'z-ai/glm-5.3-flash, deepseek/deepseek-v4-flash, poolside/laguna-s-2.1:free';
process.env.TELEGRAM_MODEL_PRIORITY = 'z-ai/glm-5.3-flash, deepseek/deepseek-v4-flash';
process.env.TELEGRAM_RESTART_DELAY_MS = '30';
process.env.TELEGRAM_PROBE_ENABLED = '0';
process.env.TELEGRAM_PROBE_HTTP = '1';
process.env.TELEGRAM_API_BASE = 'https://mock-provider.test';
process.env.TELEGRAM_MAX_SESSION_MS = '0';     // disable the idle-recycle for this test process
const os = require('os');
const fs = require('fs');
const path = require('path');
const tmpState = path.join(os.tmpdir(), `state-${TEST_PROJECT}-${process.pid}.json`);
const tmpCooldowns = path.join(os.tmpdir(), `cooldowns-${TEST_PROJECT}-${process.pid}.json`);
const tmpPids = path.join(os.tmpdir(), `pids-${TEST_PROJECT}-${process.pid}.json`);
process.env.TELEGRAM_STATE_FILE = tmpState;
process.env.TELEGRAM_COOLDOWNS_FILE = tmpCooldowns;
process.env.TELEGRAM_PIDS_FILE = tmpPids;
process.env.TELEGRAM_TASKS_DIR = os.tmpdir();
process.env.TELEGRAM_ALLOWED_USER_ID = '123456789';
process.env.PATH = '';

const m = require('./main.js');
const supervisor = require('./lib/supervisor');
const config = require('./lib/config');
const state = require('./lib/state');

let pass = 0, fail = 0;
function t(cond, name) {
  if (cond) { pass++; process.stdout.write(`  ok - ${name}\n`); }
  else { fail++; process.stdout.write(`  FAIL - ${name}\n`); }
}

// The EXACT error shape from the stalled turn in the live chat (poolside:
// provider 400 -> raw metadata carries the input-length message).
const POOLSIDE_CTX_LINE = JSON.stringify({
  msg: "Telegram bridge error: {\"error\":{\"message\":\"Failed to create stream: inference request failed: failed to generate stream from OpenRouter: failed to invoke model 'poolside/laguna-s-2.1:free' with streaming: request failed with status 400: Provider returned error — Input length 273636 exceeds the maximum allowed input length of 262112 tokens.\"}}",
  component: 'telegram-connect',
  botUserId: 'test',
  pid: process.pid,
});
// A plain daily-limit 429 that MUST keep routing to the quota path.
const DAILY_LIMIT_LINE = JSON.stringify({
  msg: "Telegram bridge error: {\"error\":{\"code\":\"INFERENCE_CAP_ERROR\",\"message\":\"Error 429: Daily free limit reached on model z-ai/glm-5.3-flash. Try again in 21h 33m\"}}",
  component: 'telegram-connect',
  botUserId: 'test',
  pid: process.pid,
});
(async () => {
  fs.rmSync(tmpState, { force: true });
  fs.rmSync(tmpCooldowns, { force: true });
  fs.rmSync(tmpPids, { force: true });
  m.blockedCombos.clear();
  state.curKeyIndex = 0; state.curModelIndex = 2;   // running on poolside
  state.lastContextHandledAt = 0;
  state.contextOverflowStrikes = 0;
  state.lastUserMessage = "rise the chest some more. Also, the player's hat is appearing in between the camera and the chest during the cutscene.";
  state.lastSeenChatId = '123456789';
  state.pendingResume = null;
  state.restartFromRotation = false;
  const started = [];
  supervisor._setStartOverride((k, mo) => started.push([k, mo]));

  // 1) classification ordering
  t(config.CONTEXT_MAX_RE.test(POOLSIDE_CTX_LINE), 'CONTEXT_MAX_RE matches the poolside input-length error');
  t(config.LIMIT_RE.test(POOLSIDE_CTX_LINE), 'LIMIT_RE ALSO matches it (via "inference request failed") — order matters');
  t(!config.CONTEXT_MAX_RE.test(DAILY_LIMIT_LINE), 'CONTEXT_MAX_RE does NOT match a plain daily-limit 429 (still a quota)');

  // 2) onContextOverflow: no combo block, fresh-session resume, same combo
  m.onContextOverflow(POOLSIDE_CTX_LINE);
  t(m.blockedCombos.size === 0, 'NO combo is blocked (context overflow is not a quota)');
  t(state.contextOverflowStrikes === 1, 'context-overflow strike counter incremented');
  t(!!state.pendingResume, 'a fresh hub session resume is queued (pendingResume set)');
  const persisted = JSON.parse(fs.readFileSync(tmpState, 'utf8'));
  t((persisted.items || []).some((r) => r.text.includes('rise the chest')), 'the unanswered message is persisted for the fresh-session retry');
  t(state.restarting === true, 'a restart has been scheduled');

  await new Promise((r) => setTimeout(r, 80));
  t(started.length === 1 && started[0][0] === 0 && started[0][1] === 2, 'restart targets the SAME combo (got ' + JSON.stringify(started) + ')');

  // 3) dedupe (bridge logs the failure twice)
  m.onContextOverflow(POOLSIDE_CTX_LINE);
  t(state.contextOverflowStrikes === 1, 'duplicate signal within the dedupe window is ignored (strikes still 1)');

  // 4) strike reset on a successful turn
  m.clearContextOverflowStrikes();
  t(state.contextOverflowStrikes === 0, 'clearContextOverflowStrikes resets the counter');

  // 5) helpers exist and idle-recycle is safely disableable
  t(typeof m.startIdleRecycle === 'function' && typeof config.MAX_SESSION_MS === 'number', 'startIdleRecycle + MAX_SESSION_MS wiring present');
  t(config.MAX_SESSION_MS === 0, 'TELEGRAM_MAX_SESSION_MS=0 disables the idle recycle for this test');

  fs.rmSync(tmpState, { force: true });
  fs.rmSync(tmpCooldowns, { force: true });
  fs.rmSync(tmpPids, { force: true });
  const line = `${pass} passed, ${fail} failed`;
  process.stdout.write(`\n${'.'.repeat(line.length)}\n${line}\n${'.'.repeat(line.length)}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });