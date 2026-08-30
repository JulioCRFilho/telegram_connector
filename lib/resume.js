const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');
const state = require('./state');
const chat = require('./chat');
const tasks = require('./tasks');
const lastmessage = require('./lastmessage');
const rotation = require('./rotation');

// A resumed run that fails for a NON-provider reason (hub gone, workspace
// issue, exception in the agent) is not going to succeed by retrying on the
// next rotation — cap the attempts so the user doesn't get endless repeat
// "couldn't auto-resume" notices, then drop the persisted message. Rate-limit
// / bad-key failures DON'T count: they legitimately rotate and retry.
const RESUME_MAX_FAILURES = 2;

// ── Auto-resume after rotation ──────────────────────────────────────────────
// A rotation restarts the connector, but the interrupted task used to just die
// — the agent only continued when the user messaged again. Now the wrapper
// talks to its instance's hub directly: it creates a hosted session in the
// agent's workspace (with the NEW key/model that just rotated in), injects a
// "continue the task list" prompt, awaits the result and reports it to the user
// (or reports the list is finished).
//
// Hub wire protocol (reverse-engineered from the CLI binary):
//   WS auth   : Sec-WebSocket-Protocol: "cline-hub-auth.<authToken>"
//   request   : {kind:"command", envelope:{version:"v1", clientId, command,
//               payload, requestId}}
//   reply     : {kind:"reply", envelope:{requestId, ok, payload?, error?}}
// ─────────────────────────────────────────────────────────────────────────────

// 'ws' is a hard dependency of the cline CLI install (the same install that
// provides the connector binary), so requiring it by absolute path is safe.
const HUB_WS = (() => {
  const candidates = [];
  try {
    const real = fs.realpathSync(process.env.CLINE_WRAPPER_PATH || '/opt/homebrew/bin/cline');
    candidates.push(path.join(path.dirname(real), '..', 'node_modules', 'ws'));
  } catch (_) { }
  candidates.push('/opt/homebrew/lib/node_modules/cline/node_modules/ws');
  for (const c of candidates) {
    try { return require(c); } catch (_) { }
  }
  return null;
})();

// The continuation prompt: tasklist-driven, self-contained (the fresh session
// has no chat context, but the workspace and its task list persist).
function resumePrompt(taskFile) {
  return 'Your previous run was interrupted by an API rate limit; connectivity has been restored with a fresh key. Continue the interrupted work now: open the task list at ' + taskFile + ' and complete the remaining unchecked ("- [ ]") items one by one, exactly as specified there. When you finish (or if nothing is pending), reply with a short summary: what you completed, what still remains, and any blockers.';
}

// Generic continuation prompt when there is no task list — the fresh session has
// no chat context, so we hand it the last user message verbatim to answer.
function genericResumePrompt(lastMessage) {
  const quoted = lastMessage
    ? `The user's message you had not yet answered was:\n\n"${lastMessage}"\n\n`
    : '';
  return 'Your previous run was interrupted by an API rate limit; connectivity has been restored with a fresh key. '
    + 'Continue the conversation from where you left off — the user is waiting for an answer. '
    + quoted
    + 'Answer their request now (or, if you already partially replied, complete the remaining part). Check the workspace for any partial output from your interrupted run and build on it rather than starting over.';
}

