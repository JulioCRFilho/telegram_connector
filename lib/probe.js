const config = require('./config');
const log = require('./log');
const rotation = require('./rotation');
const { spawn } = require('child_process');

// ── Pre-flight availability probe ───────────────────────────────────────────
// Tests a (key, model) combo by starting a real cline connector process and
// checking if it successfully connects. This uses cline's own API client and
// authentication mechanism, ensuring the probe tests the exact same path the
// connector uses.
//
// Verdicts:
//   { ok: true }        → the pair answers — start the connector.
//   { ok: false, ... }  → DEFINITIVE provider failure — block the combo, rotate.
//   { ok: null, ... }   → inconclusive (network/timeout/unclassified) — start
//                         anyway; the runtime limit/crash detection is the net.
// ─────────────────────────────────────────────────────────────────────────────

// Enabled by default for ALL providers. Force it off with TELEGRAM_PROBE_ENABLED=0.
const PROBE_ENV = String(process.env.TELEGRAM_PROBE_ENABLED || '').toLowerCase();
const PROBE_ENABLED = PROBE_ENV === ''
  ? true
  : (PROBE_ENV === '1' || PROBE_ENV === 'true' || PROBE_ENV === 'on' || PROBE_ENV === 'yes');
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
  // Gateway retry exhaustion — transient error, retry soon with rotation.
  if (/giving up after .* attempt|failed to send request|inference request failed/i.test(low)) {
    return { blocked: true, cooldownMs: PROBE_TRANSIENT_COOLDOWN_MS, reason: 'gateway retry exhausted', detail: msg.slice(0, 200) };
  }
  return { blocked: false, reason: `unclassified (HTTP ${status}${Number.isNaN(code) ? '' : `, code ${code}`}) '${msg.slice(0, 120)}'` };
}

// Tests a (key, model) combo by starting a real cline connector process.
// This uses cline's own API client and authentication mechanism.
async function probeCombo(keyIndex, modelIndex) {
  const model = config.MODELS[modelIndex];
  const key = config.API_KEYS[keyIndex];
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;

    const resolveOnce = (result) => {
      if (resolved) return;
      resolved = true;
      if (child && !child.killed) {
        child.kill('SIGTERM');
        // Force kill after 1 second if it doesn't die
        setTimeout(() => {
          if (child && !child.killed) child.kill('SIGKILL');
        }, 1000);
      }
      log(`[Probe] key #${keyIndex} + model #${modelIndex} (${model}) — ${result.reason} (${Date.now() - startedAt}ms).`);
      resolve(result);
    };

    // Build the cline command with the specific key/model
    const args = [
      'connect', 'telegram',
      '-i',  // foreground mode
      '-k', config.TELEGRAM_BOT_TOKEN,
      '--api-key', key,
      '--model', model,
      '--allowed-user-id', config.ALLOWED_USER_ID || '0',
    ];

    let child;
    try {
      child = spawn('cline', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
      });
    } catch (err) {
      resolveOnce({ ok: null, reason: `spawn error: ${err.message}` });
      return;
    }

    // Capture stdout and stderr
    child.stdout.on('data', (buf) => {
      const text = buf.toString();
      stdout += text;

      // Check for successful connection
      if (/Telegram connector ready|connected as/.test(text)) {
        resolveOnce({ ok: true, reason: 'ok' });
      }
    });

    child.stderr.on('data', (buf) => {
      const text = buf.toString();
      stderr += text;

      // Check for error messages that indicate the key/model is unavailable
      if (/INFERENCE_CAP_ERROR|daily free limit|Error 429|rate limit|too many requests|quota exceeded|invalid.*key|unauthorized|expired.*key|model not found|no endpoints found/i.test(text)) {
        // Try to extract cooldown from the error message
        const cooldownMs = rotation.parseCooldownMs(text) || rotation.COOLDOWN_DEFAULT_MS;
        resolveOnce({ ok: false, cooldownMs, reason: 'provider error', detail: text.slice(0, 200) });
      }
    });

    child.on('error', (err) => {
      resolveOnce({ ok: null, reason: `process error: ${err.message}` });
    });

    child.on('close', (code) => {
      // If we haven't resolved yet, the process exited without a clear success/error
      if (!resolved) {
        // Check if the output contains any error indicators
        const output = stdout + stderr;
        if (/INFERENCE_CAP_ERROR|daily free limit|Error 429|rate limit|too many requests|quota exceeded/i.test(output)) {
          const cooldownMs = rotation.parseCooldownMs(output) || rotation.COOLDOWN_DEFAULT_MS;
          resolveOnce({ ok: false, cooldownMs, reason: 'provider error', detail: output.slice(0, 200) });
        } else if (/invalid.*key|unauthorized|expired.*key|model not found/i.test(output)) {
          resolveOnce({ ok: false, cooldownMs: PROBE_BAD_MODEL_COOLDOWN_MS, reason: 'invalid/expired key or model', detail: output.slice(0, 200) });
        } else {
          // Inconclusive - start anyway, runtime detection is the safety net
          resolveOnce({ ok: null, reason: `exited with code ${code}` });
        }
      }
    });

    // Timeout - if we haven't resolved by then, it's inconclusive
    setTimeout(() => {
      resolveOnce({ ok: null, reason: `timeout after ${PROBE_TIMEOUT_MS / 1000}s` });
    }, PROBE_TIMEOUT_MS);
  });
}

module.exports = {
  PROBE_ENABLED,
  PROBE_NOTICE_THROTTLE_MS,
  classifyProbeFailure,
  probeCombo,
};