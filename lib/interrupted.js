const fs = require('fs');
const config = require('./config');
const log = require('./log');

// Persisted FIFO of interrupted (paused) tasks per instance.
//
// When a new user message arrives while the agent is mid-task, the running
// task is STOPPED (connector restart) and the new message is answered first.
// The interrupted task is stashed here so nothing is lost: as soon as the
// newer request has been answered, the wrapper automatically re-queues the
// oldest paused task and the agent continues it (see chat.js
// pauseCurrentForNewMessage / resumeNextInterrupted).
//
// Survives wrapper restarts (plain JSON on disk, atomic-ish writeFileSync),
// entries expire after 24h and the queue is capped so a chatty user can't
// build an unbounded backlog of half-finished tasks.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;    // same safety cap as lastmessage
const MAX_ENTRIES = 5;                     // never more than 5 paused tasks

function loadAll() {
  try {
    const arr = JSON.parse(fs.readFileSync(config.INTERRUPTED_FILE, 'utf8'));
    if (!Array.isArray(arr)) return [];
    const now = Date.now();
    return arr.filter((r) => r && r.text && now - (r.updatedAt || 0) <= MAX_AGE_MS);
  } catch (_) {
    return [];
  }
}

function saveAll(list) {
  try {
    fs.writeFileSync(config.INTERRUPTED_FILE, JSON.stringify(list));
  } catch (err) {
    log(`[Interrupt] Couldn't persist paused task: ${err.message}`);
  }
}

// Stashes a paused task. Returns the number of paused tasks now queued.
function push(chatId, text) {
  const list = loadAll();
  // Never stack the identical task twice (user re-sending the same message).
  if (list.some((r) => r.text === text)) return list.length;
  list.push({ chatId, text, updatedAt: Date.now() });
  while (list.length > MAX_ENTRIES) list.shift();   // drop the OLDEST overflow
  saveAll(list);
  return list.length;
}

// Removes and returns the oldest paused task, or null. Expired entries are
// dropped lazily on every access.
function pop() {
  const list = loadAll();
  while (list.length) {
    const rec = list.shift();
    saveAll(list);
    if (Date.now() - (rec.updatedAt || 0) <= MAX_AGE_MS) return rec;
  }
  return null;
}

function count() {
  return loadAll().length;
}

function clear() {
  try { fs.unlinkSync(config.INTERRUPTED_FILE); } catch (_) { }
}

module.exports = { push, pop, count, clear };