// Opens an authenticated connection to this instance's hub, registers, then
// hands a `call(command, payload, timeoutMs)` helper to fn(). Closes on exit.
async function withHub(fn) {
  if (!HUB_WS) throw new Error('ws module unavailable — auto-resume disabled');
  const disc = JSON.parse(fs.readFileSync(config.hubDiscoveryRecord(), 'utf8'));
  if (!disc.url || !disc.authToken) throw new Error('hub discovery record incomplete');
  const ws = new HUB_WS(disc.url, [`cline-hub-auth.${disc.authToken}`]);
  const clientId = `wrapper-${(config.PROJECT_ARG || 'MANAGER').toLowerCase()}-${process.pid}`;
  const waiters = new Map();
  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch (_) { return; }
    if (m.kind === 'reply' && m.envelope && waiters.has(m.envelope.requestId)) {
      const w = waiters.get(m.envelope.requestId);
      waiters.delete(m.envelope.requestId);
      clearTimeout(w.timer);
      w.resolve(m.envelope);
    }
  });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('hub connect timeout')), 10000);
      ws.once('open', () => { clearTimeout(t); resolve(); });
      ws.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    const call = (command, payload, timeoutMs) => new Promise((resolve, reject) => {
      const requestId = `wrap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        waiters.delete(requestId);
        reject(new Error(`${command}: hub reply timeout`));
      }, timeoutMs);
      waiters.set(requestId, { resolve, timer });
      ws.send(JSON.stringify({
        kind: 'command',
        envelope: { version: 'v1', clientId, command, payload, requestId },
      }));
    });
    await call('client.register', {
      clientId,
      clientType: 'core',
      displayName: 'telegram-connector-wrapper',
      transport: 'native',
      actorKind: 'client',
    }, 15000);
    return await fn(call);
  } finally {
    try { ws.close(); } catch (_) { }
  }
}

// Runs the auto-resume for a chat: creates a hosted session in the agent's
// workspace with the freshly rotated key/model, drives the task list, and
// reports the outcome to the user.
async function resumeAfterRotation(chatId) {
  if (state.shuttingDown) return;
  // A rotation may coincide with a wrapper restart, in which case the
  // in-memory lastUserMessage is gone — restore the persisted UNANSWERED
  // message (and its chat id) from disk before deciding anything. After this
  // rotation the agent retries exactly that message.
  if (!state.lastUserMessage) {
    const rec = lastmessage.load();
    if (rec) {
      state.lastUserMessage = rec.text;
      if (rec.chatId) state.lastSeenChatId = state.lastSeenChatId || rec.chatId;
      const ageMin = Math.max(0, Math.round((Date.now() - (rec.updatedAt || Date.now())) / 60000));
      log(`[Resume] Restored unanswered user message from disk (chat ${rec.chatId}, age ${ageMin} min).`);
    }
  }
  chatId = chatId || state.lastSeenChatId || config.ALLOWED_USER_ID || null;
  if (!chatId) {
    log('[Resume] No chat id available; cannot auto-resume.');
    return;
  }
  try {
    const before = tasks.getTaskProgress();
    const listPending = before && before.total > 0 && before.done < before.total;

    // A rotation only fires mid-turn (the connector hit a limit while handling
    // the user's request), so state.lastUserMessage is the request that never
    // got answered. Resume whenever there is EITHER pending task-list work OR
    // an unanswered user message — even with no task list at all (e.g. a plain
    // status question). Only skip when there is truly nothing to continue.
    if (!listPending && !state.lastUserMessage) {
      if (before && before.total > 0 && before.done >= before.total) {
        log('[Resume] Task list already complete and no pending user message; informing user.');
        await chat.sendTelegramMessage(chatId, `✅ Nothing pending after the restart — task list complete: ${before.done}/${before.total} tasks done.`);
      } else {
        log('[Resume] No task list and no pending user message; skipping auto-resume.');
      }
      return;
    }
    if (listPending) {
      log(`[Resume] Creating hub session in ${config.TASKS_DIR} (key #${state.curKeyIndex}, model ${config.MODELS[state.curModelIndex]}).`);
    } else {
      log(`[Resume] No task list pending; continuing interrupted conversation (key #${state.curKeyIndex}, model ${config.MODELS[state.curModelIndex]}).`);
    }
    // Task-list resumes get the list prompt (plus the user's last message as
    // context when present); plain-conversation resumes get the last message
    // verbatim so the agent answers exactly what was asked.
    const prompt = listPending
      ? resumePrompt(before.file) + (state.lastUserMessage ? `\n\nNote: the user's most recent message (interrupted) was: "${state.lastUserMessage}" — address it too, after the pending tasks.` : '')
      : genericResumePrompt(state.lastUserMessage);
    const result = await withHub(async (call) => {
      const created = await call('session.create', {
        workspaceRoot: config.TASKS_DIR,
        cwd: config.TASKS_DIR,
        sessionConfig: {
          providerId: 'cline',
          modelId: config.MODELS[state.curModelIndex],
          apiKey: config.API_KEYS[state.curKeyIndex],
          cwd: config.TASKS_DIR,
          workspaceRoot: config.TASKS_DIR,
          mode: 'act',
          enableTools: true,
          enableSpawnAgent: true,
          enableAgentTeams: true,
          timeoutSeconds: config.RESUME_RUN_TIMEOUT_S,
        },
        metadata: { autoApproveTools: true },
      }, 30000);
      const sessionId = created.payload?.session?.sessionId;
      if (!sessionId) throw new Error('session.create returned no sessionId');
      log(`[Resume] Session ${sessionId} created; injecting resume prompt.`);
      return call('session.send_input', {
        sessionId,
        prompt,
        mode: 'act',
        timeoutSeconds: config.RESUME_RUN_TIMEOUT_S,
      }, config.RESUME_RUN_TIMEOUT_MS);
    });
    const text = (result.payload?.result?.text || '').trim();
    const finishReason = result.payload?.result?.finishReason;
    if (finishReason === 'error') throw new Error(`resumed run failed: ${text.slice(0, 200) || 'unknown error'}`);
    const after = tasks.getTaskProgress();
    const finished = after && after.total > 0 && after.done >= after.total;
    const status = finished
      ? `✅ Task list complete: ${after.done}/${after.total} tasks done.`
      : (after && listPending ? `📋 ${after.done}/${after.total} tasks completed so far.` : '');
    log(`[Resume] Completed (finishReason=${finishReason}).`);
    // The interrupted request has now been answered — clear it so a future
    // rotation doesn't retry it again.
    state.lastUserMessage = null;
    lastmessage.clear();
    await chat.sendTelegramMessage(chatId, `▶️ Auto-resume finished after the key rotation.${status}\n\n${text.slice(0, 3500) || '(no output text)'}`);
  } catch (err) {
    log(`[Resume] Failed: ${err.message}`);
    // AUTO-CHAIN: if the resumed run hit a definitive provider failure (rate limit,
    // invalid/expired key, unknown model, no endpoints), rotate to the next combo and
    // retry automatically — no user message required. This loops until a working
    // key/model answers the request. Without this, any provider error in the resumed
    // hub-session would just drop the user's request after one attempt.
    if (config.PROVIDER_ERROR_RE.test(err.message)) {
      // Lazy-require supervisor to avoid the circular dependency (supervisor → resume).
      const { scheduleRestart, queueResume } = require('./supervisor');
      // Rate limits honor the provider's quoted cooldown (or 15m default).
      // Bad key / unknown model / no endpoints get a longer block (1h) — that
      // combo is unlikely to become valid soon, so don't waste requests on it.
      const isRateLimit = config.LIMIT_RE.test(err.message);
      const cooldownMs = isRateLimit
        ? (rotation.parseCooldownMs(err.message) || rotation.COOLDOWN_DEFAULT_MS)
        : (60 * 60 * 1000);

      // A model-scoped limit ("daily free limit on model X") affects ALL keys on
      // that model — block every combo on the model so rotation skips the whole
      // model at once instead of trying each key individually.
      const isModelScoped = isRateLimit && /daily free limit|model .* (limit|exhausted|quota)/i.test(err.message);
      if (isModelScoped) {
        for (let k = 0; k < config.API_KEYS.length; k++) {
          rotation.blockCombo(k, state.curModelIndex, cooldownMs, 'limit signal (resumed run, model-scoped)', err.message.slice(0, 300));
        }
        log(`[Resume] Resumed run hit a model-scoped limit — blocked ALL ${config.API_KEYS.length} keys on model #${state.curModelIndex} (${config.MODELS[state.curModelIndex]}) until ${new Date(Date.now() + cooldownMs).toISOString()}.`);
      } else {
        const unblockAt = rotation.blockCombo(state.curKeyIndex, state.curModelIndex, cooldownMs, isRateLimit ? 'limit signal (resumed run)' : 'invalid key/model (resumed run)', err.message.slice(0, 300));
        log(`[Resume] Resumed run hit a provider error — blocked key #${state.curKeyIndex} + model #${state.curModelIndex} until ${new Date(unblockAt).toISOString()}.`);
      }

      state.modelLimitHit.add(state.curModelIndex);
      const next = rotation.pickNextCombo();
      const allCooling = next.waitMs > 0;
      const progress = tasks.getTaskProgress();
      if (!allCooling) {
        log(`[Resume] Rotating to key #${next.key} / model ${config.MODELS[next.model]}.`);
      } else {
        log(`[Resume] All combos cooling; parking ${Math.round(next.waitMs / 60000)}m.`);
        // Tell the user — unlike a rotation, nothing else will write to the chat
        // for a long time and every message during the park is only answered by
        // the park poller's "queued" note.
        if (!state.shuttingDown) {
          chat.notifyUser(
            `⛔ All API keys/models hit their daily limits — cooling down until ~${new Date(Date.now() + next.waitMs).toISOString().slice(11, 16)} UTC. Messages sent meanwhile are queued and I'll answer automatically once quota frees up.`
          );
        }
      }
      // Rotate silently — the connector already sent its own error to the user;
      // a wrapper notice would only be redundant noise (the all-cooldown case
      // notifies above, since no connector will be around for a long time).
      state.restartFromRotation = true;
      queueResume();
      if (allCooling) {
        // Lazy-require supervisor to avoid the circular dependency.
        const { parkOnCooldown } = require('./supervisor');
        parkOnCooldown(next.key, next.model, next.waitMs);
      } else {
        const { scheduleRestart } = require('./supervisor');
        scheduleRestart(next.key, next.model, config.RESTART_DELAY_MS);
      }
      return;
    }
    if (!state.shuttingDown) {
      state.resumeAttempts = (state.resumeAttempts || 0) + 1;
      if (state.resumeAttempts >= RESUME_MAX_FAILURES) {
        // Give up on this message: it keeps failing for non-provider reasons
        // and would otherwise be re-queued on every rotation. Drop it so the
        // next USER message starts a clean slate.
        lastmessage.clear();
        state.lastUserMessage = null;
        log(`[Resume] Auto-resume failed ${state.resumeAttempts}×; dropping the pending message.`);
        await chat.sendTelegramMessage(chatId, `⚠️ Couldn't auto-resume after ${RESUME_MAX_FAILURES} attempts (${String(err.message).slice(0, 140)}). Send a new message and I'll pick it up.`);
      } else {
        await chat.sendTelegramMessage(chatId, `⚠️ Couldn't auto-resume after the rotation (${String(err.message).slice(0, 140)}). I'll retry the pending work on the next rotation.`);
      }
    }
  }
}

module.exports = { resumeAfterRotation };