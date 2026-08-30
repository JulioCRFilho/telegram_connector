# telegram_connector — File Documentation

A Node.js wrapper that keeps one or more `cline connect telegram` bot connectors
alive through a **key × model rotation grid**. On a rate limit, fast crash, or
failed pre-flight probe, the wrapper rotates to the next available (key, model)
combo — probing every combo against the real API before starting it, so the
connector only ever runs with a tested, available key+model.

Each running instance is identified by a **NAME** passed as argv[2]
(`node main.js EVOL`), which selects per-instance env vars
(`TELEGRAM_BOT_TOKEN_EVOL`, …), an RPC hub port, and per-instance state files.

---

## Entry point

### `main.js`
The only runnable file. Two modes:

- **Run directly** (`node main.js <NAME>`): boots the wrapper lifecycle —
  - **Persists its full `TELEGRAM_*` environment** to `agents.env-<NAME>.json`
    (mode 0600) BEFORE anything can exit on a validation error — `restart-agent.sh`
    and the auto-heal watcher rebuild an exact relaunch from it, even from a dead
    wrapper, without the fragile `ps eww` parsing.
  - SIGINT/SIGTERM handlers: mark shutdown, remove the pid entry, stop the
    connector child (waiting for it to actually die) before exiting.
  - **Duplicate-instance guard**: refuses to start if another live wrapper for
    the same NAME exists (they would fight over Telegram `getUpdates`).
  - Purges stale connectors, **loads the persisted cooldown grid**, starts a
    1 s log-polling loop and the **grid watcher** (every 30 s: rotates the live
    connector proactively when its own combo becomes blocked — e.g. by a peer
    instance's shared-grid block — BEFORE a user message can hit the raw 429),
    then consults the grid via `rotation.recommendCombo()`
    to pick the boot combo. If every combo is cooling down, it parks
    (`supervisor.parkOnCooldown`) until the earliest one frees; otherwise it
    starts through `supervisor.startVerified()`.
- **Required as a module** (the tests): skips the lifecycle and exports the
  probe/rotation internals (`probeCombo`, `parseCooldownMs`, `startVerified`,
  `blockedCombos`, `gridStatus`, …) plus `_test` seams for resetting rotation
  state between simulated scenarios.

---

## `lib/` — core modules

### `lib/config.js`
Central configuration. **All values come from environment variables** (nothing
embedded). Validates on load and exits if the bot token, API keys, or model list
are missing — the error names the REAL variable (`TELEGRAM_BOT_TOKEN_<NAME>` for
instance tokens, not the generic one) and is also written to `connector.log` so
a bad boot is traceable even when stdout is not captured. Provides:

- `API_KEYS` / `MODELS` — the rotation grid (comma/semicolon/space separated).
- `TELEGRAM_BOT_TOKEN_<NAME>` — per-instance bot token; `BOT_USER_ID` is the
  numeric prefix used to filter shared log lines.
- Regexes: `LIMIT_RE` (rate-limit/quota/gateway signals), `PROVIDER_ERROR_RE`
  (superset adding invalid key / bad model), `TIMEOUT_RE` (bridge turn
  timeouts — "The operation timed out.", ETIMEDOUT), `IS_TELEGRAM_RE`,
  `BOT_USER_ID_RE`, `PID_RE`.
- `TIMEOUT_COOLDOWN_MS` (3 min, `TELEGRAM_TIMEOUT_COOLDOWN_MS`) /
  `TIMEOUT_ESCALATED_MS` (15 min after `TIMEOUT_ESCALATE_AFTER_STRIKES` = 3
  consecutive strikes) — timeout policy constants.
- Paths: cline log dirs, `connector.log`, `agents.pids.json`,
  `agents.state-<NAME>.json`, `agents.cooldowns.json`.
- `RPC_HUB_PORTS` — one RPC hub port per instance (MANAGER 25463, FSCENE 25464,
  EVOL 25465) so per-thread hub locks never collide across bots.
- Task-list sources (`TELEGRAM_TASKS_FILE(_NAME)` / `TELEGRAM_TASKS_DIR(_NAME)`,
  with per-project defaults for FSCENE and EVOL) and auto-resume timings
  (5 s settle delay, 15 min resumed-run cap).
- Hub discovery record paths (private `<NAME>.json` per instance; MANAGER uses
  the default `production.json`).

### `lib/state.js`
The single mutable state object shared by all modules (avoids circular
requires): live child process + pid, retired-pid memo (`knownPids`, map of
pid → first-seen time, pruned in `lib/procs.js`), current
key/model indices, `blockedCombos` Map (`"<keyIdx>:<modelIdx>"` → cooldown
record), `modelLimitHit` Set, start-window guards (`startPending`,
`pendingRotation`, `restarting`, `restartFromRotation`, `pendingResume`),
`shuttingDown`, last seen chat id, last unanswered user message,
`resumeAttempts` (auto-resume retry budget for non-provider failures), and
dedupe/throttle timestamps for limit signals and probe notices.

### `lib/log.js`
One function: timestamped line appended to `connector.log` **and** printed to
stdout, so diagnostics are never lost when stdout is redirected. Connector.log
is rotated once past 5 MB (a single `.1` backup) so it can't grow forever.

### `lib/supervisor.js`
The rotator core — builds the `cline connect telegram` argv (bot token, API
key, explicit `--model`, RPC port, allowed user, system prompt from
`system_prompt.md`), spawns and monitors the connector:

- `buildArgs()` — argv construction; `--model` is always passed explicitly.
- Launched-command echo **redacts secrets**: the bot token and every API key
  are masked (`12…456`) in `connector.log` / `wrapper-*.out` — those logs live
  indefinitely and previously exposed the full credential set on every start.
- `stopCurrent(onStopped)` — kills the connector **and its whole descendant
  tree** (the cline shim spawns the real binary as a child): SIGTERM to every
  pid children-first, SIGKILL escalation after 3 s, absolute safety timeout.
  Calls back only when the child is actually gone.
- `scheduleRestart(index, modelIndex, delay)` — stops the old
  connector, purges stale daemons, **reconciles the cooldown grid from disk**
  (`cooldowns.load()`) and re-validates the target right before starting
  (`resolveStartCombo`). If a restart/probe is already in flight it only queues
  `pendingRotation`; if the target is still blocked it hands off to the park
  monitor instead of re-arming a fragile long setTimeout. (The old `afterCooldown`
  parameter was removed — every cooldown path now goes through `parkOnCooldown`.)
- `parkOnCooldown(key, model, waitMs)` / `startParkMonitor()` — when EVERY
  key×model combo is cooling down: stop the connector, purge stale daemons, and
  arm the **park monitor** — a wake timer at the grid's REAL earliest unblock
  (re-validated from disk when it fires) plus a 30 s getUpdates poller that
  answers user messages with a "queued" notice and persists them for the
  auto-resume. This replaced the old recursive `scheduleRestart(…, waitMs,
  true)` parking, which a stale/out-of-grid cooldown record could collapse to a
  30 s re-park busy loop with no connector running (the "agents frozen" bug).
- `refreshParkRound()` — the **park refresh round**: while parked, the grid is
  re-consulted every `PARK_REFRESH_INTERVAL_MS` (default 10 m, env
  `TELEGRAM_PARK_REFRESH_INTERVAL_MS`) instead of blindly sleeping until the
  quoted unblock. Each round reloads the persisted grid and recomputes the
  rotation scan: a combo that freed early (record healed, peer cleared it,
  over-quoted `try again in`) exits the park **immediately** and starts on it;
  an earliest-unblock that moved earlier by peers re-arms the wake timer; an
  unchanged grid keeps the current park untouched (no re-arm churn). This is
  the active safety net behind all-18-cooling — the agents never trust a stale
  block for hours on end.
- `startVerified(index, modelIndex)` — runs the **pre-flight probe**
  (`probe.probeCombo`) before every start; `ok:true`/inconclusive → start,
  `ok:false` → `onProbeReject`. Sends the "back online" notice when the start
  follows a rotation/probe rejection.
- `onProbeReject()` — blocks the rejected combo (all keys of the model when the
  failure is model-scoped), then loops a full grid scan
  (`pickNextComboFromStart`) probing combo after combo; when all are dead it
  notifies the user and parks until the earliest frees. Notices are throttled.
- `onLimitSignal(line)` — runtime path when a rate-limit line appears in cline's
  logs (deduped within 5 s): parses the quoted cooldown, blocks the combo (or
  the whole model for model-scoped limits), marks `modelLimitHit`, picks the
  next combo, queues the auto-resume and schedules the rotation restart
  (parking when everything is cooling).
- `onTimeoutSignal(line)` — runtime path for turn-level timeouts (bridge's
  "The operation timed out.", which is NOT a quota error). Blocks ONLY the
  current combo with a SHORT cooldown (3 min; escalated to 15 min after 3
  consecutive strikes — strikes reset when a turn completes or 30 min pass),
  then rotates + auto-resumes exactly like `onLimitSignal`. Exists because the
  bridge's timeout text matches no `LIMIT_RE` pattern — before this, the
  wrapper retried a timing-out combo forever with no rotation.
- `clearTimeoutStrikes()` — resets the timeout strike counter after a healthy
  turn (called from `logs.js` on "Telegram reply completed").
- `gridWatchTick()` / `startGridWatcher()` — every 30 s, rotates the live
  connector as soon as its CURRENT combo appears blocked in the (shared)
  cooldown grid, before any user message triggers the bridge's raw 429 error;
  sends one concise friendly notice. No-op while parked, restarting, probing,
  or within the limit dedupe window.
- `onLimitSignal` also sends ONE concise friendly line
  ("🔑 <model> hit its daily free limit — rotating… message retries
  automatically") so the bridge's raw JSON error reads as handled. NOTE: the
  raw error itself is sent by the cline bridge directly to Telegram — the
  wrapper cannot suppress or edit it, only react.
- `queueResume()` — arms the auto-resume consumed by the next start.

### `lib/probe.js`
Pre-flight availability probe — tests a (key, model) combo BEFORE spawning the
real connector. Verdicts: `{ok:true}` (start), `{ok:false, cooldownMs, reason}`
(definitive provider failure → block & rotate), `{ok:null}` (inconclusive →
start anyway; runtime detection is the net).

- `classifyProbeFailure(status, body, retryAfterSec)` — maps HTTP status/error
  bodies to verdicts: 429/quota → quoted cooldown; 402 credits → quota-like;
  401 → dead key; 404 "model not found" → 1 h block; 502/503 & gateway retry
  exhaustion → 2 min transient block; anything else → **not** blocked
  (probe quirk ≠ unavailability).
- `probeHttp()` — optional HTTP stage (one `max_tokens=1` chat completion at
  `<base>/api/v1/chat/completions`). **Strictly double opt-in**: only runs when
  BOTH `TELEGRAM_PROBE_HTTP=1` and `TELEGRAM_API_BASE` are set; production
  (cline-default providers) never sets them.
- `probeCombo()` — default path: skips grid-blocked combos, then **spawn-based
  probe**: launches the real `cline connect telegram` with the candidate
  key/model, waits for "Telegram connector ready" + an 8 s settle window (so a
  429 can surface), rejects on provider-error patterns in stdout/stderr,
  classifies on exit, times out as inconclusive. Always kills the probe child's
  full process tree on resolution.
- `PROBE_ENABLED` is on by default (`TELEGRAM_PROBE_ENABLED=0` disables).

### `lib/rotation.js`
Cooldown-grid logic and combo selection. Grid key `"<keyIdx>:<modelIdx>"` →
`{unblockAt, blockedAt, cooldownMs, reason, detail}` in `state.blockedCombos`,
persisted via `lib/cooldowns.js`. The file holds ONLY `"k:m"` records —
a model-scoped limit is expressed by blocking all of that model's key records
(6 keys × 3 models = 18 rounds); there is no `_models_` metadata key (legacy
occurrences are healed away on load, and `save()` never writes one).
`state.modelLimitHit` is in-memory only. Consumers must use the helpers
`gridKeyValid(key)`, `totalCombos()` (= key count × model count, derived from
live config) and `isComboFree(key, model)` instead of parsing raw JSON.
**Model capacity priority** (`modelRank`/`modelsByPriority`): models are tried
best-capacity-first per `config.MODEL_PRIORITY` (default
`z-ai/glm-5.3-flash` → `deepseek/deepseek-v4-flash` → any), substring-matched
so id variants still rank. Both runtime rotation (`scanFromCurrent`) and boot
selection (`pickNextComboFromStart`) follow this order — when a priority
model's quota recovers, rotation climbs back up the ladder.

- `parseCooldownMs(line)` — extracts "Try again in 7h 3m" / "…after 5h" /
  "…in 30m" → ms (0 when absent).
- `blockCombo()` — blocks a combo until `probeBlockAt` (never shortens an
  existing block), stores a **sanitized** detail (raw JSON log lines carry
  hostname/pid/session ids — never persisted), schedules a save.
- `scanFromCurrent()` / `pickNextCombo()` — next non-blocked slot starting one
  after the current combo; prefers a *different model* when the current one is
  limit-hit. When everything is blocked, parks on the earliest-free combo and
  returns `waitMs` (quoted time + 2 min grace, min 30 s). `earliestUnblock()`
  only counts IN-GRID records — a stale record from a past config would
  otherwise collapse the park wait to the 30 s floor (the "re-parking for 1m"
  busy loop after a model-list change).
- `pickNextComboFromStart()` / `recommendCombo()` — full slot-0 scan used by
  probe rejection sweeps and boot.
- `resolveStartCombo(key, model)` — start-time re-validation: if the target
  landed on cooldown meanwhile, falls back to `pickNextCombo`.
- `gridStatus()` — human-readable full grid (per-pair remaining cooldown +
  reason; never renders raw detail) for the `/keys` chat command.
- `gridSummary()` — compact one-liner ("🗂 3/4 combos free — on cooldown: …")
  for acks/pings.

### `lib/cooldowns.js`
Persistence of the cooldown grid to `agents.cooldowns.json`. Daily-limit blocks
last up to ~24 h, so an in-memory grid would forget them on every restart.

- `gridKeyValid(recordKey)` — bounds-check a persisted `"k:m"` record against
  the CURRENT key/model lists; stale out-of-grid records (from a config change)
  are dropped on load AND never written on save.
- `load()` — rebuilds `state.blockedCombos` / `state.modelLimitHit` at boot;
  drops expired records, anything older than a 26 h safety cap, and out-of-grid
  records — healing the file when stale ones are found.
- `save()` / `scheduleSave()` — write-through after every change, debounced
  250 ms so dense block/rotate sweeps do one write; expired and out-of-grid
  entries are dropped on write so the file never goes stale.


### `lib/procs.js`
Process-tree attribution, stale-connector hygiene, and the pid registry:

- `collectDescendants(rootPid)` — recursive `pgrep -P` walk (10 s cache) —
  log lines carry the *grandchild's* pid, not the shim's we spawned.
- `ourProcessPids()` / `isOurBot(line)` — decide whether a shared-log line
  belongs to this bot: `botUserId` field first, then pid ∈ our process tree,
  then "is this a stale connector running our bot token". Prevents
  cross-reaction between instances sharing `~/.cline/data/logs/cline.log`.
  The retired-pid memo is **bounded** (pruned past 512 entries or 1 h old) so
  it can't grow across hundreds of restarts.
- `purgeStale()` — SIGKILLs only **orphaned** connectors (ppid=1) matching this
  exact bot token; live-owner matches are left alone (this guard is what ended
  the two-wrappers-killing-each-other restart loop).
- `killIfStaleConnector(line)` — from a limit line, kills an orphan connector
  still polling our token so rotation proceeds cleanly.
- Pid registry (`agents.pids.json`): `writePidEntry` / `removePidEntry` /
  `liveWrapperPid` (liveness + `ps` command check against pid recycling), with
  cross-process mutual exclusion (`withPidLock`: `O_EXCL` lock file, stale
  stolen after 1 s, 5 s max wait) and **atomic** writes (temp file + rename) —
  this fixed the concurrent-boot lost-update race between EVOL and FSCENE.

### `lib/logs.js`
Log tailing → events. `tailLog()` keeps a per-file byte offset (resetting on
truncation/rotation) and emits new complete lines; `pollLogs()` runs every
second over the shared `cline.log` and every per-bot log file. Filtered by
`IS_TELEGRAM_RE` + `procs.isOurBot()`, then: limit lines → `onTurnDone(false)`
+ `killIfStaleConnector` + `supervisor.onLimitSignal`; timeout lines →
`onTurnDone(false)` + `supervisor.onTimeoutSignal`; "Telegram reply completed"
→ `supervisor.clearTimeoutStrikes()`; everything else →
`chat.handleTurnEvent`.

### `lib/interrupted.js` — paused-task queue
Persisted FIFO (`agents.interrupted-<INSTANCE>.json`, gitignored) of tasks
paused by a mid-task user interruption. `push` dedupes identical text, caps at
5 entries, entries expire after 24h; `pop` returns the oldest. Survives
wrapper restarts.

### `lib/chat.js`

All Telegram communication. The user-facing language is deliberately **short, human, and outcome-focused** — internal machinery (keys, models, cooldown grids, ports) never reaches the chat; it lives in `/status` and the logs.

What the user sees, per event:

| Event | Message |
|---|---|
| Task accepted | `Got it — working on it now. I'll send the result here as soon as it's done.` (one line; no key/model/grid) |
| Progress tick | `Quick update: 3 of 8 tasks done.` — sent ONLY when the task-list count advanced since the last message (silent otherwise, capped) |
| Provider rate-limited | `⚠️ The AI provider is rate-limited right now (frees up ~HH:MM UTC). Your request is queued — I'll start automatically as soon as capacity is back.` |
| Probe rejects a combo | `⚠️ <reason> was rejected — trying another one. Your work resumes automatically…` (throttled so a sweep over dead combos doesn't spam) |
| Everything cooling | `⚠️ All AI providers are unavailable right now (next free ~HH:MM UTC). I'll keep checking automatically…` |
| Back online | `✅ Back online — 4/8 tasks done. Continuing with: • …` |
| Mid-task interrupt | `Heads up — I've paused what I was on to handle your new message first. The earlier task is saved and I'll pick it back up right after.` |
| Paused task resumes | `Done with your latest request — picking the earlier task back up now: "<original text>"` |
| Message during park | `⏳ … queued until ~HH:MM UTC` (persisted, retried automatically) |
| Connection drop | `⚠️ The connection dropped — restarting now. Your work resumes automatically.` |

Chat commands: `/keys` (cooldown grid), `/status` (instance, current combo, uptime, park window). Heartbeats ("still working") are log-only — the chat only hears about progress that actually happened.

Telegram Bot API messaging + turn UX:

- Another message from the same chat while a turn is active **interrupts the
  running task**: the in-flight request is paused into `lib/interrupted.js`
  (⏸ notice), the connector restarts so the NEW message is answered first, and
  when that turn completes the paused task is re-queued automatically
  (▶️ notice). Re-sending identical text just resets the ping clock. This
  replaced the old behavior where follow-ups were ignored and then silently
  cleared by `onTurnDone`.
- `sendTelegramMessage(chatId, text)` / `notifyUser(text)` — wrapper-initiated
  notices (best-effort, never throw).
- `ackQueuedDuringPark(earliestUnblockAt)` — **park-time poller**: while every
  key×model combo is on cooldown no connector runs, so the wrapper polls
  Telegram `getUpdates` itself, answers each new user message with a "⏳ queued
  until ~HH:MM UTC" notice and persists it (`lastmessage.save`) so the
  auto-resume retries it the moment quota frees. In-flight guard (one poll at a
  time — no concurrent getUpdates/409s) + 15 s fetch timeout.
- **Turn machinery**: a user message that gets no reply within 3 min is
  acknowledged ("🛠️ On it — …") with the live key/model and `gridSummary()`;
  while it runs, progress pings every 5 min (cap 12 ≈ 1 h) report real task-list
  status including the item the agent is currently on; fast replies cancel the
  pending ack; follow-up messages reset the clock; slash commands are never
  acked.
- `/keys`, `/keymap`, `/cooldowns`, `/combo` — wrapper-level command: replies
  with the full persisted cooldown grid (`rotation.gridStatus()`).
- `/status` — wrapper-level command: replies with the instance's live snapshot
  (name, bot handle, current key/model, wrapper/connector pids, uptime, grid).
- `handleTurnEvent(line)` — maps connector log messages to turn events
  (received / completed / failed / RPC session lifecycle); captures
  `textPreview` as `lastUserMessage` and persists it via `lastmessage`.
  Log lines are **parsed as whole JSON objects** (`parseLogLine`), so preview
  text with quotes/escapes decodes correctly for the auto-resume.
- `onTurnDone(ok)` — on success clears the unanswered message (a failed turn
  keeps it for the auto-resume to retry).

### `lib/tasks.js`
Task-list progress for acks/pings. Counts `- [ ]`/`- [x]` markdown checkboxes;
explicit `TELEGRAM_TASKS_FILE` wins, else scans the workspace (depth ≤ 4,
skipping dotfiles/node_modules/build/dist) for the most recently modified file
with checkboxes. A fully-checked list only counts as active while fresh
(mtime ≤ 10 min) so finished past lists don't masquerade as current work.
`taskProgressText()` formats "📋 4/8 tasks completed (50%)" or "…done —
finalizing…".


### `lib/resume.js`
**Auto-resume after rotation.** A rotation restarts the connector, but the
interrupted task used to die; now the wrapper talks to its instance's RPC hub
directly (WebSocket protocol reverse-engineered from the CLI: auth via
`Sec-WebSocket-Protocol: cline-hub-auth.<token>`, `{kind:"command",envelope:…}`
requests and replies). `ws` is loaded from the cline install by absolute path.

- `withHub(fn)` — connects using the per-instance hub discovery record,
  registers, exposes `call(command, payload, timeoutMs)`.
- `resumeAfterRotation(chatId)` — restores the persisted unanswered message if
  in-memory state is gone; skips when there is truly nothing pending; else
  creates a hosted session (`session.create`) in the agent's workspace with the
  **freshly rotated** key/model and injects a task-list continuation prompt (or
  the user's last message verbatim when no task list exists) via
  `session.send_input`, awaits the result, and reports it to the user.
- **Auto-chain**: if the resumed run itself fails with a provider error, the
  combo is blocked (rate-limit cooldown, or 1 h for bad key/model; model-scoped
  limits block every key on the model) and the resume is re-queued with the
  next combo — looping until a working key/model answers.
- **Non-provider failures are capped** (`RESUME_MAX_FAILURES = 2`): a resumed
  run that fails for hub/workspace/agent reasons isn't going to succeed by
  retrying on every rotation — after 2 tries the persisted message is dropped
  and the user gets one final "send a new message" notice instead of endless
  "couldn't auto-resume" spam. The budget resets on any fresh user message or
  a successful turn.

### `lib/lastmessage.js`
Persists the last **unanswered** user message per instance
(`agents.state-<NAME>.json`) so auto-resume can retry it even across a wrapper
restart. Cleared the moment the message is answered; entries older than 24 h
are discarded.

---

## Shell scripts

### `restart-agent.sh`
Restart one instance in two modes:
- `restart-agent.sh <NAME>` — graceful: verifies the live wrapper pid in
  `agents.pids.json`, SIGTERMs it (waits up to 30 s), then relaunches.
- `restart-agent.sh <NAME> --force` — forced: for a DEAD wrapper (used by the
  auto-heal watcher); skips the "wrapper must be alive" checks.

The relaunch environment is restored from **`agents.env-<NAME>.json`** — the
snapshot `main.js` writes at every boot (mode 0600) with the full `TELEGRAM_*`
env. This replaced `ps eww` parsing, which mangles env values containing
spaces (e.g. `TELEGRAM_API_KEYS="sk-a, sk-b"`) and cannot read a dead process.
A `ps eww` fallback is kept only for wrappers that predate the env-file code.

### `watch-agents.js`
**Auto-heal watcher** (the implementation of AGENTS.md's "keep them online"):
a liveness pass every 60 s reads `agents.pids.json` and, for each instance
whose wrapper pid is dead or no longer runs `main.js <NAME>`, relaunches it via
`restart-agent.sh <NAME> --force`. A **health pass every 10 min** catches the
degraded-but-alive cases liveness cannot see: wrapper alive but its connector
child is gone (`pgrep -P`), or a turn stalled in flight — the wrapper log's
"Still working after N min" counter (or the wall-clock age of that line, when
the wrapper hung and stopped logging) crosses `STALLED_TURN_MIN` (30 min) with
no "Task completed|failed" after it. Stalled/degraded instances get a GRACEFUL
restart (`restart-agent.sh <NAME>`, SIGTERM first). Guarded by a cross-process
`agents.watch.lock` (O_EXCL + stale-steal). Modes: `node watch-agents.js`
(daemon loop) or `node watch-agents.js once` (cron-friendly liveness only).

**Parked wrappers are never restarted.** A wrapper parked on a fully-cooled
grid has no connector child BY DESIGN (it polls Telegram itself), which the
health check used to misread as "degraded" — restarting parked wrappers every
10 min and freezing the agents in a park↔restart loop. Wrappers now advertise
`parkedUntil` in `agents.pids.json` (`procs.markParked`, set by
`startParkMonitor`, cleared whenever the park machinery goes down) and the
watcher skips such instances (`isParkedEntry`, with a 90 s grace window so the
wake→connector-spawn race can't be killed mid-flight).
Skipped instances with no `agents.env-<NAME>.json` (never booted here). Logs
to `restart-schedule.log`. Covered by `test.health-check.js`.

### `restart-evol-when-idle.sh`
Deferred restart for EVOL: polls every 30 s until `agents.state-EVOL.json`
disappears (the file exists exactly while an unanswered message is pending),
holds a 60 s grace period (re-arming if a new message lands), hard-capped at
6 h — then runs `restart-agent.sh EVOL`. Never restarts mid-task.

---

## Other root files

### `system_prompt.md`
The agent instructions injected into every connector via `--system`
(read once at boot by `lib/supervisor.js`; shared by all instances).

### `AGENTS.md`
Working rules for the managing agent (keep bots EVOL/FSCENE online, rotate
keys/models, confirm resets after changes, track PIDs, short answers/resumes).


---

## Tests

### `test.probe.js`
Unit tests for `parseCooldownMs` and `classifyProbeFailure` (via the `main.js`
module exports), plus one **live** probe against OpenRouter with an invalid key
— a definitive rejection (or an inconclusive verdict offline) both pass.

### `test.rotation.sim.js`
Simulation of the full rotate→probe→reject→rotate loop against the real code
with a mocked `fetch` provider (no real connector spawned). Scenarios: every
combo rejected → all blocked + parked, no connector ever started; key #0
rejected / key #1 OK → only the rejected combo blocked and only the passing one
started; grid consultation (`comboUnblockAt`, `recommendCombo`, `gridStatus`);
and the persisted-grid round-trip across a simulated restart.

### `test.pids-race.js` + `test-pids-race-child.js`
Regression test for the `agents.pids.json` lost-update bug: forks 8 children ×
3 rounds all writing their pid entry concurrently (`test-pids-race-child.js`
just calls `procs.writePidEntry()`), then asserts every instance survived —
verifying the `O_EXCL` pid-file lock and atomic rename.

### `test.park-stale-grid.js`
Regression test for the "agents frozen" bug: stale out-of-grid cooldown records
(from a config change) used to collapse the all-cooldown park to a 30 s
re-park loop. Asserts `load()` drops/heals out-of-grid records and that
`pickNextCombo` / `resolveStartCombo` honor the grid's REAL earliest unblock
despite poison records.

### `test.watch-park.js`
Regression test for the park↔restart freeze (watcher health pass restarted
parked wrappers): `procs.markParked` advertises the park window in
`agents.pids.json` and `watch-agents.isParkedEntry` (with its 90 s wake-grace)
correctly treats parked→waking wrappers as healthy, never restart-worthy.

### `test.park-refresh.js`
Regression test for the park refresh round: with every combo cooling, a fresh
round over the persisted grid (a) stays parked when the grid is unchanged,
(b) **exits the park and starts immediately** when a combo frees early, and
(c) re-arms the wake timer when peers move the earliest unblock earlier.

### `package.json`
No dependencies. `npm test` runs all twelve test files; `npm run watch` starts
the auto-heal watcher (`node watch-agents.js`).

Run all with plain `node <file>` (no test framework).

---

## Runtime data files (gitignored)

| File | Purpose |
|---|---|
| `agents.pids.json` | Registry of live wrapper instances (`NAME` → `{wrapperPid, botUserId, hubPort}`), guarded by `agents.pids.json.lock` + atomic temp-file writes. |
| `agents.env-<NAME>.json` | Per-instance `TELEGRAM_*` env snapshot written at boot (mode 0600) — restart-agent.sh / watch-agents.js rebuild exact relaunches from it. |
| `agents.cooldowns.json` | Persisted key×model cooldown grid (shared; overridable via `TELEGRAM_COOLDOWNS_FILE`). |
| `agents.state-<NAME>.json` | Per-instance last unanswered user message (auto-resume). |
| `agents.watch.lock` | Cross-process lock for the auto-heal watcher (O_EXCL + stale-steal). |
| `connector.log` | Wrapper diagnostics (from `lib/log.js`); rotated once past 5 MB. |
| `wrapper-<NAME>.out` | stdout/stderr of each detached wrapper process. |
| `restart-schedule.log` | Log of the watcher / deferred-restart runs. |

