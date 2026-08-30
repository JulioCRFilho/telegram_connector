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
  - SIGINT/SIGTERM handlers: mark shutdown, remove the pid entry, stop the
    connector child (waiting for it to actually die) before exiting.
  - **Duplicate-instance guard**: refuses to start if another live wrapper for
    the same NAME exists (they would fight over Telegram `getUpdates`).
  - Purges stale connectors, **loads the persisted cooldown grid**, starts a
    1 s log-polling loop, then consults the grid via `rotation.recommendCombo()`
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
embedded). Validates on load and `process.exit(1)` if the bot token, API keys,
or model list are missing. Provides:

- `API_KEYS` / `MODELS` — the rotation grid (comma/semicolon/space separated).
- `TELEGRAM_BOT_TOKEN_<NAME>` — per-instance bot token; `BOT_USER_ID` is the
  numeric prefix used to filter shared log lines.
- Regexes: `LIMIT_RE` (rate-limit/quota/gateway signals), `PROVIDER_ERROR_RE`
  (superset adding invalid key / bad model), `IS_TELEGRAM_RE`,
  `BOT_USER_ID_RE`, `PID_RE`.
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
requires): live child process + pid, retired-pid set (`knownPids`), current
key/model indices, `blockedCombos` Map (`"<keyIdx>:<modelIdx>"` → cooldown
record), `modelLimitHit` Set, start-window guards (`startPending`,
`pendingRotation`, `restarting`, `restartFromRotation`, `pendingResume`),
`shuttingDown`, last seen chat id, last unanswered user message, and
dedupe/throttle timestamps for limit signals and probe notices.

### `lib/log.js`
One function: timestamped line appended to `connector.log` **and** printed to
stdout, so diagnostics are never lost when stdout is redirected.

### `lib/supervisor.js`
The rotator core — builds the `cline connect telegram` argv (bot token, API
key, explicit `--model`, RPC port, allowed user, system prompt from
`system_prompt.md`), spawns and monitors the connector:

- `buildArgs()` — argv construction; `--model` is always passed explicitly.
- `stopCurrent(onStopped)` — kills the connector **and its whole descendant
  tree** (the cline shim spawns the real binary as a child): SIGTERM to every
  pid children-first, SIGKILL escalation after 3 s, absolute safety timeout.
  Calls back only when the child is actually gone.
- `scheduleRestart(index, modelIndex, delay, afterCooldown)` — stops the old
  connector, purges stale daemons, **reconciles the cooldown grid from disk**
  (`cooldowns.load()`) and re-validates the target right before starting
  (`resolveStartCombo`). If a restart/probe is already in flight it only queues
  `pendingRotation`; if the target is still blocked it hands off to the park
  monitor instead of re-arming a fragile long setTimeout.
- `parkOnCooldown(key, model, waitMs)` / `startParkMonitor()` — when EVERY
  key×model combo is cooling down: stop the connector, purge stale daemons, and
  arm the **park monitor** — a wake timer at the grid's REAL earliest unblock
  (re-validated from disk when it fires) plus a 30 s getUpdates poller that
  answers user messages with a "queued" notice and persists them for the
  auto-resume. This replaced the old recursive `scheduleRestart(…, waitMs,
  true)` parking, which a stale/out-of-grid cooldown record could collapse to a
  30 s re-park busy loop with no connector running (the "agents frozen" bug).
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
persisted via `lib/cooldowns.js`.

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
+ `killIfStaleConnector` + `supervisor.onLimitSignal`; everything else →
`chat.handleTurnEvent`.

### `lib/chat.js`
Telegram Bot API messaging + turn UX:

- `sendTelegramMessage(chatId, text)` / `notifyUser(text)` — wrapper-initiated
  notices (best-effort, never throw).
- `ackQueuedDuringPark(earliestUnblockAt)` — **park-time poller**: while every
  key×model combo is on cooldown no connector runs, so the wrapper polls
  Telegram `getUpdates` itself, answers each new user message with a "⏳ queued
  until ~HH:MM UTC" notice and persists it (`lastmessage.save`) so the
  auto-resume retries it the moment quota frees.
- **Turn machinery**: a user message that gets no reply within 3 min is
  acknowledged ("🛠️ On it — …") with the live key/model and `gridSummary()`;
  while it runs, progress pings every 5 min (cap 12 ≈ 1 h) report real task-list
  status including the item the agent is currently on; fast replies cancel the
  pending ack; follow-up messages reset the clock; slash commands are never
  acked.
- `/keys`, `/keymap`, `/cooldowns`, `/combo` — wrapper-level command: replies
  with the full persisted cooldown grid (`rotation.gridStatus()`).
- `handleTurnEvent(line)` — maps connector log messages to turn events
  (received / completed / failed / RPC session lifecycle); captures
  `textPreview` as `lastUserMessage` and persists it via `lastmessage`.
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

### `lib/lastmessage.js`
Persists the last **unanswered** user message per instance
(`agents.state-<NAME>.json`) so auto-resume can retry it even across a wrapper
restart. Cleared the moment the message is answered; entries older than 24 h
are discarded.

---

## Shell scripts

### `restart-agent.sh`
Graceful restart of one instance: reads the live wrapper pid from
`agents.pids.json`, verifies it really is that wrapper, **captures its
`TELEGRAM_*` environment before killing it**, SIGTERMs it (waits up to 30 s),
then relaunches `node main.js <NAME>` detached with the identical environment,
appending to `wrapper-<NAME>.out`.

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

Run all with plain `node <file>` (no test framework).

---

## Runtime data files (gitignored)

| File | Purpose |
|---|---|
| `agents.pids.json` | Registry of live wrapper instances (`NAME` → `{wrapperPid, botUserId, hubPort}`), guarded by `agents.pids.json.lock` + atomic temp-file writes. |
| `agents.cooldowns.json` | Persisted key×model cooldown grid (shared; overridable via `TELEGRAM_COOLDOWNS_FILE`). |
| `agents.state-<NAME>.json` | Per-instance last unanswered user message (auto-resume). |
| `connector.log` | Wrapper diagnostics (from `lib/log.js`). |
| `wrapper-<NAME>.out` | stdout/stderr of each detached wrapper process. |
| `restart-schedule.log` | Log of the deferred-restart watcher runs. |

