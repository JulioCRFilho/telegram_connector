// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION — ALL values come from environment variables (not embedded in
// code). Set them in the shell before running main.js:
//
//   export TELEGRAM_BOT_TOKEN="123456789:ABCDEF..."
//   export TELEGRAM_API_KEYS="sk-or-v1-AAAA..., sk-or-v1-BBBB..."   # keys for rotation
//   export TELEGRAM_AVAILABLE_MODELS="model-a,model-b"   # models to rotate (REQUIRED)
//   export TELEGRAM_CWD="/path/to/workspace"    # (optional) default: this directory
//   export TELEGRAM_ALLOWED_USER_ID="123..."    # (optional) restrict to a user
//   export TELEGRAM_RESTART_DELAY_MS="2000"     # (optional) delay before restarting
//   export TELEGRAM_TASKS_FILE="/path/tasks.md" # (optional) explicit task list for progress pings
//   export TELEGRAM_TASKS_DIR="/path/to/ws"     # (optional) dir scanned for task lists (default: cwd)
//   export TELEGRAM_PROBE_ENABLED="1"           # (optional) force the pre-flight key/model test on/off
//   export TELEGRAM_API_BASE="https://openrouter.ai"  # (optional) provider endpoint for the probe
//   export TELEGRAM_PROBE_MAX_TOKENS="1"        # (optional) max_tokens for the probe call
//   export TELEGRAM_PROBE_TIMEOUT_MS="15000"    # (optional) probe timeout
//
// Rotation grid: keys × models. A "daily free limit" 429 blocks only the
// current (key, model) combo; the wrapper restarts on the next free combo.
// --model is ALWAYS passed explicitly — cline's own default is never used.
//
// After rotation picks a new key+model, the wrapper PROBES it against the real
// API (a single max_tokens=1 chat completion) BEFORE launching the connector —
// the rotated key/model is tested to ensure availability, or the wrapper
// rotates again. Only a combo that actually answers gets started.
// ─────────────────────────────────────────────────────────────────────────────
const os = require('os');
const path = require('path');

// Reads the keys for rotation, accepting comma, space, or `;` as separators.
const API_KEYS = (process.env.TELEGRAM_API_KEYS || '')
  .split(/[,;\s]+/)
  .map((k) => k.trim())
  .filter(Boolean);

// Basic config with safe fallbacks.
const PROJECT_ARG = process.argv[2];
const TELEGRAM_BOT_TOKEN = process.env[`TELEGRAM_BOT_TOKEN_${PROJECT_ARG}`];
const ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID || '';
const RESTART_DELAY_MS = parseInt(process.env.TELEGRAM_RESTART_DELAY_MS || '2000', 10);
const AVAILABLE_MODELS = (process.env.TELEGRAM_AVAILABLE_MODELS || '')
  .split(/[,;\s]+/)
  .map((k) => k.trim())
  .filter(Boolean);

// The numeric bot user ID is the first segment of the token (before the ':').
// We use it to filter shared cline.log entries so that multiple duplicated
// instances (each with a different TELEGRAM_BOT_TOKEN) don't cross-react to
// each other's log entries (e.g. Instance A handling Instance B's messages).
const BOT_USER_ID = (TELEGRAM_BOT_TOKEN || '').split(':')[0];

// Model list for rotation. The wrapper ALWAYS controls the model explicitly —
// `--model` is never omitted, so the key×model cooldown grid reflects exactly
// what the connector runs. With K keys and M models there are K×M combos; a
// "daily free limit" hit blocks only one combo and rotation moves on, which
// makes a full cooldown (all combos blocked) unlikely unless every key is
// exhausted on every model.
const MODELS = AVAILABLE_MODELS;

// Validates minimum configuration before starting.
if (!TELEGRAM_BOT_TOKEN) {
  console.error('[Rotator] ERROR: environment variable TELEGRAM_BOT_TOKEN is not set.');
  process.exit(1);
}
if (API_KEYS.length === 0) {
  console.error('[Rotator] ERROR: environment variable TELEGRAM_API_KEYS is not set.');
  process.exit(1);
}
if (MODELS.length === 0) {
  console.error('[Rotator] ERROR: environment variable TELEGRAM_AVAILABLE_MODELS is not set.');
  console.error('[Rotator] The wrapper always controls model switching explicitly — set it to the');
  console.error('[Rotator] comma-separated models to rotate, e.g. TELEGRAM_AVAILABLE_MODELS="model-a,model-b".');
  process.exit(1);
}

// Where cline keeps the connector's own logs. We rotate off these files instead
// of parsing stdout: the Telegram connector records runtime errors (e.g.
// `INFERENCE_CAP_ERROR` / "Error 429: Daily free limit reached") here.
const CLINE_LOGS_DIR = path.join(os.homedir(), '.cline', 'data', 'logs');
const TELEGRAM_LOG_DIR = path.join(CLINE_LOGS_DIR, 'connectors', 'telegram');
const SHARED_CLINE_LOG = path.join(CLINE_LOGS_DIR, 'cline.log');

// All diagnostics also go to connector.log, so "no log" can't hide anything
// even when stdout is not redirected.
const WRAPPER_LOG = path.join(__dirname, '..', 'connector.log');

