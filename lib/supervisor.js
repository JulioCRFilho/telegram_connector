const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');
const state = require('./state');
const procs = require('./procs');
const rotation = require('./rotation');
const probe = require('./probe');
const chat = require('./chat');
const tasks = require('./tasks');
const resume = require('./resume');

// System prompt injected into every connector via --system. Read once at boot
// from the workspace root so all instances share the same agent instructions.
const SYSTEM_PROMPT = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'system_prompt.md'), 'utf8').trim();
  } catch (err) {
    log(`[Rotator] Could not read system_prompt.md: ${err.message}`);
    return '';
  }
})();

// ── Supervised connector lifecycle ───────────────────────────────────────────
// The rotator core: builds the `cline connect telegram` argv, spawns/monitors
// the connector, probes each (key, model) BEFORE starting it (availability
// requirement), and rotates on rate limits / crashes / probe rejections.
// ─────────────────────────────────────────────────────────────────────────────

// Builds the `cline connect telegram` argv from the current key/model indices.
function buildArgs(index, modelIndex) {
  const args = [
    'connect', 'telegram',
    '-i',                          // foreground: the connector stays attached and
    // its errors land in cline's log files we tail
    '-k', config.TELEGRAM_BOT_TOKEN,
    '--api-key', config.API_KEYS[index],
    '--rpc-address', `127.0.0.1:${config.rpcPort}`,
  ];
  // Always pass --model explicitly: never let cline fall back to its own
  // default, so the key×model cooldown grid matches what actually runs.
  args.push('--model', config.MODELS[modelIndex]);
  if (config.ALLOWED_USER_ID) args.push('--allowed-user-id', config.ALLOWED_USER_ID);
  if (SYSTEM_PROMPT) args.push('--system', SYSTEM_PROMPT);
  return args;
}

// How long to wait after SIGTERM before force-killing a connector that ignores
// graceful shutdown. A hung connector keeps polling the bot and replying with
// limit errors while the replacement connector fights it over getUpdates.
const STOP_GRACE_MS = 3000;

// Kills a process by pid, swallowing ESRRCH (already dead).
function killPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (_) {
    return false;
  }
}

// Stops the current connector AND its entire process tree. The cline shim
// spawns the real connector as a child — killing only the shim orphans the
// child, which keeps polling the bot and fighting the replacement connector
// over getUpdates (the "Conflict: terminated by other getUpdates request"
// storm). We therefore collect the full descendant tree and kill every node,
// children-first so parents can't re-spawn them. SIGTERM first, escalating to
// SIGKILL if anything ignores it. Calls onStopped() once the root child is
// actually gone (or immediately when there is nothing to stop) — callers must
// not assume the connector is dead until then.
function stopCurrent(onStopped) {
  const finish = () => { if (onStopped) onStopped(); };
  const child = state.clineProcess;
  if (!child || child.exitCode !== null || child.killed) {
    finish();
    return;
  }

  // Collect the FULL descendant tree before killing anything. Killing only
  // the shim orphans the real connector child, which keeps running and
  // fighting the replacement over the bot token.
  const descendants = procs.collectDescendants(child.pid);
  const tree = [...descendants, child.pid];

  let finished = false;
  const once = () => {
    if (finished) return;
    finished = true;
    finish();
  };
  child.once('close', once);

  // SIGTERM every node in the tree (children first, shim last).
  for (const pid of tree) {
    killPid(pid, 'SIGTERM');
  }
  if (descendants.size > 0) {
    log(`[Rotator] Sent SIGTERM to connector shim pid ${child.pid} and ${descendants.size} descendant(s).`);
  }

  // Escalate to SIGKILL if anything in the tree ignores SIGTERM.
  setTimeout(() => {
    if (finished || child.exitCode !== null) return;
    let killed = 0;
    for (const pid of tree) {
      if (killPid(pid, 'SIGKILL')) killed++;
    }
    if (killed > 0) {
      log(`[Rotator] Connector ignored SIGTERM; sent SIGKILL to ${killed} process(es).`);
    }
  }, STOP_GRACE_MS);

  // Absolute safety net: never wait forever for the child to exit.
  setTimeout(once, STOP_GRACE_MS + 5000);
}

// Queue the auto-resume: after the restart, the wrapper drives the pending task
// list through the hub itself (see lib/resume.js).
function queueResume() {
  state.pendingResume = { chatId: state.lastSeenChatId || config.ALLOWED_USER_ID || null };
}

