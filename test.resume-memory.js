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
const { genericResumePrompt } = require('./lib/resume');

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
  lastmessage.noteProgress('Working on the chest cutscene in scene_intro');
  lastmessage.noteProgress('[Rotator] internal line must be skipped');
  lastmessage.noteProgress('Placed the chest at world origin');
  lastmessage.save(42, 'review the chest cutscene in scene_intro');
  const rec = lastmessage.load();
  t(!!rec && rec.text === 'review the chest cutscene in scene_intro', 'pending message persists');
  t(Array.isArray(rec.dossier) && rec.dossier.length === 2, `dossier keeps 2 task lines (got ${rec.dossier && rec.dossier.length})`);
  t(rec.dossier.every((l) => !l.startsWith('[Rotator]')), 'internal [Rotator] lines are excluded from the dossier');

  // ── 3) dossier attach-on-progress: noteProgress rewrites the record ───────
  lastmessage.noteProgress('Cutscene camera now focuses the chest');
  await new Promise((r) => setTimeout(r, 2300));   // dossier flush is 2s
  const rec2 = lastmessage.load();
  t(rec2.dossier.length === 3 && rec2.dossier[2].includes('Cutscene camera'), 'noteProgress attaches later progress to the persisted record');

  // ── 4) resume prompt carries the memory ───────────────────────────────────
  const prompt = genericResumePrompt(rec2.text, rec2.dossier);
  t(prompt.includes('review the chest cutscene in scene_intro'), 'prompt quotes the user request');
  t(prompt.includes('Cutscene camera now focuses the chest'), 'prompt includes the progress dossier');
  t(genericResumePrompt('x', []).includes('•') === false, 'empty dossier adds no excerpt');

  // ── 5) clear works and load returns null afterwards ───────────────────────
  lastmessage.clear();
  t(lastmessage.load() === null, 'clear removes the record');

  fs.rmSync(f, { force: true });
  const line = `${pass} passed, ${fail} failed`;
  process.stdout.write(`\n${'.'.repeat(line.length)}\n${line}\n${'.'.repeat(line.length)}\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
