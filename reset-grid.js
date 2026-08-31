#!/usr/bin/env node
// reset-grid.js — REAL (agent-independent) cooldown reset.
//
// Zeroes every key×model cooldown record in the shared agents.cooldowns.json
// and SIGUSR2s every live wrapper so it re-evaluates the grid immediately
// (a parked wrapper wakes and starts a fresh combo; a running one re-checks on
// its next rotation). Deliberately touches NO Telegram API and NO cline
// process — it works even when the agent is frozen, which is exactly when a
// reset is needed most. The in-chat /reset command funnels into the exact same
// supervisor.resetAndWake() logic via the SIGUSR2-style path.
//
// Usage:  node reset-grid.js        (or: npm run reset)
const fs = require('fs');
const path = require('path');
const DIR = __dirname;
const cooldownsFile = process.env.TELEGRAM_COOLDOWNS_FILE || path.join(DIR, 'agents.cooldowns.json');
const pidsFile = process.env.TELEGRAM_PIDS_FILE || path.join(DIR, 'agents.pids.json');

let cleared = 0;
try {
  const raw = JSON.parse(fs.readFileSync(cooldownsFile, 'utf8'));
  cleared = Object.keys(raw).filter((k) => /^\d+:\d+$/.test(k)).length;
} catch (_) { /* missing/corrupt file → nothing to count */ }
fs.writeFileSync(cooldownsFile, '{}\n');
console.log(`♻️  Cleared ${cleared} cooldown record(s) → ${cooldownsFile}`);
console.log('⚠️  This clears OUR records only — it cannot restore provider quota. If a');
console.log('    daily free limit is truly still in effect, the next API call gets a real');
console.log('    429 and the combo re-blocks with the provider\'s own "try again in" time.');

let nudged = 0;
try {
  const registry = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
  for (const [name, entry] of Object.entries(registry)) {
    const pid = (entry && typeof entry === 'object') ? entry.pid : entry;
    if (!pid) continue;
    try {
      process.kill(pid, 'SIGUSR2');
      nudged++;
      console.log(`   ↳ nudged ${name} (pid ${pid}) to re-evaluate now`);
    } catch (_) { /* dead pid — nothing to nudge */ }
  }
} catch (_) { /* missing registry → wrappers pick up the empty grid on their own */ }
if (!nudged) {
  console.log('   ↳ no live wrappers to nudge (they will pick up the empty grid on their next park refresh / start decision)');
}