// "All keys/models on cooldown" notice shared by the limit and crash paths.
// Appends the persisted grid so the user sees each pair's REAL cooldown.
function noticeCooldownPark(progress, waitMs) {
  chat.notifyUser(
    `⛔ All API keys/models are on cooldown right now (next free ~${new Date(Date.now() + waitMs).toISOString().slice(11, 16)} UTC).`
    + (progress ? ` 📋 ${progress.done}/${progress.total} tasks completed.` : '')
    + " I'll retry automatically and let you know when the agent is back online.\n\n"
    + rotation.gridStatus()
  );
}

function scheduleRestart(index, modelIndex, delay = config.RESTART_DELAY_MS, afterCooldown = false) {
  if (state.restarting || state.startPending) {
    // A restart is already scheduled OR a pre-flight probe is still deciding
    // which combo is available. If this is a limit rotation superseding a
    // crash-restart that was queued first, keep the rotation target so the next
    // start doesn't loop back onto the exhausted key.
    state.pendingRotation = [index, modelIndex];
    log(`[Rotator] Restart already scheduled; queueing target key #${index}, model #${modelIndex}.`);
    return;
  }
  state.restarting = true;

  // Wait until the old connector is actually dead (SIGTERM, then SIGKILL
  // escalation) before purging and starting the replacement — two pollers on
  // one bot token conflict over Telegram getUpdates.
  stopCurrent(() => {
    procs.purgeStale();                // no stale daemons left to steal updates

    setTimeout(() => {                 // wait before restarting
      state.restarting = false;
      if (state.pendingRotation) {
        [index, modelIndex] = state.pendingRotation;
        state.pendingRotation = null;
        log(`[Rotator] Applying queued rotation: key #${index}, model #${modelIndex}.`);
      }

      // Re-check the target against the cooldown grid right before starting.
      // The quoted cooldown may have been too short, or another limit signal
      // may have blocked this combo while we waited — starting it anyway is
      // what surfaced "daily limit reached" to the user after a rotation.
      const resolved = rotation.resolveStartCombo(index, modelIndex);
      if (!resolved.available) {
        // Every combo is STILL on cooldown: re-park silently and try again
        // when the earliest one frees up. No user prompt here — the
        // all-cooldown notice already went out when the cooldown was detected.
        log(`[Rotator] Target still on cooldown and no free combo; re-parking on key #${resolved.key}, model #${resolved.model} for ${Math.round(resolved.waitMs / 60000)}m.`);
        scheduleRestart(resolved.key, resolved.model, resolved.waitMs, true);
        return;
      }
      if (resolved.key !== index || resolved.model !== modelIndex) {
        log(`[Rotator] Target key #${index}, model #${modelIndex} is on cooldown; switching to free key #${resolved.key}, model #${resolved.model} (${config.MODELS[resolved.model]}).`);
      }

      // Coming out of a full-cooldown park: only NOW is an available key+model
      // actually set, so this is the right moment to tell the user.
      if (afterCooldown) {
        chat.notifyUser(
          `🟢 Cooldown over — agent is back online with key #${resolved.key} / model ${config.MODELS[resolved.model]}. Pending work resumes automatically.`
        );
        state.probeRejectedRecently = false;   // this notice already confirmed the agent is back
      }
      startVerified(resolved.key, resolved.model);
    }, delay);
  });
}

