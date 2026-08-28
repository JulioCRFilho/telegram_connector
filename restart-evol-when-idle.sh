#!/bin/bash
# Deferred restart for EVOL: wait until its current task finishes, then restart.
# EVOL's pending unanswered message lives in agents.state-EVOL.json and is
# removed exactly when the turn completes (lastmessage.clear). So: poll until
# the file is gone, hold a grace period to make sure it doesn't reappear
# (a new message would recreate it), then restart. Hard-capped at DEADLINE_S.
set -u
DIR="/Users/thetod/Projects/telegram_connector"
STATE="$DIR/agents.state-EVOL.json"
POLL=30
DEADLINE_S=$((6 * 60 * 60))   # 6h cap — give up rather than restart mid-task
START=$(date +%s)

echo "$(date -u +%FT%TZ) EVOL watcher: waiting for current task to finish..."
while [ -f "$STATE" ]; do
  sleep "$POLL"
  if [ $(( $(date +%s) - START )) -gt "$DEADLINE_S" ]; then
    echo "$(date -u +%FT%TZ) EVOL watcher: deadline hit while still busy; NOT restarting."
    exit 0
  fi
done

# Grace: a message landing right now must not get a restart mid-turn.
sleep 60
if [ -f "$STATE" ]; then
  echo "$(date -u +%FT%TZ) EVOL watcher: new task arrived during grace; re-arming."
  exec bash "$0"
fi

echo "$(date -u +%FT%TZ) EVOL watcher: task finished; restarting EVOL."
bash "$DIR/restart-agent.sh" EVOL
