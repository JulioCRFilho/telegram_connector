#!/usr/bin/env node
// reset-grid.js — REAL (agent-independent) cooldown reset.
//
// Zeroes every key×model cooldown record in the shared agents.cooldowns.json
// and RESTARTS every live wrapper so it re-reads the now-empty grid on boot.
// Deliberately touches NO Telegram API and NO cline process — it works even
// when the agent is frozen, which is exactly when a reset is needed most.
//
// Why restart instead of nudging with a signal: the wrappers may be running
// old code with no SIGUSR2 handler (Node's default action is to TERMINATE the
// process — the wrapper would die instead of waking). A restart is version-
// agnostic: the wrapper boots, loads the empty grid, and starts a connector.
//
// Usage:  node reset-grid.js        (or: npm run reset)
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const DIR = __dirname;
const cooldownsFile = process.env.TELEGRAM_COOLDOWNS_FILE || path.join(DIR, 'agents.cooldowns.json');
const pidsFile = process.env.TELEGRAM_PIDS_FILE || path.join(DIR, 'agents.pids.json');

let cleared = 0;
try {
  const raw = JSON.parse(fs.readFileSync(cooldownsFile, 'utf8'));
  cleared = Object.keys(raw).filter((k) => /^\d+:\d+$/.test(k)).length;
} catch (_) { /* missing/corrupt file -> nothing to count */ }
fs.writeFileSync(cooldownsFile, '{}\n');
console.log(`♻️  Cleared ${cleared} cooldown record(s) -> ${cooldownsFile}`);
console.log('.'.repeat(72));
console.log('NOTE: This clears OUR records only — it cannot restore provider quota.');
console.log('If a daily free limit is truly still in effect, the next API call gets');
console.log('a real 429 and the combo re-blocks with the provider own time.');

// Restart every live wrapper so it boots on the now-empty grid. restart-agent.sh
// does a graceful SIGTERM + re-spawn; works for both old and new code.
let restarted = 0, skipped = 0;
try {
  const registry = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
  for (const [name, entry] of Object.entries(registry)) {
    const pid = (entry && typeof entry === 'object') ? entry.pid : entry;
    const instance = (entry && typeof entry === 'object' && entry.instance) || name;
    if (!pid) { skipped++; continue; }
    try { process.kill(pid, 0); } catch (_) { skipped++; continue; }
    const r = spawnSync('bash', [path.join(DIR, 'restart-agent.sh'), instance], { stdio: 'inherit' });
    if (r.status === 0) {
      restarted++;
      console.log(`   -> restarted ${instance} (pid ${pid})`);
    } else {
      console.log(`   -> restart FAILED for ${instance} (exit ${r.status}) — grid is still cleared; restart it manually`);
    }
  }
} catch (_) { /* missing registry -> wrappers pick up the empty grid on their own */ }
if (!restarted && !skipped) {
  console.log('   -> no live wrappers registered (they will pick up the empty grid on their next park refresh / start decision)');
} else if (!restarted) {
  console.log(`   -> ${skipped} wrapper(s) already dead — start them manually to use the cleared grid`);
}
