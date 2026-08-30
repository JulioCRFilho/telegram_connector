#!/bin/bash
# Restart one telegram_connector wrapper instance.
#   restart-agent.sh <NAME>            graceful (running wrapper is SIGTERMed first)
#   restart-agent.sh <NAME> --force    forced (no live wrapper expected — e.g. the
#                                      auto-heal watcher restarting a dead one)
#
# Environment is restored from agents.env-<NAME>.json, which main.js writes at
# every boot with mode 0600. This replaced parsing `ps eww` (which mangles any
# env value containing a space — e.g. TELEGRAM_API_KEYS="sk-a, sk-b") and makes
# restarts possible even from a fully DEAD wrapper.
set -u
NAME="$1"
FORCE="${2:-}"
DIR="/Users/thetod/Projects/telegram_connector"
cd "$DIR" || exit 1
STAMP="$(date -u +%FT%TZ)"

ENVFILE="$DIR/agents.env-$NAME.json"
TMPENV="$(mktemp "$DIR/.env-$NAME.XXXXXX")" || exit 1
trap 'rm -f "$TMPENV"' EXIT
if [ -f "$ENVFILE" ]; then
  # Preferred path: the env file the wrapper writes at every boot (mode 0600).
  python3 - "$ENVFILE" "$TMPENV" <<'PY' || { echo "$STAMP $NAME: could not build env from $ENVFILE" >&2; exit 1; }
import json, shlex, sys
d = json.load(open(sys.argv[1]))
with open(sys.argv[2], 'w') as f:
    for k, v in d.items():
        if k.startswith('TELEGRAM_') and v is not None:
            f.write(f"export {k}={shlex.quote(str(v))}\n")
PY
else
  # Transition fallback (pre-env-file wrappers): reconstruct from `ps eww`,
  # split on the FIRST '=' so values containing spaces are kept whole.
  PID="${PID:-}"
  if [ "$FORCE" = "--force" ] || [ -z "$PID" ] || [ "$PID" -le 0 ] 2>/dev/null; then
    echo "$STAMP $NAME: no agents.env-$NAME.json and no live wrapper to read env from; abort." >&2
    exit 1
  fi
  ps eww -p "$PID" | python3 -c '
import shlex, sys
envs = {}
cur = None
for tok in sys.stdin.read().strip().split(" "):
    if "=" in tok:
        name, val = tok.split("=", 1)
        cur = name if name.startswith("TELEGRAM_") else None
        if cur: envs[cur] = val
    elif cur:
        envs[cur] += " " + tok
with open("'$TMPENV'", "w") as f:
    for k, v in envs.items():
        f.write(f"export {k}={shlex.quote(v)}\n")
' || { echo "$STAMP $NAME: could not parse env from the live wrapper; abort." >&2; exit 1; }
fi

# ── Graceful stop of the running wrapper (skipped in --force mode) ──────────
if [ "$FORCE" != "--force" ]; then
  PID="$(python3 -c "import json,sys;d=json.load(open('$DIR/agents.pids.json'));print(d.get('$NAME',{}).get('wrapperPid',0))" 2>/dev/null)"
  if [ -z "$PID" ] || [ "$PID" -le 0 ] 2>/dev/null; then
    echo "$STAMP $NAME: no wrapper pid in agents.pids.json; abort." >&2
    exit 1
  fi
  if ! ps -o command= -p "$PID" | grep -q "main.js $NAME"; then
    echo "$STAMP $NAME: pid $PID is not the $NAME wrapper; abort." >&2
    exit 1
  fi

  kill -TERM "$PID"
  for _ in $(seq 1 30); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$PID" 2>/dev/null; then
    echo "$STAMP $NAME: wrapper pid $PID did not exit after 30s; abort." >&2
    exit 1
  fi
fi

. "$TMPENV"
nohup node main.js "$NAME" >> "$DIR/wrapper-$NAME.out" 2>&1 &
NEWPID=$!
echo "$STAMP $NAME: restarted (old wrapper ${PID:-<none>} -> new wrapper $NEWPID)"
