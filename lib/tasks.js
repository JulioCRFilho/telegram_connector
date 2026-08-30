const fs = require('fs');
const path = require('path');
const config = require('./config');

// ── Task progress ───────────────────────────────────────────────────────────
// "Tasks progress: 4/8" appended to acks and pings while a heavy task runs.
// Source: markdown checkbox lists (`- [ ]` / `- [x]`) in the workspace. An
// explicit TELEGRAM_TASKS_FILE wins; otherwise the workspace is scanned and the
// best-fit list is used — that's the list the connector is actively working
// through.
//
// Selection rules (in this repo, an old ANALYSIS doc — analise_como_foi_feito_
// jogos.md, 0/7 unchecked, 17 days untouched — was being reported as the
// "current work" while the real cutscene tasklist had no checkboxes):
//   1. A file that LOOKS like a task list (tasks/todo/tasklist/plan/roadmap)
//      is preferred over any markdown that merely CONTAINS checkboxes.
//   2. A list untouched for ACTIVE_STALE_MS is NOT the live list — skipping it
//      beats guessing from something stale (the old code had no recency bound
//      for partially-checked lists, so an ancient checklist always won).
//   3. A FULLY-CHECKED list that hasn't been touched for DONE_STALE_MS is a
//      finished list from a past task, NOT active work — reporting it forever
//      made every ping repeat "40/40 tasks done — wrapping up" for hours.
// ─────────────────────────────────────────────────────────────────────────────

const DONE_STALE_MS = 10 * 60 * 1000;      // fully-done + untouched for 10 min → finished past task
const ACTIVE_STALE_MS = 6 * 60 * 60 * 1000; // any list untouched >6h → not the live list

// Does the FILE NAME look like a task list? Used to rank scan candidates: a
// `TASKS.md`/`todo.md`/`tasklist_*`/`*_plan.md` is a far better signal of the
// active list than, say, a research doc that happens to contain checkboxes.
function isTaskListName(basename) {
  return /(^|[._-])(tasks?|todo|task[-_.]?list|roadmap|plan)s?([._-]|$)/i.test(basename);
}

// Counts `- [ ]` / `- [x]` markdown checkboxes in a file; null when it has none.
function countCheckboxes(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
  let done = 0, total = 0;
  const pending = [];
  for (const m of text.matchAll(/^[ \t]*[-*] \[( |x|X)\][ \t]*(.*)$/gm)) {
    total++;
    if (m[1] !== ' ') done++;
    else pending.push(m[2].trim());
  }
  return total > 0 ? { done, total, pending } : null;
}

// Recursively collects markdown files under dir, skipping heavy/irrelevant
// trees (dotfiles, node_modules, build outputs) and capping the depth.
function collectMarkdownFiles(dir, depth = 0, out = []) {
  if (depth > 4) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'build' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectMarkdownFiles(p, depth + 1, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// Progress of the active task list, or null when nothing trackable is found.
// Returns { done, total, pending, file, basename } — never a stale document.
function getTaskProgress() {
  const now = Date.now();

  // Explicitly-configured task list is trusted as-is (the user pinned it).
  if (config.TASKS_FILE) {
    const p = countCheckboxes(config.TASKS_FILE);
    if (!p) return null;
    if (p.done >= p.total) {
      let mtime = 0;
      try {
        mtime = fs.statSync(config.TASKS_FILE).mtimeMs;
      } catch (_) {
        return null;
      }
      if (now - mtime > DONE_STALE_MS) return null;
    }
    return { ...p, file: config.TASKS_FILE, basename: path.basename(config.TASKS_FILE) };
  }

  // Fallback scan: prefer task-named files, then the most recently modified; a
  // list untouched for ACTIVE_STALE_MS is skipped entirely.
  let bestNamed = null;
  let bestAny = null;
  for (const file of collectMarkdownFiles(config.TASKS_DIR)) {
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch (_) {
      continue;
    }
    const counts = countCheckboxes(file);
    if (!counts) continue;
    if (counts.done >= counts.total && now - mtime > DONE_STALE_MS) continue; // finished past task
    if (now - mtime > ACTIVE_STALE_MS) continue;    // untouched for 6h → not the live list
    const rec = { ...counts, mtime, file, basename: path.basename(file) };
    if (isTaskListName(rec.basename)) {
      if (!bestNamed || mtime > bestNamed.mtime) bestNamed = rec;
    } else if (!bestAny || mtime > bestAny.mtime) {
      bestAny = rec;
    }
  }
  // A task-named list always wins over an arbitrary doc — even a slightly
  // newer one — so a `todo.md` is never shadowed by a research write-up.
  const best = bestNamed || bestAny;
  return best ? { done: best.done, total: best.total, pending: best.pending, file: best.file, basename: best.basename } : null;
}

// Formats "\n📋 4/8 tasks completed (50%)" — empty string when nothing to report.
// A full list (done === total) reads "finalizing…" instead: the checkboxes may
// all be ticked while the agent is still verifying/composing its final reply,
// and "tasks completed (100%)" would contradict the "Still working…" ping.
function taskProgressText() {
  const p = getTaskProgress();
  if (!p) return '';
  if (p.done === p.total) return `\n📋 ${p.done}/${p.total} tasks done — finalizing…`;
  const pct = Math.round((p.done / p.total) * 100);
  return `\n📋 ${p.done}/${p.total} tasks completed (${pct}%)`;
}

module.exports = { countCheckboxes, collectMarkdownFiles, getTaskProgress, taskProgressText, isTaskListName };