function startCline(index, modelIndex) {
  state.curKeyIndex = index;
  state.curModelIndex = modelIndex;
  const args = buildArgs(index, modelIndex);
  const startedAt = Date.now();
  log(`[Rotator] Starting connector (key #${index}, model #${modelIndex})`);
  log(`[Rotator] pid=${process.pid} running: cline ${args.join(' ')}`);

  // SANITIZE the child environment. cline's CLI marks the connector children
  // IT spawns with internal lifecycle vars (CLINE_CONNECTOR_*,
  // CLINE_TELEGRAM_CONNECT_CHILD, …), and a wrapper launched from such a
  // context — or carrying stale CLINE_* exports like a bogus
  // CLINE_HUB_DISCOVERY_PATH — forwards them via process.env. A connector
  // that inherits them believes it is already a managed sub-connector and
  // skips normal hub discovery: it aborts with "discovery record is missing
  // or unreadable", exits code 1 ~2s after every start, and the wrapper
  // crash-loops through every key/model (exit is fast-exit < CRASH_ROTATE_MS
  // so nothing looks like a rate limit). Strip all cline-internal lifecycle
  // vars so the connector always runs as a clean top-level process.
  const STRIP_ENV_RE = /^CLINE_(CONNECTOR_|TELEGRAM_CONNECT_CHILD|NO_INTERACTIVE|HUB_DISCOVERY_PATH)/;
  const childEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!STRIP_ENV_RE.test(k)) childEnv[k] = v;
  }
  childEnv.CLINE_HUB_HOST = '127.0.0.1';
  childEnv.CLINE_HUB_PORT = String(config.rpcPort);
  // Only instances on a PRIVATE hub port get a private discovery record. The
  // default-port instance (MANAGER, 25463) resolves discovery itself via the
  // global production.json — any inherited override was already stripped above.
  if (config.rpcPort !== 25463) childEnv.CLINE_HUB_DISCOVERY_PATH = config.hubDiscoveryFile();

  // stdin is a pipe we keep open (never write/end it): a headless run inherits
  // /dev/null for stdin, and an immediate EOF there can make the foreground
  // connector quit right after starting.
  state.clineProcess = spawn('cline', args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
  state.currentClinePid = state.clineProcess.pid;

  // Startup feedback: on a (re)start that wasn't a key rotation, scan the
  // task list for incomplete work and tell the user what's pending. The
  // connector agent keeps its session and task list in the workspace, so it
  // picks those items up from there when the conversation continues.
  if (state.restartFromRotation) {
    state.restartFromRotation = false;
  } else {
    const progress = tasks.getTaskProgress();
    if (progress && progress.pending && progress.pending.length > 0) {
      const items = progress.pending.slice(0, 3).map((t) => `• ${t}`).join('\n');
      const more = progress.pending.length > 3 ? `\n…and ${progress.pending.length - 3} more` : '';
      chat.notifyUser(
        `🔄 Agent is back online — 📋 ${progress.done}/${progress.total} tasks completed. Picking up pending work:\n${items}${more}`
      );
    }
  }

  // Auto-resume: if this start follows a rotation/crash mid-task, drive the
  // pending task list through the hub once the fresh connector has settled.
  if (state.pendingResume) {
    const job = state.pendingResume;
    state.pendingResume = null;
    if (job.chatId) {
      log(`[Resume] Scheduling auto-resume (chat ${job.chatId}) in ${config.RESUME_DELAY_MS}ms.`);
      setTimeout(() => { resume.resumeAfterRotation(job.chatId).catch(() => { }); }, config.RESUME_DELAY_MS);
    }
  }

  state.clineProcess.on('error', (err) => {
    log(`[Rotator] Failed to start cline: ${err.message}`);
  });

  // Drain the child's stdout/stderr. Two reasons: (a) with nobody reading, the
  // pipe buffer (~64KB) eventually fills and blocks the connector mid-run;
  // (b) startup/limit errors (e.g. a 429 on the very first request) often only
  // appear here, before they reach the log files we tail — without this a bad
  // key would never trigger a rotation from its own output.
  for (const name of ['stdout', 'stderr']) {
    let carry = '';
    let logged = 0;                     // startup lines logged for this stream
    state.clineProcess[name].setEncoding('utf8');
    state.clineProcess[name].on('data', (chunk) => {
      carry += chunk;
      if (carry.length > 256 * 1024) carry = carry.slice(-128 * 1024);
      let nl;
      while ((nl = carry.indexOf('\n')) !== -1) {
        const line = carry.slice(0, nl).trim();
        carry = carry.slice(nl + 1);
        if (!line) continue;
        if (config.LIMIT_RE.test(line)) {
          chat.onTurnDone(false);
          onLimitSignal(`[child ${name}] ${line}`);
          continue;
        }
        // Surface fatal startup errors the limit filter would otherwise
        // swallow (e.g. the hub-discovery abort behind the crash loop was
        // invisible here for hours). Log the first lines of each stream plus
        // anything that looks like an error, capped to avoid log flooding.
        if (logged < 10 || /error|failed|fatal|EADDR|unauthorized|invalid|denied/i.test(line)) {
          logged++;
          log(`[child ${name}] ${line.slice(0, 300)}`);
        }
      }
    });
    state.clineProcess[name].on('error', () => { });   // stream errors must not crash the wrapper
  }

  state.clineProcess.on('close', (code) => {
    if (state.restarting || state.shuttingDown) return;    // a rotation's/shutdown's path takes over
    if (state.currentClinePid !== null) state.knownPids.add(state.currentClinePid);
    state.currentClinePid = null;
    state.clineProcess = null;

    const elapsedMs = Date.now() - startedAt;
    const delay = elapsedMs < 1000 ? Math.max(elapsedMs, 1000) : config.RESTART_DELAY_MS;
    log(`[Rotator] Connector exited with code ${code} after ${elapsedMs}ms.`);

    // A connector that dies this fast is rejecting its configuration —
    // invalid/exhausted key, bad model id… Check if stderr parsing already
    // detected a limit error and blocked the combo with the real cooldown.
    // If not, apply a short cooldown so the restart rotates to the next slot.
    if (elapsedMs < rotation.CRASH_ROTATE_MS) {
      const existingCooldown = rotation.comboUnblockAt(index, modelIndex);
      if (existingCooldown <= Date.now()) {
        // No limit error detected from stderr - apply short cooldown
        rotation.blockCombo(index, modelIndex, rotation.CRASH_COOLDOWN_MS, 'fast exit', `connector exited code ${code} after ${elapsedMs}ms`);
        log(`[Rotator] Fast exit; cooling key #${index} + model #${modelIndex} (${config.MODELS[modelIndex]}) for ${rotation.CRASH_COOLDOWN_MS / 60000}m.`);
      } else {
        // Limit error already detected from stderr - combo is already blocked
        log(`[Rotator] Fast exit; combo already blocked until ${new Date(existingCooldown).toISOString()} (limit detected from stderr).`);
      }
    }

    const next = rotation.pickNextCombo();
    const allCooling = next.waitMs > 0;
    if (allCooling) {
      log(`[Rotator] All combos on cooldown; parking on key #${next.key}, model #${next.model} for ${Math.round(next.waitMs / 60000)}m.`);
    } else {
      log(`[Rotator] Restarting with key #${next.key}, model #${next.model} (${config.MODELS[next.model]}) in ${delay}ms...`);
    }
    // Surface the crash restart to the user too (same as rate-limit rotations).
    // Prompt only when an available key+model is actually set; when everything
    // is on cooldown, just inform — the "back online" notice goes out later,
    // from scheduleRestart, once a free combo really starts.
    state.restartFromRotation = true;
    const progress = tasks.getTaskProgress();
    if (allCooling) {
      noticeCooldownPark(progress, next.waitMs);
      queueResume();   // arm the retry: when the cooldown expires and rotation sets a working key/model, resumeAfterRotation fires
    } else {
      chat.notifyUser(
        `🔁 Connector exited unexpectedly — restarting with key #${next.key} / model ${config.MODELS[next.model]}.`
        + (progress ? ` 📋 ${progress.done}/${progress.total} tasks completed.` : '')
        + ' Pending work resumes automatically.'
      );
      queueResume();
    }
    scheduleRestart(next.key, next.model, allCooling ? next.waitMs : delay, allCooling);
  });
}

