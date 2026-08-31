// test.resume-memory.js
// Regression tests for pending-task memory: a fresh hub-resume session has NO
// conversation history, so the wrapper must (a) persist a progress dossier
// alongside the unanswered message, (b) inject it into the resume prompt, and
// (c) NOT clear the pending record after a "successful" but empty resumed run
// (that wipe was why the agent "never remembered" pending tasks).
// Run:  node test.resume-memory.js
process.env.TELEGRAM_BOT_TOKEN = '123456789:TEST';
const TEST_PROJECT = process.argv[2] || 'RESUMEMEM';
if (!process.argv[2]) process.argv.push(TEST_PROJECT);
process.env[`TELEGRAM_BOT_TOKEN_${TEST_PROJECT}`] = '123456789:TEST';
process.env.TELEGRAM_API_KEYS = 'sk-mem-a';
process.env.TELEGRAM_AVAILABLE_MODELS = 'z-ai/glm-5.3-flash';
process.env.TELEGRAM_STATE_FILE = require('path').join(require('os').tmpdir(), `state-${TEST_PROJECT}-${Date.now()}.json`);
process.env.TELEGRAM_TASKS_DIR = require('os').tmpdir();
process.env.TELEGRAM_ALLOWED_USER_ID = '123456789';
const fs = require('fs');
const path = require('path');

const m = require('./main.js');
const lastmessage = require('./lib/lastmessage');
const { genericResumePrompt, _test: resumeTest } = require('./lib/resume');
const resume = require('./lib/resume');
const rotation = require('./lib/rotation');

let pass = 0, fail = 0;
function t(cond, name) {
  if (cond) { pass++; process.stdout.write(`  ok - ${name}\n`); }
  else { fail++; process.stdout.write(`  FAIL - ${name}\n`); }
}

