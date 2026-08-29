const config = require('./config');
const log = require('./log');
const rotation = require('./rotation');
const { spawn } = require('child_process');
const procs = require('./procs');

// ── Pre-flight availability probe ───────────────────────────────────────────
// Tests a (key, model) combo BEFORE starting the real connector so we only ever
// run with a tested, available key+model.
//
// The provider is ALWAYS cline's own defaults (never OpenRouter/Anthropic) —
// cline keys (`sk_…`) run through cline's client, so the DEFAULT probe is the
// spawn-based one: it starts the real `cline connect telegram` process and
// observes it, testing the EXACT same API client + endpoint the connector will
// use.
//
// An HTTP probe stage is available as a STRICTLY OPT-IN double gate for custom
// providers: set BOTH TELEGRAM_PROBE_HTTP=1 AND TELEGRAM_API_BASE (provider base
// URL); the probe then fires one tiny chat completion (max_tokens=1) at
// `<base>/api/v1/chat/completions` to catch 429/401/404/"model not found"
// BEFORE spawning anything (fast, no processes). Unless the user explicitly
// sets BOTH variables the HTTP stage NEVER runs — nothing is assumed about the
// provider endpoint.
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

// HTTP-based probe configuration — STRICTLY OPT-IN (double opt-in). It runs
// ONLY when BOTH TELEGRAM_API_BASE (provider base URL) AND TELEGRAM_PROBE_HTTP=1
// are explicitly set. With cline-default providers neither is set: the HTTP
// stage is skipped and the probe uses cline's own client (spawn-based). The
// provider is ALWAYS cline's defaults — never an assumed OpenRouter/Anthropic
// endpoint and never a raw HTTP call unless the user explicitly opts in.
const PROBE_API_BASE = (process.env.TELEGRAM_API_BASE || '').replace(/\/+$/, '');
const PROBE_HTTP_ENABLED = String(process.env.TELEGRAM_PROBE_HTTP || '').toLowerCase() === '1';
const PROBE_PROMPT = process.env.TELEGRAM_PROBE_PROMPT || 'Reply with the single word: pong';
const PROBE_MAX_TOKENS = Math.max(parseInt(process.env.TELEGRAM_PROBE_MAX_TOKENS || '1', 10) || 1, 1);

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

// HTTP-based probe: fires a tiny chat completion at the provider to test the
// (key, model) pair directly. Catches 429/401/404/"model not found" BEFORE
// spawning any cline process — faster, testable, zero orphaned processes.
//
// Returns:
//   { ok:true, reason:'ok' }          → the key/model works
//   { ok:false, cooldownMs, reason }  → DEFINITIVE provider failure — block & rotate
//   null                              → inconclusive — fall through to spawn-based probe
async function probeHttp(keyIndex, modelIndex) {
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
    return null;
  }
  clearTimeout(timer);

  let body = null;
  try { body = await res.json(); } catch (_) {
    log(`[Probe] key #${keyIndex} + model #${modelIndex} (${model}) inconclusive — non-JSON response (HTTP ${res.status}); starting anyway.`);
    return null;
  }

  const retryAfterSec = Number(res.headers.get('retry-after') || NaN);

  if (res.status === 200 && body && !body.error && Array.isArray(body.choices) && body.choices.length > 0) {
    log(`[Probe] key #${keyIndex} + model #${modelIndex} (${model}) — ok (${Date.now() - startedAt}ms).`);
    return { ok: true, reason: 'ok' };
  }

  if (body && body.error) {
    const v = classifyProbeFailure(res.status, body, retryAfterSec);
    if (v.blocked) {
      log(`[Probe] key #${keyIndex} + model #${modelIndex} (${model}) — blocked: ${v.reason} (${Date.now() - startedAt}ms).`);
      return { ok: false, cooldownMs: v.cooldownMs, reason: v.reason, detail: v.detail };
    }
    log(`[Probe] key #${keyIndex} + model #${modelIndex} (${model}) inconclusive — ${v.reason}; starting anyway.`);
    return null;
  }

  log(`[Probe] key #${keyIndex} + model #${modelIndex} (${model}) inconclusive — HTTP ${res.status}; starting anyway.`);
  return null;
}

// Tests a (key, model) combo — first via HTTP probe, then via a real cline
// connector process as a fallback. Returns a verdict object (see above).
async function probeCombo(keyIndex, modelIndex) {
  const model = config.MODELS[modelIndex];
  const key = config.API_KEYS[keyIndex];
  const startedAt = Date.now();

  // Stage 1: HTTP-based probe — STRICTLY OPT-IN: requires BOTH
  // TELEGRAM_PROBE_HTTP=1 AND TELEGRAM_API_BASE (custom provider). Without them
  // the HTTP stage never runs — the probe goes straight to the spawn-based one,
  // which tests cline's OWN client/endpoint (the provider is always cline's
  // defaults).
  if (PROBE_HTTP_ENABLED && PROBE_API_BASE && typeof fetch !== 'undefined') {
    const httpResult = await probeHttp(keyIndex, modelIndex);
    if (httpResult) return httpResult;
    // HTTP probe was inconclusive — fall through to the spawn-based probe.
  }

  // Stage 2: Spawn-based probe — starts the real cline connector.
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let resolved = false;

    const resolveOnce = (result) => {
      if (resolved) return;
      resolved = true;

      // Kill the child AND its entire process tree. The `cline` shim spawns the
      // real .clime binary as a grandchild — killing only the shim orphans the
      // grandchild (PPID=1), which keeps polling the bot and causes the crash
      // loop. Mirrors supervisor.stopCurrent's tree-kill logic.
      if (child && !child.killed) {
        const descendants = procs.collectDescendants(child.pid);
        const tree = [...descendants, child.pid];
        for (const pid of tree) {
          try { process.kill(pid, 'SIGTERM'); } catch (_) {}
        }
        if (descendants.size > 0) {
          log(`[Probe] Sent SIGTERM to probe shim pid ${child.pid} and ${descendants.size} descendant(s).`);
        }
        // Force-kill after 1 second if anything ignores SIGTERM
        setTimeout(() => {
          for (const pid of tree) {
            try { process.kill(pid, 'SIGKILL'); } catch (_) {}
          }
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