// Test seam: when set, startVerified routes "start the connector" through this
// fn instead of startCline (used by test.rotation.sim.js to avoid real spawns).
let startOverride = null;
function doStart(index, modelIndex) {
  if (startOverride) { startOverride(index, modelIndex); return; }
  startCline(index, modelIndex);
}

function _setStartOverride(fn) {
  startOverride = typeof fn === 'function' ? fn : null;
}

// Availability-gated start — the "rotate, then TEST the key/model, or rotate
// again" requirement. Every connector start (boot and post-rotation restart)
// funnels through here: the (key, model) is probed against the live API first;
// only a passing combo is handed to startCline.
async function startVerified(index, modelIndex) {
  if (state.startPending) {
    log(`[Rotator] Start already in progress; queueing target key #${index}, model #${modelIndex}.`);
    state.pendingRotation = [index, modelIndex];
    return;
  }
  state.startPending = true;
  state.curKeyIndex = index;
  state.curModelIndex = modelIndex;

  if (!probe.PROBE_ENABLED) {
    log('[Probe] Pre-flight probe disabled; starting connector without a probe.');
    state.startPending = false;
    doStart(index, modelIndex);
    return;
  }

  let verdict;
  try {
    verdict = await probe.probeCombo(index, modelIndex);
  } catch (err) {
    state.startPending = false;
    log(`[Probe] Probe threw (${err.message}); starting key #${index}, model #${modelIndex} anyway.`);
    doStart(index, modelIndex);
    return;
  }
  if (state.shuttingDown) { state.startPending = false; return; }

  // A limit/crash signal landed while we probed (e.g. the previous connector's
  // dying log line). Its rotation target wins; if our probe still failed, keep
  // the block so the rotation never loops back onto this combo.
  if (state.pendingRotation) {
    const [pi, pm] = state.pendingRotation;
    state.pendingRotation = null;
    if (verdict && verdict.ok === false) {
      const unblockAt = rotation.blockCombo(index, modelIndex, verdict.cooldownMs || rotation.COOLDOWN_DEFAULT_MS, verdict.reason, verdict.detail);
      log(`[Probe] Superseded by a rotation, but key #${index} + model #${config.MODELS[modelIndex]} was blocked until ${new Date(unblockAt).toISOString()} (${verdict.reason}).`);
    }
    state.startPending = false;
    scheduleRestart(pi, pm, config.RESTART_DELAY_MS, false);
    return;
  }

  if (verdict && verdict.ok === true) {
    state.startPending = false;
    if (state.probeRejectedRecently) {
      state.probeRejectedRecently = false;
      chat.notifyUser(`🟢 Found a working key/model — back online with key #${index} / model ${config.MODELS[modelIndex]}. Pending work resumes automatically.`);
    }
    doStart(index, modelIndex);
    return;
  }

  if (verdict && verdict.ok === false) {
    state.startPending = false;
    onProbeReject(index, modelIndex, verdict.cooldownMs || rotation.COOLDOWN_DEFAULT_MS, verdict.reason, verdict.detail, verdict.modelScoped);
    return;
  }

  // Inconclusive probe (network/timeout/unclassified): DON'T block the combo —
  // start anyway; the runtime limit/crash detection remains the safety net.
  state.startPending = false;
  doStart(index, modelIndex);
}

