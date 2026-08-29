const fs = require('fs');
const path = require('path');
const config = require('./config');

// ── Task progress ───────────────────────────────────────────────────────────
// "Tasks progress: 4/8" appended to acks and pings while a heavy task runs.
// Source: markdown checkbox lists (`- [ ]` / `- [x]`) in the workspace. An
// explicit TELEGRAM_TASKS_FILE wins; otherwise the workspace is scanned and the
// most recently modified file containing checkboxes is used — that's the list
// the connector is actively working through.
// A FULLY-CHECKED list that hasn't been touched for DONE_STALE_MS is a finished
// list from a past task, NOT active work — reporting it forever made every ping
// repeat "40/40 tasks done — wrapping up" for hours. Only a completion that is
// fresh (ticked during the current work) keeps the "wrapping up" status.
// ─────────────────────────────────────────────────────────────────────────────

const DONE_STALE_MS = 10 * 60 * 1000; // fully-done + untouched for 10 min → finished past task

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
// Fully-checked lists count as "active" ONLY while fresh (mtime within
// DONE_STALE_MS) — a stale 100%-done file is a finished past task and is
// skipped so it can't masquerade as the current work forever.
function getTaskProgress() {
  const now = Date.now();
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
    return p;
  }
  let best = null;
  for (const file of collectMarkdownFiles(config.TASKS_DIR)) {
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch (_) {
      continue;
    }
    const counts = countCheckboxes(file);
    if (!counts) continue;
    if (counts.done >= counts.total && now - mtime > DONE_STALE_MS) continue;
    if (!best || mtime > best.mtime) best = { ...counts, mtime, file };
  }
  return best;
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

module.exports = { countCheckboxes, collectMarkdownFiles, getTaskProgress, taskProgressText };