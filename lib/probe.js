const config = require('./config');
const log = require('./log');
const rotation = require('./rotation');

// ── Pre-flight availability probe ───────────────────────────────────────────
// After rotation picks a NEW (key, model) we test it against the real API
// BEFORE launching the connector — the rotated key/model must be tested to
// ensure availability, or the wrapper rotates again. A probe is one tiny chat
// completion (max_tokens=1, cost ≈ 0). A success proves key validity + model
// existence + healthy quota on that pair at that instant; a DEFINITIVE provider
// error (invalid key / model not found / quota exhausted) blocks the combo with
// the quoted cooldown and the wrapper probes the next slot. Network/timeout/
// unclassified failures are NOT treated as rejections — the runtime limit/crash
// detection stays the safety net, so a transient hiccup can never dead-stop the
// rotation.
// ─────────────────────────────────────────────────────────────────────────────

// Enabled by default only for OpenRouter keys (sk-or-v1-…); force it explicitly
// with TELEGRAM_PROBE_ENABLED=1/0 for any other provider/base URL.
const PROBE_ENV = String(process.env.TELEGRAM_PROBE_ENABLED || '').toLowerCase();
const PROBE_ENABLED = PROBE_ENV === ''
  ? config.API_KEYS.some((k) => /^sk-or-/i.test(k))
  : (PROBE_ENV === '1' || PROBE_ENV === 'true' || PROBE_ENV === 'on' || PROBE_ENV === 'yes');
const PROBE_API_BASE = (process.env.TELEGRAM_API_BASE || 'https://openrouter.ai').replace(/\/+$/, '');
const PROBE_PROMPT = process.env.TELEGRAM_PROBE_PROMPT || 'Reply with the single word: pong';
const PROBE_MAX_TOKENS = Math.max(parseInt(process.env.TELEGRAM_PROBE_MAX_TOKENS || '1', 10) || 1, 1);
const PROBE_TIMEOUT_MS = Math.max(parseInt(process.env.TELEGRAM_PROBE_TIMEOUT_MS || '15000', 10) || 15000, 2000);
// Deterministic "this model doesn't exist / has no endpoint" — skip it a while
// before retesting so rotation doesn't burn a request on it every cycle.
const PROBE_BAD_MODEL_COOLDOWN_MS = 60 * 60 * 1000;
// 502/503 (model or upstream transiently down) — short cooldown, retry soon.
const PROBE_TRANSIENT_COOLDOWN_MS = 2 * 60 * 1000;
// Throttle the per-rejection "testing X next" notices during a dead-combo sweep.
const PROBE_NOTICE_THROTTLE_MS = 15 * 1000;