(async () => {
  const f = process.env.TELEGRAM_STATE_FILE;
  fs.rmSync(f, { force: true });

  // ── 1) STATE_FILE env override is honored (no repo pollution) ─────────────
  t(f.includes('RESUMEMEM') && !f.startsWith(path.dirname(__dirname)), 'TELEGRAM_STATE_FILE override is respected');

  // ── 2) dossier: noteProgress keeps a ring, save persists it ───────────────
  // Real-world order: the message arrives (save), THEN the connector narrates
  // progress (noteProgress) while the record is pending. save() with no
  // explicit dossier must RESET the ring — a new task must never inherit the
  // previous task's narration.
  lastmessage.noteProgress('STALE line from the PREVIOUS task must not survive the new save');
  lastmessage.save(42, 'review the chest cutscene in scene_intro');
  t(lastmessage.dossierSnapshot().length === 0, 'saving a new message starts an empty ring (no cross-task inheritance)');
  lastmessage.noteProgress('Working on the chest cutscene in scene_intro');
  lastmessage.noteProgress('[Rotator] internal line must be skipped');
  lastmessage.noteProgress('Placed the chest at world origin');
  lastmessage.noteProgress(JSON.stringify({ level: 'info', msg: 'Edited scene_intro.dart: chest grows while spinning', sessionId: 's1' }));
  await new Promise((r) => setTimeout(r, 2300));   // dossier flush is 2s (debounced)
  const rec = lastmessage.load();
  t(!!rec && rec.text === 'review the chest cutscene in scene_intro', 'pending message persists');
  t(Array.isArray(rec.dossier) && rec.dossier.length === 3, `dossier keeps 3 task lines (got ${rec.dossier && rec.dossier.length})`);
  t(rec.dossier.every((l) => !l.startsWith('[Rotator]')), 'internal [Rotator] lines are excluded from the dossier');
  t(rec.dossier.some((l) => l.includes('chest grows while spinning')), 'JSON log records are distilled to their human .msg text');
  t(rec.dossier.every((l) => !l.trim().startsWith('{')), 'raw JSON never lands in the dossier');

  // ── 3) dossier attach-on-progress: noteProgress rewrites the record ───────
  lastmessage.noteProgress('Cutscene camera now focuses the chest');
  await new Promise((r) => setTimeout(r, 2300));   // dossier flush is 2s
  const rec2 = lastmessage.load();
  t(rec2.dossier.length === 4 && rec2.dossier[3].includes('Cutscene camera'), 'noteProgress attaches later progress to the persisted record');

  // ── 4) resume prompt carries the memory ───────────────────────────────────
  const prompt = genericResumePrompt(rec2.text, rec2.dossier);
  t(prompt.includes('review the chest cutscene in scene_intro'), 'prompt quotes the user request');
  t(prompt.includes('Cutscene camera now focuses the chest'), 'prompt includes the progress dossier');
  t(genericResumePrompt('x', []).includes('•') === false, 'empty dossier adds no excerpt');

  // ── 4b) paused-task promotion restores the dossier ────────────────────────
  // The interrupt path: pause captures the ring into the queue entry, and the
  // promotion must write it back into the pending record (this was the hole
  // that made the resumed agent answer the bare message with zero context).
  const paused = lastmessage.dossierSnapshot();
  t(paused.length === 4, `dossierSnapshot returns the full ring (got ${paused.length})`);
  lastmessage.save(42, 'a brand-new request interrupts');   // new task → ring resets
  t(lastmessage.dossierSnapshot().length === 0, 'saving a NEW message clears the ring (no cross-task contamination)');
  // Promotion (chat.resumeNextInterrupted) re-saves the paused task with
  // { front: true }: it arrived first, so it must become the FIFO head again.
  lastmessage.save(42, 'review the chest cutscene in scene_intro', paused, { front: true });
  const rec3 = lastmessage.load();
  t(rec3.text === 'review the chest cutscene in scene_intro', 'promoted paused task becomes the FIFO head again');
  t(rec3.dossier.length === 4 && rec3.dossier[3].includes('Cutscene camera'), 'promotion (save with explicit dossier) restores the paused task narration');
  const promotedPrompt = genericResumePrompt(rec3.text, rec3.dossier);
  t(promotedPrompt.includes('chest grows while spinning'), 'promoted resume prompt carries the prior run context');

  // ── 5) clear works and load returns null afterwards ───────────────────────
  lastmessage.clear();
  t(lastmessage.load() === null, 'clear removes the record');

  // ── 6) session topics mined from the cline log ────────────────────────────
  // The shared cline.log records every turn (textPreview / outputPreview, per
  // threadId) — a durable transcript the resume prompt can hand to the fresh
  // session so it continues the real topics instead of asking the user to
  // repeat themselves (the "what did you mean?" burn we saw live).
  const tmpLog = path.join(require('os').tmpdir(), `clinetopics-${process.pid}.log`);
  const mk = (chat, msg, key, text) => JSON.stringify({
    level: 30, time: new Date().toISOString(), name: 'cline.cli',
    component: 'telegram-connect', transport: 'telegram',
    threadId: `telegram:${chat}`, msg, [key]: text,
  });
  fs.writeFileSync(tmpLog, [
    mk(111, 'Telegram message received', 'textPreview', 'what is our last session?'),
    mk(111, 'Telegram reply completed', 'outputPreview', 'We were profiling the Flutter scene; last round measured 58fps.'),
    mk(222, 'Telegram message received', 'textPreview', 'ANOTHER USER SHOULD NEVER LEAK'),
    mk(111, 'Telegram message received', 'textPreview', 'sounded very performatic'),
    'not json at all',
    mk(111, 'Telegram message received', 'textPreview', 'sounded very performatic'), // double-log dedupe
  ].join('\n'));
  process.env.TELEGRAM_CLINE_LOG_FILE = tmpLog;
  const topics = lastmessage.collectSessionTopics(111);
  t(topics.length === 3, `mines 3 topics for chat 111 (got ${topics.length})`);
  t(topics.some((t) => t.includes('what is our last session?')), 'user topics included');
  t(topics.some((t) => t.startsWith('you replied:') && t.includes('58fps')), 'agent reply topics included');
  t(!topics.some((t) => t.includes('ANOTHER USER')), "other chats' topics never leak");
  t(lastmessage.collectSessionTopics(999).length === 0, 'unknown chat yields no topics');
  const topicsPrompt = genericResumePrompt('sounded very performatic', [], topics);
  t(topicsPrompt.includes('Recent conversation topics') && topicsPrompt.includes('58fps'), 'resume prompt embeds the mined topics');
  t(!genericResumePrompt('x', [], []).includes('Recent conversation topics'), 'no topics → prompt unchanged');

  // ── 7) short/long cycle classification (the dropped-message bug) ──────────
  // A quoted cooldown of minutes ("Try again in 3m"/"16m") is a rolling quota
  // window: it must be classified as short-cycle (park + auto-retry, never
  // burning the give-up guard). Hour-scale daily limits (21h 33m) are NOT
  // short-cycle — they are LONG windows and must block the whole model.
  t(resumeTest.isShortCycleOf('resumed run failed: {"error":{"code":"INFERENCE_CAP_ERROR","message":"Error 429: Daily free limit reached on model z-ai/glm-5.3-flash. Try again in 16m"}}'), 'a quoted 16m cooldown is short-cycle (park + retry)');
  t(resumeTest.isShortCycleOf('Error 429: Daily free limit reached on model z-ai/glm-5.3-flash. Try again in 3m'), 'a quoted 3m cooldown is short-cycle');
  t(resumeTest.isShortCycleOf('Error 429: Daily free limit reached. Try again in 59m'), 'a quoted 59m cooldown is short-cycle (just under the 1h bound)');
  t(resumeTest.isShortCycleOf('Error 429: rate limit, no retry window quoted'), 'an UNQUOTED rate limit defaults to short-cycle (15m park)');
  t(rotation.isLongQuotedWindow(rotation.parseCooldownMs('Try again in 21h 33m')), 'a quoted 21h 33m window IS long (model-wide daily limit)');
  t(rotation.isLongQuotedWindow(rotation.parseCooldownMs('Try again in 14h 8m')), 'a quoted 14h 8m window IS long (model-wide daily limit)');
  t(!rotation.isShortQuotedWindow(rotation.parseCooldownMs('Try again in 14h 8m')), 'a quoted 14h is NOT short');
  t(!resumeTest.isShortCycleOf('Error 429: Daily free limit reached on model z-ai/glm-5.3-flash. Try again in 14h 8m'), 'a quoted 14h cooldown is NOT short-cycle (it is the long/model-wide path)');
  const blAt = rotation.blockModel(0, rotation.parseCooldownMs('Try again in 21h 33m'), 'daily limit (model-wide)', 'test');
  t(blAt > Date.now() && m.comboUnblockAt(0, 0) > Date.now() && m.blockedCombos.has('0:0'), 'blockModel blocks the model (all its key records) until the quoted time');

  // ── 8) lossless FIFO — the "progress?" overwrite bug ──────────────────────
  // The chest task is pending when the user sends "progress?". The old single
  // slot made the second save REPLACE the first — the real task was silently
  // erased and a blank session answered "progress?". Now both must survive,
  // FIFO order must hold, and removing the answered one keeps the real task.
  lastmessage.clear();                                  // start from an empty queue
  lastmessage.save(8844466799, 'the chest must rotate in any direction');
  lastmessage.save(8844466799, 'progress?');            // must QUEUE, not overwrite
  t(lastmessage.count() === 2, 'a second message queues behind the pending task instead of overwriting it');
  let head = lastmessage.load();
  t(head.text === 'the chest must rotate in any direction', 'FIFO head is the OLDEST message (the real task)');
  lastmessage.clearOne(8844466799, 'progress?');        // the quick "progress?" reply completed
  t(lastmessage.count() === 1, 'clearOne removes ONLY the answered message');
  head = lastmessage.load();
  t(head && head.text === 'the chest must rotate in any direction', 'the real task SURVIVES the follow-up being answered');
  lastmessage.clearOne(8844466799, 'progress?');        // clearing an unknown text must be a no-op
  t(lastmessage.count() === 1, 'clearOne with an unknown text removes nothing');
  // Legacy single-record file migrates on read instead of being lost.
  fs.writeFileSync(f, JSON.stringify({ chatId: 8844466799, text: 'legacy task', updatedAt: Date.now(), dossier: ['old note'] }));
  t(lastmessage.count() === 1 && lastmessage.load().text === 'legacy task' && lastmessage.load().dossier[0] === 'old note', 'legacy single-record state file migrates into the FIFO');
  lastmessage.clear();

  fs.rmSync(f, { force: true });
  fs.rmSync(tmpLog, { force: true });
  const line = `${pass} passed, ${fail} failed`;
  process.stdout.write(`\n${'.'.repeat(line.length)}\n${line}\n${'.'.repeat(line.length)}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
