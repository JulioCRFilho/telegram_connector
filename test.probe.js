// Unit tests for the post-rotation availability probe + cooldown parser.
// Run:  node test.probe.js   (a real, harmless probe against OpenRouter with an
// invalid key is included; it yields a definitive rejection when the network is
// available and an inconclusive verdict when it is not — both are treated as OK)
process.env.TELEGRAM_BOT_TOKEN = '123456789:TEST';
// main.js reads the bot token from `TELEGRAM_BOT_TOKEN_<argv[2]>` (per-project).
// Accept an optional project arg (e.g. `node test.probe.js TESTPROBE`) or seed
// a default one so the module's config validation passes.
const TEST_PROJECT = process.argv[2] || 'TESTPROBE';
if (!process.argv[2]) process.argv.push(TEST_PROJECT);
process.env[`TELEGRAM_BOT_TOKEN_${TEST_PROJECT}`] = '123456789:TEST';
process.env.TELEGRAM_API_KEYS =
  'sk-or-v1-000000000000000000000000000000000000000000000000-bad, ' +
  'sk-or-v1-111111111111111111111111111111111111111111111111-bad';
process.env.TELEGRAM_AVAILABLE_MODELS = 'openrouter/auto, deepseek/deepseek-chat';
process.env.TELEGRAM_PROBE_TIMEOUT_MS = '8000'; // keep the live probe snappy

const m = require('./main.js');

let pass = 0, fail = 0;
function t(cond, name) {
  if (cond) { pass++; console.log(`  ok - ${name}`); }
  else { fail++; console.error(`  FAIL - ${name}`); }
}

console.log('parseCooldownMs:');
t(m.parseCooldownMs('Error 429: Daily free limit reached on model x. Try again in 21h 2m') === (21 * 60 + 2) * 60 * 1000, '"Try again in 21h 2m" → 21h02m');
t(m.parseCooldownMs('Try again after 5h') === 5 * 60 * 60 * 1000, '"Try again after 5h" → 5h');
t(m.parseCooldownMs('You are being rate limited. Try again in 30m') === 30 * 60 * 1000, '"Try again in 30m" → 30m');
t(m.parseCooldownMs('nothing to parse here') === 0, 'no match → 0');

console.log('classifyProbeFailure:');
let v;
v = m.classifyProbeFailure(404, { error: { code: 404, message: 'Model not found' } }, NaN);
t(v.blocked === true && Number.isFinite(v.cooldownMs), 'unknown model → blocked');
v = m.classifyProbeFailure(429, { error: { code: 429, message: 'Error 429: Daily free limit reached on model x. Try again in 21h 2m' } }, NaN);
t(v.blocked === true && v.cooldownMs === (21 * 60 + 2) * 60 * 1000, 'daily free limit → 21h cooldown');
v = m.classifyProbeFailure(429, { error: { code: 429, message: 'Too Many Requests' } }, 60);
t(v.blocked === true && v.cooldownMs === 60 * 1000, '429 + Retry-After: 60 → 60s cooldown');
v = m.classifyProbeFailure(401, { error: { code: 401, message: 'Invalid API key' } }, NaN);
t(v.blocked === true, 'invalid/expired key → blocked');
v = m.classifyProbeFailure(402, { error: { code: 402, message: 'You have insufficient credits. Add more credits and retry the request.' } }, NaN);
t(v.blocked === true, 'insufficient credits → blocked');
v = m.classifyProbeFailure(502, { error: { code: 502, message: 'Upstream error' } }, NaN);
t(v.blocked === true && v.cooldownMs === 2 * 60 * 1000, '502 → short transient block');
v = m.classifyProbeFailure(400, { error: { code: 400, message: 'max_tokens is not supported, use max_completion_tokens' } }, NaN);
t(v.blocked === false, '400 param artifact → NOT blocked (probe quirk, not availability)');
v = m.classifyProbeFailure(500, { error: { code: 500, message: 'Internal Server Error' } }, NaN);
t(v.blocked === false, '500 → NOT blocked (let the runtime net decide)');

console.log('live probe (real OpenRouter; invalid key must NOT pass):');
(async () => {
  try {
    const r = await m.probeCombo(0, 0);
    console.log(`  verdict: ${JSON.stringify(r)}`);
    if (r.ok === false) {
      t(true, `invalid key → definitive rejection (${r.reason})`);
    } else if (r.ok === null || r.ok === undefined) {
      console.log('  (network/API unavailable here — inconclusive verdict is the designed fallback)');
    } else {
      t(false, 'invalid key must never probe as OK');
    }
  } catch (e) {
    t(false, `probeCombo threw: ${e.message}`);
  }

  const line = `${pass} passed, ${fail} failed`;
  console.log(`\n${'.'.repeat(line.length)}\n${line}\n${'.'.repeat(line.length)}`);
  process.exit(fail ? 1 : 0);
})();