// Matches rate-limit / quota / capacity errors. Kept to strong patterns so
// unrelated numbers (e.g. token counts) can't trigger a false rotation — the
// real errors always carry INFERENCE_CAP_ERROR, "daily free limit", or an
// explicit "Error 429"/"rate limit"/"too many requests".
const LIMIT_RE = /INFERENCE_CAP_ERROR|daily free limit|Error 429|rate limit|too many requests|quota exceeded/i;
// Only react to telegram-connector entries in the shared cline.log.
const IS_TELEGRAM_RE = /"component"\s*:\s*"telegram-connect"/;
const BOT_USER_ID_RE = /"botUserId"\s*:\s*"([^"]+)"/;
const PID_RE = /"pid"\s*:\s*(\d+)/;

// ── RPC hub ports ─────────────────────────────────────────────────────────
// Each instance gets its OWN RPC hub port via --rpc-address. The default hub
// (127.0.0.1:25463) keys per-thread locks by the *user's* chat id
// ("telegram:<userId>"), which is identical across all bot instances sharing
// that user — so a turn on one bot held the hub lock and the other bots'
// messages were DROPPED with LOCK_FAILED (no retry, no reply). Separate hubs
// per instance isolate those locks so all agents can talk at once.
const RPC_HUB_PORTS = { MANAGER: 25463, FSCENE: 25464, EVOL: 25465 };
const rpcPort =
  parseInt(process.env[`TELEGRAM_RPC_PORT_${PROJECT_ARG}`] || '', 10) ||
  RPC_HUB_PORTS[PROJECT_ARG] ||
  25463;

// ── Task progress ──────────────────────────────────────────────────────────
const TASKS_FILE = process.env[`TELEGRAM_TASKS_FILE_${PROJECT_ARG}`] || process.env.TELEGRAM_TASKS_FILE || '';
// Each agent's task list lives in ITS OWN workspace, so the scanned directory
// is per-instance: TELEGRAM_TASKS_DIR_<NAME> wins, then TELEGRAM_TASKS_DIR,
// then the agent's known workspace, then the wrapper's cwd.
const TASKS_DIR_DEFAULTS = {
  FSCENE: path.join(os.homedir(), 'Projects', 'fscene', 'flutter_scene'),
  EVOL: path.join(os.homedir(), 'Projects', 'com.appfy.evol'),
};
const TASKS_DIR = process.env[`TELEGRAM_TASKS_DIR_${PROJECT_ARG}`] || process.env.TELEGRAM_TASKS_DIR || TASKS_DIR_DEFAULTS[PROJECT_ARG] || process.cwd();

// ── Auto-resume ────────────────────────────────────────────────────────────
const RESUME_DELAY_MS = 5000;            // let the fresh connector settle first
const RESUME_RUN_TIMEOUT_S = 900;        // cap on the resumed agent run (15 min)
const RESUME_RUN_TIMEOUT_MS = RESUME_RUN_TIMEOUT_S * 1000 + 30000;

// ── Duplicate-instance guard ───────────────────────────────────────────────
const PIDS_FILE = path.join(__dirname, '..', 'agents.pids.json');
const INSTANCE_NAME = PROJECT_ARG || 'DEFAULT';

// ── Hub discovery paths ────────────────────────────────────────────────────
// Per-instance hub isolation (see RPC_HUB_PORTS above): --rpc-address alone is
// NOT enough — hub discovery uses the GLOBAL record production.json, so every
// connector finds and joins the same shared hub and the per-thread locks
// collide across bots. Each instance therefore gets its own hub PORT and its
// own DISCOVERY record.
const HUB_LOCKS_DIR = path.join(os.homedir(), '.cline', 'data', 'locks', 'hub');
// Discovery record the WRAPPER reads to connect to this instance's hub (the
// default production.json for MANAGER; a private <NAME>.json for the rest).
const hubDiscoveryRecord = () =>
  path.join(HUB_LOCKS_DIR, PROJECT_ARG && PROJECT_ARG !== 'MANAGER' ? `${PROJECT_ARG}.json` : 'production.json');
// Discovery file the CONNECTOR's hub daemon publishes (private-port instances
// only — the default-port MANAGER resolves production.json itself).
const hubDiscoveryFile = () => path.join(HUB_LOCKS_DIR, `${PROJECT_ARG || 'DEFAULT'}.json`);

module.exports = {
  API_KEYS,
  MODELS,
  PROJECT_ARG,
  TELEGRAM_BOT_TOKEN,
  ALLOWED_USER_ID,
  RESTART_DELAY_MS,
  BOT_USER_ID,
  CLINE_LOGS_DIR,
  TELEGRAM_LOG_DIR,
  SHARED_CLINE_LOG,
  WRAPPER_LOG,
  LIMIT_RE,
  IS_TELEGRAM_RE,
  BOT_USER_ID_RE,
  PID_RE,
  rpcPort,
  TASKS_FILE,
  TASKS_DIR,
  RESUME_DELAY_MS,
  RESUME_RUN_TIMEOUT_S,
  RESUME_RUN_TIMEOUT_MS,
  PIDS_FILE,
  INSTANCE_NAME,
  hubDiscoveryRecord,
  hubDiscoveryFile,
};