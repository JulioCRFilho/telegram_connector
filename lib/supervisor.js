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
const lastmessage = require('./lastmessage');
const cooldowns = require('./cooldowns');

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

// Human-safe echo of the launched command: the bot token and every API key
// must NEVER land in logs (connector.log and wrapper-*.out are kept around
// indefinitely for debugging) — mask like "12…456".
function redactSecret(value) {
  const v = String(value);
  if (v.length <= 6) return '***';
  return `${v.slice(0, 2)}…${v.slice(-2)}`;
}
function safeArgsEcho(args) {
  const secrets = new Set(config.API_KEYS);
  secrets.add(config.TELEGRAM_BOT_TOKEN);
  return args.map((a) => (secrets.has(a) ? redactSecret(a) : a));
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
// Event-driven: ONE short human line — the detailed grid lives in /keys.
function noticeCooldownPark(progress, waitMs) {
  chat.notifyUser(
    `⚠️ All AI providers are rate-limited right now (next free ~${new Date(Date.now() + waitMs).toISOString().slice(11, 16)} UTC).`
    + (progress ? ` ${progress.done}/${progress.total} tasks done so far.` : '')
    + " Everything is saved — I'll start automatically as soon as capacity frees up."
  );
}

// ── Cooldown park ───────────────────────────────────────────────────────────
// When every key×model combo is on a real daily-limit cooldown the wrapper
// parks instead of hammering the API. Two timers work together:
//   • a WAKE timer for the REAL earliest unblock (re-validated from disk when
//     it fires — the grid may have changed, or a peer wrote longer blocks);
//   • an ACK interval that polls Telegram getUpdates while no connector is
//     running, so a user message gets a "queued" reply and is persisted for the
//     auto-resume instead of sitting unanswered for hours (the "agents are
//     frozen" report).
// The wake path replaces the old `scheduleRestart(…, waitMs, true)` recursion —
// a single long setTimeout is fragile: a stale out-of-grid cooldown record (a
// config change) or a competing signal could shrink it to the 30s floor and
// turn the park into an endless re-park busy loop with NO connector running.
const PARK_ACK_INTERVAL_MS = 30 * 1000;
// While ALL key×model combos are cooling, a REFRESH ROUND re-consults the
// persisted grid every interval instead of blindly sleeping until the quoted
// unblock time: peers may update cooldowns, a stale record may heal, a block
// may have been over-quoted — the fresh scan then exits the park early (and
// the recomputed wait keeps the wake timer accurate). Override with
// TELEGRAM_PARK_REFRESH_INTERVAL_MS.
const PARK_REFRESH_INTERVAL_MS = Math.max(
  parseInt(process.env.TELEGRAM_PARK_REFRESH_INTERVAL_MS || '', 10) || 10 * 60 * 1000,
  30 * 1000
);
// Only re-arm the park timer when the fresh earliest-unblock moved EARLIER by
// more than this (later shifts are handled at wake by the existing re-check).
const PARK_REPARK_EPS_MS = 2 * 60 * 1000;
let parkWakeTimer = null;
let parkAckInterval = null;
let parkRefreshInterval = null;
let parkWakeAt = 0;

function clearParkMonitor() {
  if (parkWakeTimer) { clearTimeout(parkWakeTimer); parkWakeTimer = null; }
  if (parkAckInterval) { clearInterval(parkAckInterval); parkAckInterval = null; }
  if (parkRefreshInterval) { clearInterval(parkRefreshInterval); parkRefreshInterval = null; }
  parkWakeAt = 0;
  // Either the connector is starting again or a re-park immediately re-sets
  // this — either way the wrapper must not advertise "parked" while the park
  // machinery is down (the health watcher restarts connector-less wrappers).
  procs.markParked(0);
}

// Periodically re-validates the "all 18 combos cooling" decision while parked.
// A fresh ROUND = reload the persisted grid + recompute the rotation scan:
//   1. a combo freed (record healed / peer cleared / quoted time over-quoted)
//      → leave the park NOW and start on it, instead of sleeping the old wait;
//   2. the earliest unblock moved earlier by peers → re-arm the wake timer;
//   3. nothing changed → keep the current park untouched (logged each round).
function refreshParkRound() {
  if (state.shuttingDown || state.restarting || state.startPending) return;
  if (!parkWakeTimer) return;                       // not parked anymore
  log('[Rotator] Park refresh round: re-consulting the cooldown grid...');
  cooldowns.load();                                 // peers may have updated blocks
  const p = rotation.pickNextCombo();
  if (p.waitMs === 0) {
    // Something freed early — leave the park right now.
    clearParkMonitor();
    log(`[Rotator] Refresh round: key #${p.key} / model #${config.MODELS[p.model]} freed early — leaving park.`);
    chat.notifyUser(
      `✅ A provider freed up early — back online. Picking up the queued work now.`
    );
    state.probeRejectedRecently = false;
    startVerified(p.key, p.model);
    return;
  }
  const newWake = Date.now() + p.waitMs;
  if (newWake < parkWakeAt - PARK_REPARK_EPS_MS) {
    log(`[Rotator] Refresh round: earliest free moved earlier to ${new Date(newWake).toISOString()} — re-parking.`);
    startParkMonitor(p.key, p.model, p.waitMs);
    return;
  }
  log(`[Rotator] Refresh round: all combos still cooling (wake ${new Date(parkWakeAt).toISOString()} unchanged); next round in ${Math.max(1, Math.round(PARK_REFRESH_INTERVAL_MS / 60000))}m.`);
}

function startParkMonitor(key, model, waitMs) {
  clearParkMonitor();
  const wakeAt = Date.now() + Math.max(waitMs, 30 * 1000);
  parkWakeAt = wakeAt;
  log(`[Rotator] Parking on key #${key} / model #${config.MODELS[model]} until ${new Date(wakeAt).toISOString()} (${Math.round(Math.max(waitMs, 30 * 1000) / 60000)}m).`);
  // Advertise the park window so the health watcher knows the missing
  // connector child is intentional, not a crash (it used to restart parked
  // wrappers every health pass — an endless park↔restart loop).
  procs.markParked(wakeAt);

  // While parked NO connector is running — the wrapper polls Telegram itself so
  // queued messages are acknowledged + persisted instead of ignored.
  parkAckInterval = setInterval(() => {
    if (state.restarting || state.startPending || state.shuttingDown) return;
    chat.ackQueuedDuringPark(wakeAt).catch(() => { });
  }, PARK_ACK_INTERVAL_MS);
  if (parkAckInterval.unref) parkAckInterval.unref();   // test/restart must not be kept alive by it

  // Fresh-round re-validation while parked (see refreshParkRound).
  parkRefreshInterval = setInterval(refreshParkRound, PARK_REFRESH_INTERVAL_MS);
  if (parkRefreshInterval.unref) parkRefreshInterval.unref();

  parkWakeTimer = setTimeout(() => {
    if (state.shuttingDown) return;
    clearParkMonitor();
    log('[Rotator] Cooldown park window over; re-checking the grid.');
    // Reconcile with the persisted grid before deciding: another instance may
    // have written longer blocks while we slept.
    cooldowns.load();
    const p = rotation.pickNextCombo();
    if (p.waitMs > 0) {
      log(`[Rotator] Still cooling; re-parking for ${Math.round(p.waitMs / 60000)}m.`);
      startParkMonitor(p.key, p.model, p.waitMs);
      return;
    }
    if (state.restarting || state.startPending) return;  // a restart chain owns the start
    chat.notifyUser(
      `✅ Capacity is back — online again. Picking up the queued work now.`
    );
    state.probeRejectedRecently = false;   // the back-online notice closes the loop
    startVerified(p.key, p.model);
  }, Math.max(waitMs, 30 * 1000));
}

// Entry point for the "everything on cooldown" state: stop the connector (if
// any), purge stale daemons so nothing fights over the bot token, and arm the
// park monitor. If a restart/probe chain is already in flight, defer to it
// (its continuation resolves to the same all-blocked state and parks).
function parkOnCooldown(key, model, waitMs) {
  if (state.shuttingDown) return;
  if (state.restarting || state.startPending) {
    state.pendingRotation = [key, model];
    log(`[Rotator] Park deferred (restart/probe in flight); queueing park target key #${key}, model #${model}.`);
    return;
  }
  state.restarting = true;
  stopCurrent(() => {
    procs.purgeStale();
    state.restarting = false;
    state.pendingRotation = null;
    startParkMonitor(key, model, waitMs);
  });
}

function scheduleRestart(index, modelIndex, delay = config.RESTART_DELAY_MS) {
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
      // Reconcile with the PERSISTED grid first: another instance (or a
      // previous config) may have left longer/extra records in the shared file
      // that this process's in-memory map doesn't know about yet — trusting
      // only in-memory state here is what let the park collapse to a 30s
      // re-park loop after a config change.
      cooldowns.load();
      const resolved = rotation.resolveStartCombo(index, modelIndex);
      if (!resolved.available) {
        // Every combo is STILL on cooldown: arm the park monitor (real-earliest
        // wake + getUpdates ack while down). No user prompt here — the
        // all-cooldown notice already went out when the cooldown was detected.
        state.pendingRotation = null;
        startParkMonitor(resolved.key, resolved.model, resolved.waitMs);
        return;
      }
      if (resolved.key !== index || resolved.model !== modelIndex) {
        log(`[Rotator] Target key #${index}, model #${modelIndex} is on cooldown; switching to free key #${resolved.key}, model #${resolved.model} (${config.MODELS[resolved.model]}).`);
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
  log(`[Rotator] pid=${process.pid} running: cline ${safeArgsEcho(args).join(' ')}`);

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
  state.clineProcess.setMaxListeners(20);   // repeated restarts add many listeners; don't let the default-10 cap warn/leak
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
        `✅ Back online — ${progress.done}/${progress.total} tasks done. Continuing with:\n${items}${more}`
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
        // Feed the pending-task dossier: if this request is ever interrupted,
        // the resume prompt uses these lines to tell the fresh session what
        // was already done (a fresh hub session has no other memory).
        lastmessage.noteProgress(line);
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
      parkOnCooldown(next.key, next.model, next.waitMs);
    } else {
      chat.notifyUser(
        `⚠️ The connection dropped — restarting now. Your work resumes automatically.`
        + (progress ? ` (${progress.done}/${progress.total} tasks done so far.)` : '')
      );
      queueResume();
      scheduleRestart(next.key, next.model, delay);
    }
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
    scheduleRestart(pi, pm, config.RESTART_DELAY_MS);
    return;
  }

  if (verdict && verdict.ok === true) {
    state.startPending = false;
    if (state.probeRejectedRecently) {
      state.probeRejectedRecently = false;
      chat.notifyUser(`✅ Back online. Picking up where I left off.`);
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

  // IMPORTANT: the daily free limit is enforced PER API KEY — a probe failure
  // on (key, model) says nothing about the other keys' quota on that model.
  // Always block ONLY the tested combo (the modelScoped flag is kept in the
  // signature for compatibility but no longer widens the block); the grid
  // converges on the truth as other keys are probed/used in turn.
  const unblockAt = rotation.blockCombo(key, model, cooldownMs, reason, detail);
  log(`[Probe] Blocked key #${key} + model #${model} (${config.MODELS[model]}) until ${new Date(unblockAt).toISOString()} — ${reason}${detail ? ' — ' + String(detail).slice(0, 200) : ''}${modelScoped ? ' (limit text named the model; blocked this key only)' : ''}`);

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
    log(`[Probe] All ${config.API_KEYS.length}×${config.MODELS.length} combos unavailable; parking for ${Math.round(next.waitMs / 60000)}m.`);
    chat.notifyUser(
      `⚠️ All AI providers are unavailable right now (next free ~${new Date(Date.now() + next.waitMs).toISOString().slice(11, 16)} UTC).`
      + (progress ? ` ${progress.done}/${progress.total} tasks done so far.` : '')
      + " I'll keep checking automatically and start as soon as one is available."
    );
    parkOnCooldown(next.key, next.model, next.waitMs);
  } else {
    log(`[Probe] Rotating to key #${next.key}, model #${next.model} (${config.MODELS[next.model]})`);
    // A sweep over several dead combos must not spam the chat — throttled and
    // pointed at the concrete next target. When one finally passes, the
    // "back online" notice from startVerified closes the loop.
    const now = Date.now();
    if (now - state.lastProbeNoticeAt >= probe.PROBE_NOTICE_THROTTLE_MS) {
      state.lastProbeNoticeAt = now;
      chat.notifyUser(
        `⚠️ ${reason || 'One of the AI providers'} was rejected — trying another one. Your work resumes automatically as soon as one works.`
        + (progress ? ` (${progress.done}/${progress.total} tasks done so far.)` : '')
      );
    }
    scheduleRestart(next.key, next.model, config.RESTART_DELAY_MS);
  }
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

  // IMPORTANT: the daily free limit is enforced PER API KEY (that is the whole
  // reason key rotation exists — each key has its own quota for every model).
  // Even though the error text names the model ("daily free limit reached on
  // model X"), blocking ALL keys on that model from ONE key's 429 idles the
  // other keys' live quota for the entire quoted cooldown (the 18-block grid
  // bug). Block ONLY the combo that actually got the 429; if other keys on the
  // model are also exhausted, they will 429 in turn and block themselves —
  // the grid then converges on exactly the truth.
  const unblockAt = rotation.blockCombo(state.curKeyIndex, state.curModelIndex, cooldownMs, 'limit signal', line.slice(0, 300));
  log(`[Rotator] Blocked key #${state.curKeyIndex} + model #${state.curModelIndex} (${config.MODELS[state.curModelIndex]}) until ${new Date(unblockAt).toISOString()}`);

  // Note this model produced a limit hit (informational; the grid itself now
  // drives every skip decision — no model-wide demotion anymore).
  state.modelLimitHit.add(state.curModelIndex);

  const next = rotation.pickNextCombo();
  const allCooling = next.waitMs > 0;
  if (allCooling) {
    // Every key×model combo is exhausted right now: stop hammering and sleep
    // until the earliest one frees up (plus a grace period), then restart with
    // that exact combo. Tell the user — nothing else will write to the chat
    // for a long time, and messages during the park are answered by the park
    // poller's "queued" note.
    const progress = tasks.getTaskProgress();
    noticeCooldownPark(progress, Math.max(next.waitMs, 30 * 1000));
    log(`[Rotator] All ${config.API_KEYS.length}×${config.MODELS.length} combos on cooldown. Parking ${Math.round(next.waitMs / 60000)}m until a combo frees.`);
  } else {
    log(`[Rotator] Rotating to key #${next.key}, model #${next.model} (${config.MODELS[next.model]})`);
  }

  // The bridge's own raw JSON error reaches the chat before we can act; add
  // ONE concise line so it reads as "handled" instead of a dead-end. The park
  // branch notifies through noticeCooldownPark instead.
  chat.notifyUser(
    `🔑 ${config.MODELS[state.curModelIndex]} hit its daily free limit — rotating to key #${next.key} / ${config.MODELS[next.model]}. Your message retries automatically.`
  );
  // Rotate — the user sees the bridge's error plus the notice above; anything
  // more would be redundant noise. The auto-resume is queued in BOTH branches
  // — it must retry the last user message until rotation actually sets a
  // working key/model (parkOnCooldown's wake path and scheduleRestart both
  // fire resumeAfterRotation on the next start).
  state.restartFromRotation = true;
  queueResume();   // arm the retry: when rotation sets a working key/model, resumeAfterRotation fires
  if (allCooling) {
    parkOnCooldown(next.key, next.model, next.waitMs);
  } else {
    scheduleRestart(next.key, next.model, config.RESTART_DELAY_MS);
  }
}

// ── Timeout handling ──────────────────────────────────────────────────────
// The bridge's "The operation timed out." (turn handling failed / reply
// failed) does NOT match LIMIT_RE — a timeout is not a quota error. But a
// combo that times out repeatedly is unusable all the same. Policy:
//   • 1–2 strikes: SHORT cooldown (3 min default) on the current combo only,
//     then rotate — timeouts are usually transient congestion.
//   • 3+ consecutive strikes (no successful turn in between, and none in the
//     last 30 min): escalate to a 15 min cooldown.
//   • Never model-scoped: a timeout says nothing about the model's quota.
// Like onLimitSignal, cline logs the same failure twice ("Telegram reply
// failed" + "Telegram turn handling failed"), so the same dedupe window
// applies. Cross-deduped with limit signals via state.lastLimitHandledAt — a
// turn whose error text matches both families must only react once.
const TIMEOUT_STRIKE_RESET_MS = 30 * 60 * 1000;
let timeoutStrikes = 0;
let lastTimeoutAt = 0;

function onTimeoutSignal(line) {
  if (state.shuttingDown) return;
  const now = Date.now();
  if (now - state.lastLimitHandledAt < LIMIT_DEDUPE_MS) {
    log(`[Rotator] Duplicate timeout/limit signal within ${LIMIT_DEDUPE_MS}ms window; ignoring.`);
    return;
  }
  state.lastLimitHandledAt = now;

  // Strike counting: consecutive only (a >30 min gap means a different
  // incident — the provider may have recovered long ago).
  timeoutStrikes = now - lastTimeoutAt > TIMEOUT_STRIKE_RESET_MS ? 1 : timeoutStrikes + 1;
  lastTimeoutAt = now;
  const escalated = timeoutStrikes >= config.TIMEOUT_ESCALATE_AFTER_STRIKES;
  const cooldownMs = escalated ? config.TIMEOUT_ESCALATED_MS : config.TIMEOUT_COOLDOWN_MS;

  log(`[Rotator] Timeout detected (strike ${timeoutStrikes}) in cline log: ${line.slice(0, 300)}`);

  const unblockAt = rotation.blockCombo(
    state.curKeyIndex, state.curModelIndex, cooldownMs,
    escalated ? `timeout (escalated, ${timeoutStrikes} strikes)` : 'timeout',
    line.slice(0, 300)
  );
  log(`[Rotator] Blocked key #${state.curKeyIndex} + model #${state.curModelIndex} (${config.MODELS[state.curModelIndex]}) until ${new Date(unblockAt).toISOString()} (${escalated ? 'escalated ' : ''}timeout cooldown ${Math.round(cooldownMs / 1000)}s)`);

  const next = rotation.pickNextCombo();
  const allCooling = next.waitMs > 0;
  if (allCooling) {
    const progress = tasks.getTaskProgress();
    noticeCooldownPark(progress, Math.max(next.waitMs, 30 * 1000));
    log(`[Rotator] All ${config.API_KEYS.length}×${config.MODELS.length} combos on cooldown. Parking ${Math.round(next.waitMs / 60000)}m until a combo frees.`);
  } else {
    log(`[Rotator] Rotating to key #${next.key}, model #${next.model} (${config.MODELS[next.model]})`);
  }

  // Same resume contract as onLimitSignal: retry the last user message once a
  // working combo is up (park wake path or scheduleRestart both fire it) —
  // but every retry re-runs the task from scratch (token cost), so timeouts
  // share the per-message provider-retry budget: past the cap, stop auto-
  // retrying and hand control back to the user.
  if ((state.resumeProviderRetries || 0) + 1 >= resume.RESUME_MAX_PROVIDER_RETRIES) {
    log('[Rotator] Timeout retries exhausted the resume budget for this message; not auto-retrying (token guard).');
    lastmessage.clear();
    state.lastUserMessage = null;
    state.resumeProviderRetries = 0;
    const chatId = state.lastSeenChatId || config.ALLOWED_USER_ID || null;
    if (chatId) chat.sendTelegramMessage(chatId, `⚠️ The current task timed out repeatedly across key/model switches. I stopped auto-retrying to save your quota — send it again and I'll take a fresh run at it.`).catch(() => { });
    state.restartFromRotation = true;
    if (allCooling) {
      parkOnCooldown(next.key, next.model, next.waitMs);
    } else {
      scheduleRestart(next.key, next.model, config.RESTART_DELAY_MS);
    }
    return;
  }
  state.restartFromRotation = true;
  queueResume();
  if (allCooling) {
    parkOnCooldown(next.key, next.model, next.waitMs);
  } else {
    scheduleRestart(next.key, next.model, config.RESTART_DELAY_MS);
  }
}

// A completed turn proves the current combo works again — clear the strike
// counter so a future isolated timeout starts from scratch.
function clearTimeoutStrikes() {
  timeoutStrikes = 0;
  lastTimeoutAt = 0;
}

// Test seam for the timeout strike counter (module-local otherwise).
function _getTimeoutStrikes() { return timeoutStrikes; }

// ── Live-combo grid watcher ────────────────────────────────────────────────
// The persisted cooldown grid is SHARED between instances: when EVOL hits a
// daily limit, it blocks the whole model for every key — but MANAGER's live
// connector keeps running on the now-exhausted model until a USER message
// triggers the raw 429 in the chat (observed: EVOL discovered the z-ai limit
// at 15:38, MANAGER stayed on z-ai and re-hit it at 15:54 — one avoidable
// raw bridge error). The watcher re-checks every tick whether the CURRENT
// combo has become blocked (by us or by a peer) and rotates proactively,
// BEFORE any user message can hit the dead combo.
const GRID_WATCH_INTERVAL_MS = 30 * 1000;
let gridWatchTimer = null;

function gridWatchTick() {
  if (state.shuttingDown || state.restarting || state.startPending) return;
  if (parkWakeTimer) return;              // parked on purpose — the park monitor owns the wake-up
  if (state.lastLimitHandledAt && Date.now() - state.lastLimitHandledAt < LIMIT_DEDUPE_MS) return;
  const unblockAt = rotation.comboUnblockAt(state.curKeyIndex, state.curModelIndex);
  if (!unblockAt || unblockAt <= Date.now()) return;

  log(`[Rotator] Grid watcher: current combo key #${state.curKeyIndex} / model ${config.MODELS[state.curModelIndex]} is blocked (until ${new Date(unblockAt).toISOString()}) — rotating proactively before any user message hits the limit.`);
  const next = rotation.pickNextCombo();
  if (next.waitMs > 0) {
    // Everything is cooling (a peer parked the grid): stop the live connector
    // on the dead combo and park exactly like onLimitSignal does.
    state.restartFromRotation = true;
    queueResume();
    parkOnCooldown(next.key, next.model, next.waitMs);
  } else {
    chat.notifyUser(`🔒 Key/model hit its daily free limit — rotating to key #${next.key} / ${config.MODELS[next.model]}. Your messages retry automatically.`);
    state.restartFromRotation = true;
    queueResume();
    scheduleRestart(next.key, next.model, config.RESTART_DELAY_MS);
  }
}

function startGridWatcher() {
  if (gridWatchTimer) return;
  gridWatchTimer = setInterval(gridWatchTick, GRID_WATCH_INTERVAL_MS);
  gridWatchTimer.unref?.();
}

function stopGridWatcher() {
  if (gridWatchTimer) { clearInterval(gridWatchTimer); gridWatchTimer = null; }
}

// /reset chat command — zeroes every key×model cooldown record (memory +
// persisted file) so all combos are marked available again. If the wrapper was
// PARKED (no connector running), it wakes immediately and probes a fresh
// combo; a running connector is left alone (the cleared grid takes effect on
// its next rotation). Returns the number of cleared records for the reply.
function resetAndWake() {
  const cleared = cooldowns.resetAll();
  const wasParked = parkWakeTimer !== null;
  clearParkMonitor();
  if (wasParked && !state.shuttingDown && !state.restarting && !state.startPending) {
    const boot = rotation.recommendCombo();
    state.restartFromRotation = false;
    log(`[Rotator] /reset: waking from park → key #${boot.key}, model #${config.MODELS[boot.model]}.`);
    setTimeout(() => startVerified(boot.key, boot.model), config.RESTART_DELAY_MS);
  }
  return cleared;
}

module.exports = {
  startVerified,
  scheduleRestart,
  stopCurrent,
  onLimitSignal,
  onTimeoutSignal,
  clearTimeoutStrikes,
  _getTimeoutStrikes,
  startGridWatcher,
  stopGridWatcher,
  gridWatchTick,
  onProbeReject,
  queueResume,
  parkOnCooldown,
  clearParkMonitor,
  resetAndWake,
  _refreshParkRound: refreshParkRound,
  _isParkActive: () => parkWakeTimer !== null,
  _setStartOverride,
  resetAndWake,
};

// Register the /reset handler with chat (chat avoids requiring supervisor to
// dodge the circular dependency; supervisor wires itself in here).
chat.setResetHandler(resetAndWake);

// Liveness for the chat's 10-min health-check feedback: the connector child
// being alive is the whole signal (a momentary false during a rotation is
// honestly reported as "reconnecting in the background").
chat.setHealthProvider(() => ({ alive: state.currentClinePid !== null && !state.shuttingDown }));

// External reset (reset-grid.js / `npm run reset`): the standalone CLI zeroes
// the shared grid file and SIGUSR2s every live wrapper so it re-evaluates
// immediately. This path needs NO agent and NO Telegram — it works even when
// the connector is frozen, which is exactly when the reset is needed most.
process.on('SIGUSR2', () => {
  log('[Rotator] SIGUSR2: external grid reset received — re-evaluating cooldowns now.');
  try { resetAndWake(); } catch (err) { log(`[Rotator] External reset failed: ${err.message}`); }
});