// A pre-flight probe came back with a DEFINITIVE provider failure (invalid key,
// unknown model, exhausted quota, …). Block the tested combo, pick the next
// one, and probe it — switching slots until one actually answers.
function onProbeReject(key, model, cooldownMs, reason, detail, modelScoped) {
  if (state.shuttingDown) return;

  // A model-scoped limit ("daily free limit on model X") affects ALL keys on
  // that model — block every combo on the model so rotation skips the whole
  // model at once instead of trying each key individually.
  if (modelScoped) {
    for (let k = 0; k < config.API_KEYS.length; k++) {
      rotation.blockCombo(k, model, cooldownMs, 'probe rejected (model-scoped)', detail);
    }
    log(`[Probe] Blocked ALL ${config.API_KEYS.length} keys on model #${model} (${config.MODELS[model]}) — model-scoped limit`);
  } else {
    const unblockAt = rotation.blockCombo(key, model, cooldownMs, reason, detail);
    log(`[Probe] Blocked key #${key} + model #${model} (${config.MODELS[model]}) until ${new Date(unblockAt).toISOString()} — ${reason}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`);
  }

  // If the probe rejected due to a rate limit, mark the model so nextCombo
  // prefers to rotate to a different model (model-scoped limit affects all keys).
  if (/quota|rate limit|daily free limit|too many requests|limit reached/i.test(reason)) {
    state.modelLimitHit.add(model);
  }

  // Use pickNextComboFromStart to do a FULL LOOP through all combos from slot 0.
  // This ensures every key/model is tested, not just the ones after the current
  // position (which may be randomized).
  const next = rotation.pickNextComboFromStart();
  const allCooling = next.waitMs > 0;
  const progress = tasks.getTaskProgress();
  state.restartFromRotation = true;
  state.probeRejectedRecently = true;

  if (allCooling) {
    log(`[Probe] All ${config.API_KEYS.length}×${config.MODELS.length} combos unavailable; retrying in ${Math.round(next.waitMs / 60000)}m.`);
    chat.notifyUser(
      `⛔ Preflight check found every API key/model unavailable right now${progress ? ` (📋 ${progress.done}/${progress.total} tasks completed)` : ''}. I'll keep probing automatically and let you know when the agent is back online.\n\n${rotation.gridStatus()}`
    );
  } else {
    log(`[Probe] Rotating to key #${next.key}, model #${next.model} (${config.MODELS[next.model]})`);
    // A sweep over several dead combos must not spam the chat — throttled and
    // pointed at the concrete next target. When one finally passes, the
    // "back online" notice from startVerified closes the loop.
    const now = Date.now();
    if (now - state.lastProbeNoticeAt >= probe.PROBE_NOTICE_THROTTLE_MS) {
      state.lastProbeNoticeAt = now;
      chat.notifyUser(
        `🔁 Preflight check rejected key #${key} / model ${config.MODELS[model]} (${reason}) — testing key #${next.key} / model ${config.MODELS[next.model]} next.`
        + (progress ? ` 📋 ${progress.done}/${progress.total} tasks completed.` : '')
        + ' Pending work resumes automatically once a key/model passes.'
      );
    }
  }
  scheduleRestart(next.key, next.model, allCooling ? next.waitMs : config.RESTART_DELAY_MS, allCooling);
}

