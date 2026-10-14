#!/bin/bash
# toolshed.sh <arm a|b> stop | start <store-dir>
# Stops, or starts on <store-dir>, only that arm's toolshed. The arm's shell
# keeps running: it is built against the toolshed's port, not its process.
set -u
source "$(dirname "$0")/env.sh"
ARM=$1; ACT=$2; OFF=$(arm_off "$ARM"); TP=$((8000+OFF)); SP=$((5173+OFF))
if [ "$ACT" = stop ]; then
  # The port in the command line makes the match this arm's toolshed alone.
  for PID in $(pgrep -f "index.ts --port=$TP"); do kill "$PID"; done
  while curl -s -m 2 -o /dev/null "http://localhost:$TP/_health"; do sleep 0.5; done
  echo "toolshed $ARM stopped"
else
  STORE=$3
  cd "$(arm_repo "$ARM")/packages/toolshed" || exit 1
  SHELL_URL="http://localhost:$SP" API_URL="http://localhost:$TP" \
  MEMORY_URL="http://localhost:$TP" MEMORY_DIR="file://$STORE/" \
  PORT_OFFSET=$OFF SHELL_PORT=$SP TOOLSHED_PORT=$TP \
    nohup deno run --unstable-otel -A --env-file=.env index.ts --port=$TP \
    > "$OUT/toolshed-$ARM.log" 2>&1 &
  until curl -s -m 3 -o /dev/null "http://localhost:$TP/_health"; do sleep 1; done
  echo "toolshed $ARM up on $STORE"
fi
