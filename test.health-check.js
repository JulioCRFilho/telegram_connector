#!/usr/bin/env node
// test.health-check.js
// Regression test for the watch-agents health check's stall detector.
// Observed live with EVOL (2026-08-30): the wrapper stayed alive and kept
// printing "Still working after N min" for 18+ minutes with no "Task
// completed|failed" — the 60s liveness pass saw nothing wrong. The health
// check must flag such turns once the in-flight age crosses
// STALLED_TURN_MIN, and must NOT flag healthy turns (completed/failed) or
// turns that hung and stopped logging (wall-clock age of the last line
// carries the stall when the counter froze).
const assert = require('assert');
const { stalledTurnMinutes, STALLED_TURN_MIN, tailFile } = require('./watch-agents');

const NOW = Date.parse('2026-08-30T04:00:00.000Z');
const ts = (iso) => `[${iso}]`;

// 1. Healthy: turn completed after the "still working" lines → not stalled.
const completed = [
  ts('2026-08-30T03:32:00.000Z') + ' [Turn] Acknowledging chat.',
  ts('2026-08-30T03:35:00.000Z') + ' [Telegram] → chat: ⏳ Still working after 5 min.',
  ts('2026-08-30T03:40:00.000Z') + ' [Turn] Task completed after ~8 min (chat 1).',
  ts('2026-08-30T03:41:00.000Z') + ' [child stdout] [telegram] connected',
].join('\n');
assert.strictEqual(stalledTurnMinutes(completed, NOW), 0, 'completed turn must not count as stalled');

// 2. Stalled: counter keeps climbing past the threshold.
const climbing = [
  ts('2026-08-30T03:32:00.000Z') + ' [Turn] Acknowledging chat.',
  ts('2026-08-30T03:35:00.000Z') + ' [Telegram] → chat: ⏳ Still working after 5 min.',
  ts('2026-08-30T03:45:00.000Z') + ' [Telegram] → chat: ⏳ Still working after 10 min.',
  ts('2026-08-30T03:55:00.000Z') + ' [Telegram] → chat: ⏳ Still working after 31 min.',
].join('\n');
assert.strictEqual(stalledTurnMinutes(climbing, NOW), 31, 'climbing counter past threshold must be flagged');

// 3. Hung wrapper: last "still working" line frozen at 10 min but written
//    25 min ago — wall-clock age carries the stall past the threshold.
const frozen = [
  ts('2026-08-30T03:25:00.000Z') + ' [Turn] Acknowledging chat.',
  ts('2026-08-30T03:35:00.000Z') + ' [Telegram] → chat: ⏳ Still working after 10 min.',
].join('\n');
assert.strictEqual(stalledTurnMinutes(frozen, NOW), 25, 'frozen counter must fall back to wall-clock age');

// 4. Fresh short turn: in flight but under threshold → not stalled.
const young = ts('2026-08-30T03:55:00.000Z') + ' [Telegram] → chat: ⏳ Still working after 10 min.';
assert.strictEqual(stalledTurnMinutes(young, NOW), 10, 'in-flight turn under threshold must not be flagged');

// 5. Empty / missing tail → 0.
assert.strictEqual(stalledTurnMinutes('', NOW), 0, 'empty tail must not be flagged');

// 6. Threshold + tailFile sanity: real tail reading works and default
//    threshold is 30 min, interval is 10 min.
assert.strictEqual(STALLED_TURN_MIN, 30);
assert.strictEqual(typeof tailFile(__filename), 'string');
assert.ok(tailFile(__filename).includes('STALLED_TURN_MIN'), 'tailFile must read file content');

console.log('test.health-check.js: all assertions passed');