// Classifies a non-200 probe response into a verdict:
//   { blocked:false }                      → NOT proof the key/model is unavailable
//     (parameter artifact, guardrail, unknown code) — caller must NOT rotate.
//   { blocked:true, cooldownMs, reason }   → DEFINITIVE provider failure — the
//     caller blocks the combo and rotates again.
function classifyProbeFailure(status, body, retryAfterSec) {
  const err = (body && body.error) || {};
  const code = err.code !== undefined && err.code !== null ? Number(err.code) : NaN;
  const msg = String(err.message || '');
  const low = `${msg} ${err.type || ''}`.toLowerCase();

  const quotedCooldown = () => rotation.parseCooldownMs(msg) ||
    ((Number.isFinite(retryAfterSec) && retryAfterSec > 0) ? retryAfterSec * 1000 : 0);

  // Rate limit / quota — honor the cooldown the provider quoted in the message
  // (or the Retry-After header, then the default).
  if (code === 429 || /rate limit|too many requests|daily free limit|try again (?:in|after)|quota exceeded|insufficient_quota|limit reached|INFERENCE_CAP/i.test(low)) {
    return { blocked: true, cooldownMs: quotedCooldown() || rotation.COOLDOWN_DEFAULT_MS, reason: 'quota/rate limit', detail: msg.slice(0, 200) };
  }
  // Out of credits — same treatment as quota.
  if (code === 402 || /insufficient credits|add more credits/i.test(low)) {
    return { blocked: true, cooldownMs: quotedCooldown() || rotation.COOLDOWN_DEFAULT_MS, reason: 'insufficient credits', detail: msg.slice(0, 200) };
  }
  // The key itself is dead.
  if (code === 401 || /invalid api key|invalid credentials|unauthorized|authentication/i.test(low)) {
    return { blocked: true, cooldownMs: rotation.COOLDOWN_DEFAULT_MS, reason: 'invalid/expired key', detail: msg.slice(0, 200) };
  }
  // The model doesn't exist (or has no serving endpoint right now).
  if (code === 404 || /model not found|no endpoints found|no available model provider/i.test(low)) {
    return { blocked: true, cooldownMs: quotedCooldown() || PROBE_BAD_MODEL_COOLDOWN_MS, reason: 'model unavailable', detail: msg.slice(0, 200) };
  }
  // Model/upstream transiently down — cool briefly, retry the model soon.
  if (code === 502 || code === 503 || /model (?:is )?down|temporarily overloaded/i.test(low)) {
    return { blocked: true, cooldownMs: PROBE_TRANSIENT_COOLDOWN_MS, reason: `upstream ${code}`, detail: msg.slice(0, 200) };
  }
  return { blocked: false, reason: `unclassified (HTTP ${status}${Number.isNaN(code) ? '' : `, code ${code}`}) '${msg.slice(0, 120)}'` };
}

// Sends one minimal chat completion to the provider with the EXACT key+model the
// connector would use. Verdicts:
//   { ok: true }        → the pair answers — start the connector.
//   { ok: false, ... }  → DEFINITIVE provider failure — block the combo, rotate.
//   { ok: null, ... }   → inconclusive (network/timeout/unclassified) — start
//                         anyway; the runtime limit/crash detection is the net.
async function probeCombo(keyIndex, modelIndex) {
  const model = config.MODELS[modelIndex];
  const key = config.API_KEYS[keyIndex];
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${PROBE_API_BASE}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: PROBE_PROMPT }],
        max_tokens: PROBE_MAX_TOKENS,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const why = err && err.name === 'AbortError'
      ? `timeout after ${PROBE_TIMEOUT_MS / 1000}s`
      : `network error: ${err && err.message}`;
    log(`[Probe] key #${keyIndex} + model #${modelIndex} (${model}) inconclusive — ${why}; starting anyway.`);
    return { ok: null, reason: why };
  }
  clearTimeout(timer);

  let body = null;
  try { body = await res.json(); } catch (_) {
    log(`[Probe] key #${keyIndex} + model #${modelIndex} (${model}) non-JSON HTTP ${res.status}; starting anyway.`);
    return { ok: null, reason: `HTTP ${res.status} (non-JSON body)` };
  }

  const retryAfterSec = Number(res.headers.get('retry-after') || NaN);
  if (res.status === 200 && !body.error && Array.isArray(body.choices) && body.choices.length > 0) {
    log(`[Probe] key #${keyIndex} + model #${modelIndex} (${model}) — available (${Date.now() - startedAt}ms).`);
    return { ok: true, reason: 'ok' };
  }
  if (body.error) {
    const v = classifyProbeFailure(res.status, body, retryAfterSec);
    if (v.blocked) {
      return { ok: false, cooldownMs: v.cooldownMs, reason: v.reason, detail: v.detail };
    }
    log(`[Probe] key #${keyIndex} + model #${modelIndex} (${model}) ${v.reason}; starting anyway.`);
    return { ok: null, reason: v.reason, detail: v.detail };
  }
  log(`[Probe] key #${keyIndex} + model #${modelIndex} (${model}) unexpected response (HTTP ${res.status}); starting anyway.`);
  return { ok: null, reason: `unexpected HTTP ${res.status}` };
}

module.exports = {
  PROBE_ENABLED,
  PROBE_NOTICE_THROTTLE_MS,
  classifyProbeFailure,
  probeCombo,
};