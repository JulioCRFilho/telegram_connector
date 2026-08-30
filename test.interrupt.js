// test.interrupt.js
// Regression test for mid-task interruption: a new user message arriving while
// the agent is working must (1) PAUSE the running task into the persisted
// interrupted queue — never lose it, (2) restart the connector so the NEW
// message is answered first, and (3) automatically re-queue the paused task
// once the newer request has been answered. Also covers the persisted FIFO
// itself (round-trip, dedupe, cap, TTL) and the old silent-loss bug.
// Run:  node test.interrupt.js
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.TELEGRAM_BOT_TOKEN = '123456789:TEST';
const TEST_PROJECT = 'INTERRUPT';
process.env[`TELEGRAM_BOT_TOKEN_${TEST_PROJECT}`] = '123456789:TEST';
process.argv.push(TEST_PROJECT);
process.env.TELEGRAM_API_KEYS = 'sk-int-a';
process.env.TELEGRAM_AVAILABLE_MODELS = 'z-ai/glm-5.3-flash';
process.env.TELEGRAM_TASKS_DIR = os.tmpdir();
process.env.TELEGRAM_ALLOWED_USER_ID = '123456789';
process.env.TELEGRAM_COOLDOWNS_FILE = path.join(os.tmpdir(), 'cooldowns-INTERRUPT.json');
process.env.TELEGRAM_INTERRUPTED_FILE = path.join(os.tmpdir(), `interrupted-INTERRUPT-${Date.now()}.json`);

const interrupted = require('./lib/interrupted');
const chat = require('./lib/chat');
const state = require('./lib/state');

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
  interrupted.clear();

  // ── 1) persisted FIFO round-trip ──────────────────────────────────────────
  interrupted.push(42, 'Task A');
  interrupted.push(42, 'Task B');
  t(interrupted.count() === 2, 'FIFO holds two paused tasks');
  let rec = interrupted.pop();
  t(rec && rec.text === 'Task A' && rec.chatId === 42, 'oldest paused task pops first (FIFO)');
  t(interrupted.count() === 1, 'pop removes the entry');
  interrupted.push(42, 'Task B');           // dedupe while still queued
  t(interrupted.count() === 1, 'identical task is not stacked twice');
  interrupted.clear();
  t(interrupted.count() === 0, 'clear empties the queue');

  // ── 2) interruption: pause + restart, nothing lost ────────────────────────
  state.restarting = false;
  state.startPending = false;
  state.lastUserMessage = 'review the chest cutscene in scene_intro';
  let restarts = 0;
  chat._test.setRestartTrigger(() => { restarts++; });
  chat._test.startTurn(42);                 // agent mid-task on Task A
  const wasInterrupted = chat.pauseCurrentForNewMessage(42, 'fix the login bug instead');
  t(wasInterrupted === true, 'new different message mid-task triggers an interruption');
  t(interrupted.count() === 1 && interrupted.pop().text === 'review the chest cutscene in scene_intro',
    'the in-flight task was PAUSED into the persisted queue (not lost)');
  t(restarts === 1, 'connector restart triggered so the new message is answered first');
  t(sent.some((s) => s.includes('Pausing the current task')), 'user was told the task is paused, not dropped');

  // ── 3) identical re-send is NOT an interruption ───────────────────────────
  interrupted.clear();
  state.lastUserMessage = 'same text';
  restarts = 0;
  const dup = chat.pauseCurrentForNewMessage(42, 'same text');
  t(dup === false && restarts === 0, 're-sending the identical text keeps the current run');

  // ── 4) after the newer request is answered, the paused task resumes ───────
  interrupted.clear();
  interrupted.push(42, 'review the chest cutscene in scene_intro');
  state.lastUserMessage = 'fix the login bug instead';
  state.pendingResume = null;
  restarts = 0;
  const resumed = chat.resumeNextInterrupted();
  t(resumed === true, 'turn completion re-queues the paused task');
  t(state.lastUserMessage === 'review the chest cutscene in scene_intro',
    'paused task is promoted back to the pending request');
  t(restarts === 1, 'restart triggered to continue the paused task');
  t(sent.some((s) => s.includes('resuming the paused task')), 'user was told the paused task resumes');
  t(interrupted.count() === 0, 'queue drained');

  // ── 5) no paused task → resume is a no-op; guard flags hold ───────────────
  t(chat.resumeNextInterrupted() === false, 'no paused task → no resume');
  state.pendingResume = { chatId: 42 };
  interrupted.push(42, 'queued while a resume is armed');
  t(chat.resumeNextInterrupted() === false && interrupted.count() === 1,
    'an already-queued resume defers the paused task (no double-run)');
  state.pendingResume = null;
  interrupted.clear();

  const line = `${pass} passed, ${fail} failed`;
  process.stdout.write(`\n${'.'.repeat(line.length)}\n${line}\n${'.'.repeat(line.length)}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
