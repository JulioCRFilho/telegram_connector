// test.health-feedback.js
// Regression test for the 10-minute health-check feedback: while a turn is
// active the user gets an explicit "alive and working" line every 10 min of
// working — on the clock, independent of task-list movement — including an
// honest connector status. The timer must be created on startTurn and cleared
// on stopTurn (no leaked intervals, no messages after the turn ends).
// Run:  node test.health-feedback.js
const os = require('os');
const path = require('path');

process.env.TELEGRAM_BOT_TOKEN = '123456789:TEST';
const TEST_PROJECT = 'HEALTHFB';
process.env[`TELEGRAM_BOT_TOKEN_${TEST_PROJECT}`] = '123456789:TEST';
process.argv.push(TEST_PROJECT);
process.env.TELEGRAM_API_KEYS = 'sk-hfb-a';
process.env.TELEGRAM_AVAILABLE_MODELS = 'z-ai/glm-5.3-flash';
process.env.TELEGRAM_STATE_FILE = path.join(os.tmpdir(), `state-healthfb-${Date.now()}.json`);
process.env.TELEGRAM_TASKS_DIR = os.tmpdir();
process.env.TELEGRAM_ALLOWED_USER_ID = '123456789';
process.env.TELEGRAM_COOLDOWNS_FILE = path.join(os.tmpdir(), `cooldowns-HEALTHFB-${Date.now()}.json`);

const chat = require('./lib/chat');

let pass = 0, fail = 0;
function t(cond, name) {
  if (cond) { pass++; process.stdout.write(`  ok - ${name}\n`); }
  else { fail++; process.stdout.write(`  FAIL - ${name}\n`); }
}
const sent = [];
global.fetch = async (_url, opts) => {
  sent.push(JSON.parse(opts.body).text);
  return { ok: true, json: async () => ({ ok: true }) };
};

(async () => {
  // ── 1) the feedback text itself ────────────────────────────────────────────
  t(chat.healthFeedbackText(10, 3, 8, true) === '🩺 Health check — 10 min in, still on it (3/8 tasks done). connector alive.',
    'alive + progress renders tasks done and connector status');
  t(chat.healthFeedbackText(20, -1, 0, true) === '🩺 Health check — 20 min in, still on it. connector alive.',
    'no task list → no fabricated progress numbers');
  t(/reconnecting in the background/.test(chat.healthFeedbackText(30, 1, 8, false)),
    'connector down → honest "reconnecting" wording, never a fake alive claim');

  // ── 2) timer lifecycle: created on startTurn, cleared on stopTurn ─────────
  chat._test.startTurn(42);
  t(chat._test.hasHealthTimer(), 'startTurn arms the 10-min health-check timer');
  chat._test.stopTurn();
  t(!chat._test.hasHealthTimer(), 'stopTurn clears the health-check timer (no leaks, no post-turn messages)');

  // ── 3) the tick sends to the right chat with real progress ────────────────
  chat._test.startTurn(77);
  sent.length = 0;
  chat._test.healthTick();                  // manual fire — the interval itself is 10 real minutes
  t(sent.length === 1, `health tick sends exactly one message (got ${sent.length})`);
  t(/🩺 Health check — \d+ min in/.test(sent[0]), `message is the health-check format (got: ${sent[0]})`);
  t(/still on it/.test(sent[0]), 'message carries the alive-and-working wording');
  chat._test.stopTurn();

  // ── 4) after stopTurn the tick is a no-op (no message, no crash) ──────────
  sent.length = 0;
  chat._test.healthTick();
  t(sent.length === 0, 'health tick after turn end is a silent no-op');

  const line = `${pass} passed, ${fail} failed`;
  process.stdout.write(`\n${'.'.repeat(line.length)}\n${line}\n${'.'.repeat(line.length)}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
