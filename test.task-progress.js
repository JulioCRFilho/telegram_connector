// test.task-progress.js
// Regression test for the wrong "on:" title bug: the EVOL wrapper used to
// report "0/7 tasks completed — on: Física: Rapier…" while the agent was
// actually working on a chest cutscene. Root cause: getTaskProgress() picked
// any markdown that merely CONTAINS checkboxes, most-recent first — an old
// (17-day-untouched) analysis doc with 7 unchecked items won the scan over the
// real work, whose checklist had no checkboxes at all.
//
// The fix: (1) skip any list untouched for ACTIVE_STALE_MS (not the live
// list), (2) prefer files whose NAME looks like a task list (tasks/todo/…)
// over arbitrary docs, (3) keep the explicit TELEGRAM_TASKS_FILE trusted.
// Run:  node test.task-progress.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'task-progress-'));
const DIR = path.join(TMP, 'tree');
fs.mkdirSync(path.join(DIR, 'docs'), { recursive: true });

// E.g. a research/analysis doc that contains a checklist but is NOT the active
// task list (this is exactly what misled the wrapper in com.appfy.evol).
const ANALYSIS = path.join(DIR, 'docs', 'analise_como_foi_feito_jogos.md');
fs.writeFileSync(ANALYSIS, [
  '# How other games do it',
  '- [ ] **Física**: Rapier com formas analíticas; jogador = character controller;',
  '- [ ] **Câmera**: follow do jogador',
  '- [ ] **Sons**: footstep SFX',
  '- [ ] **HUD**: vida do jogador',
  '- [ ] **Mapa**: 20x20 grid',
  '- [ ] **Spawn**: wave system',
  '- [ ] **Save**: checkpoint',
].join('\n'));

// The REAL current task list (name looks like a task list, actively being
// worked, 2 of 8 done).
const TASKS = path.join(DIR, 'TASKS.md');
fs.writeFileSync(TASKS, [
  '# Current work',
  '- [x] Cutscene trigger on E',
  '- [x] Chest rises & spins to center',
  '- [ ] Camera focus on chest',
  '- [ ] Interaction UI prompt',
  '- [ ] Open animation sync',
  '- [ ] Loot spawn',
  '- [ ] Sound design',
  '- [ ] Polishing pass',
].join('\n'));

const now = Date.now();
// Mark the analysis doc stale (last touched a week ago) — this is what makes
// it an old write-up instead of live work.
const old = Math.floor(now / 1000) - 7 * 24 * 3600;
fs.utimesSync(ANALYSIS, old, old);

process.env.TELEGRAM_BOT_TOKEN = '123456789:TEST';
const NAME = process.argv[2] || 'TASKPROG';
if (!process.argv[2]) process.argv.push(NAME);
process.env[`TELEGRAM_BOT_TOKEN_${NAME}`] = '123456789:TEST';
process.env.TELEGRAM_API_KEYS = 'k1';
process.env.TELEGRAM_AVAILABLE_MODELS = 'm1';
process.env.TELEGRAM_TASKS_DIR = DIR;
delete process.env.TELEGRAM_TASKS_FILE;

const tasks = require('/Users/thetod/Projects/telegram_connector/lib/tasks');

let pass = 0, fail = 0;
function t(cond, name) {
  if (cond) { pass++; console.log(`  ok - ${name}`); }
  else { fail++; console.error(`  FAIL - ${name}`); }
}

// ── 1) stale analysis doc is NOT picked as the live list ────────────────────
const fresh = tasks.getTaskProgress();
t(fresh && fresh.basename === 'TASKS.md', `picks the task-named list, not the stale analysis doc (got ${fresh && fresh.basename})`);
t(fresh && fresh.done === 2 && fresh.total === 8, 'correct counts from the real list (2/8)');
t(fresh && fresh.pending && fresh.pending[0].includes('Camera'), 'first unchecked item comes from the real list');

// ── 2) ONLY a stale checklist → nothing reported (null, not a guess) ────────
fs.rmSync(TASKS);
const onlyStale = tasks.getTaskProgress();
t(onlyStale === null, 'no live list → null (never attribute an old analysis doc as current work)');

// ── 3) wait: make the analysis doc "fresh" again — a random doc that merely
//    has checkboxes must still report COUNTS but the caller decides the "on:"
//    claim (chat.js appends the basename for these). Verify the doc is found.
fs.utimesSync(ANALYSIS, Math.floor(now / 1000), Math.floor(now / 1000));
const analysisPicked = tasks.getTaskProgress();
t(analysisPicked && analysisPicked.basename === 'analise_como_foi_feito_jogos.md', 'fresh arbitrary doc with checkboxes is the only candidate — found with counts');
t(analysisPicked && analysisPicked.done === 0 && analysisPicked.total === 7, 'its real 0/7 counts are reported');
t(tasks.isTaskListName('analise_como_foi_feito_jogos.md') === false && tasks.isTaskListName('TASKS.md') === true, 'isTaskListName distinguishes real task lists from arbitrary docs');

fs.rmSync(TMP, { recursive: true, force: true });
const line = `${pass} passed, ${fail} failed`;
console.log(`\n${'.'.repeat(line.length)}\n${line}\n${'.'.repeat(line.length)}`);
process.exit(fail ? 1 : 0);