// Guards against reacting twice to the same underlying error: cline logs each
// failed turn as both "Telegram reply failed" and "Telegram turn handling
// failed", so the same 429 produces two DIFFERENT limit lines ~1ms apart. An
// exact-line comparison can't catch that, so we use a time window instead.
const LIMIT_DEDUPE_MS = 5000;

function onLimitSignal(line) {
  if (state.shuttingDown) return;            // never re-arm restarts while shutting down
  const now = Date.now();
  if (now - state.lastLimitHandledAt < LIMIT_DEDUPE_MS) {
    log(`[Rotator] Duplicate limit signal within ${LIMIT_DEDUPE_MS}ms window; ignoring.`);
    return;
  }
  state.lastLimitHandledAt = now;

  log(`[Rotator] Limit detected in cline log: ${line.slice(0, 300)}`);

  // This exact (key, model) pair is exhausted. From here on we skip it until
  // the cooldown quoted in the error (or a default) has passed.
  const cooldownMs = rotation.parseCooldownMs(line) || rotation.COOLDOWN_DEFAULT_MS;

  // A model-scoped limit ("daily free limit on model X") affects ALL keys on
  // that model — block every combo on the model so rotation skips the whole
  // model at once instead of trying each key individually (which would emit
  // one error per key).
  const isModelScoped = /daily free limit|model .* (limit|exhausted|quota)/i.test(line);
  if (isModelScoped) {
    for (let k = 0; k < config.API_KEYS.length; k++) {
      rotation.blockCombo(k, state.curModelIndex, cooldownMs, 'limit signal (model-scoped)', line.slice(0, 300));
    }
    log(`[Rotator] Blocked ALL ${config.API_KEYS.length} keys on model #${state.curModelIndex} (${config.MODELS[state.curModelIndex]}) until ${new Date(now + cooldownMs).toISOString()} (model-scoped limit)`);
  } else {
    const unblockAt = rotation.blockCombo(state.curKeyIndex, state.curModelIndex, cooldownMs, 'limit signal', line.slice(0, 300));
    log(`[Rotator] Blocked key #${state.curKeyIndex} + model #${state.curModelIndex} (${config.MODELS[state.curModelIndex]}) until ${new Date(unblockAt).toISOString()}`);
  }

  // Mark the model as limit-hit so nextCombo prefers to rotate to a DIFFERENT
  // model rather than trying more keys on the same exhausted model.
  state.modelLimitHit.add(state.curModelIndex);

  const next = rotation.pickNextCombo();
  const allCooling = next.waitMs > 0;
  if (allCooling) {
    // Every key×model combo is exhausted right now: stop hammering and sleep
    // until the earliest one frees up (plus a grace period), then restart with
    // that exact combo.
    log(`[Rotator] All ${config.API_KEYS.length}×${config.MODELS.length} combos on cooldown. Waiting ${Math.round(next.waitMs / 60000)}m before retrying.`);
  } else {
    log(`[Rotator] Rotating to key #${next.key}, model #${next.model} (${config.MODELS[next.model]})`);
  }

  // Rotate silently — the user sees the connector's own error message, so a
  // wrapper notice would only be redundant noise. The auto-resume is queued
  // in BOTH branches — it must retry the last user message until rotation
  // actually sets a working key/model (see scheduleRestart's afterCooldown
  // path, which fires resumeAfterRotation on the next start).
  state.restartFromRotation = true;
  if (allCooling) {
    queueResume();   // arm the retry: when the cooldown expires and rotation sets a working key/model, resumeAfterRotation fires
  } else {
    queueResume();
  }

  scheduleRestart(next.key, next.model, allCooling ? next.waitMs : config.RESTART_DELAY_MS, allCooling);
}

module.exports = {
  startVerified,
  scheduleRestart,
  stopCurrent,
  onLimitSignal,
  onProbeReject,
  queueResume,
  _setStartOverride,
};