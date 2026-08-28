#!/bin/bash
# Graceful restart of one telegram_connector wrapper instance.
# Usage: restart-agent.sh <NAME>   (e.g. restart-agent.sh EVOL)
# Reads the current wrapper pid from agents.pids.json (so it always targets the
# live wrapper even after rotations), captures its TELEGRAM_* environment,
# SIGTERMs it (the wrapper then stops its connector and clears its pid entry),
# and relaunches `node main.js <NAME>` detached with the same environment.
set -u
NAME="$1"
DIR="/Users/thetod/Projects/telegram_connector"
cd "$DIR" || exit 1
STAMP="$(date -u +%FT%TZ)"

PID="$(python3 -c "import json,sys;d=json.load(open('$DIR/agents.pids.json'));print(d.get('$NAME',{}).get('wrapperPid',0))" 2>/dev/null)"
if [ -z "$PID" ] || [ "$PID" -le 0 ] 2>/dev/null; then
  echo "$STAMP $NAME: no wrapper pid in agents.pids.json; abort." >&2
  exit 1
fi
if ! ps -o command= -p "$PID" | grep -q "main.js $NAME"; then
  echo "$STAMP $NAME: pid $PID is not the $NAME wrapper; abort." >&2
  exit 1
fi

# Capture env BEFORE killing — relaunch must use identical config.
ENVSTR="$(ps eww -p "$PID" | tr ' ' '\n' | grep -E '^TELEGRAM_[A-Z_0-9]+=' | tr '\n' ' ')"
if [ -z "$ENVSTR" ]; then
  echo "$STAMP $NAME: could not capture environment from pid $PID; abort." >&2
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

nohup env $ENVSTR node main.js "$NAME" >> "$DIR/wrapper-$NAME.out" 2>&1 &
NEWPID=$!
echo "$STAMP $NAME: restarted (old wrapper $PID -> new wrapper $NEWPID)"
