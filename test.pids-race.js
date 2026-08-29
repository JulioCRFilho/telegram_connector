// test.pids-race.js
// Regression test for the agents.pids.json lost-update bug: several wrappers
// booting at the same instant used to read-modify-write the file concurrently,
// each overwriting the others' fresh entries — so one instance silently vanished
// from the file (observed live with EVOL+FSCENE on 2026-08-29). This reproduces
// the race by forking N children that all call procs.writePidEntry() at once,
// then asserts every instance survived.
// Run:  node test.pids-race.js
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');

// lib/config validates env at require time — children inherit these.
process.env.TELEGRAM_BOT_TOKEN = '123456789:TEST';
process.env.TELEGRAM_API_KEYS = 'sk-test';
process.env.TELEGRAM_AVAILABLE_MODELS = 'model-a';

const ROUNDS = 3;
const PER_ROUND = 8;
const PIDS_FILE = path.join(__dirname, 'agents.pids.json');
const CHILD = path.join(__dirname, 'test-pids-race-child.js');

function runRound(round) {
  const names = Array.from({ length: PER_ROUND }, (_, i) => `RACE${round}_${i}`);
  const children = names.map((name) => new Promise((resolve, reject) => {
    // lib/config reads the per-project token TELEGRAM_BOT_TOKEN_<NAME> for the
    // incoming instance name — seed it before forking so the child validates.
    process.env[`TELEGRAM_BOT_TOKEN_${name}`] = '123456789:TEST';
    const child = fork(CHILD, [name]);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child ${name} exited ${code}`))));
    child.on('error', reject);
  }));
  return Promise.all(children).then(() => names);
}

(async () => {
  let pass = 0, fail = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const names = await runRound(r);
    const all = JSON.parse(fs.readFileSync(PIDS_FILE, 'utf8'));
    const missing = names.filter((n) => !all[n] || typeof all[n].wrapperPid !== 'number');
    if (missing.length) {
      fail++;
      console.error(`  FAIL - round ${r}: lost pid entries: ${missing.join(', ')}`);
      console.error('  file contents:', JSON.stringify(all, null, 2));
    } else {
      pass++;
      console.log(`  ok - round ${r}: all ${names.length} concurrent pid writes survived`);
    }
    // Cleanup (all children done; live wrappers only read this file between boots).
    for (const n of names) delete all[n];
    fs.writeFileSync(PIDS_FILE, JSON.stringify(all, null, 2) + '\n');
  }
  console.log(`\n${pass}/${ROUNDS} rounds passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });