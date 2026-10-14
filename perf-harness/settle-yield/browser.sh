#!/bin/bash
# browser.sh <arm a|b> <label>
# One headless-browser load of the seeded room from that arm's shell and
# toolshed. Writes <label>.load1.* under $OUT/out: step timings, the worker's
# logger rows, and a CPU profile of the worker. ROOM_LAST_TEXT is the text of
# the room's last message, which the load waits for.
set -u
source "$(dirname "$0")/env.sh"
ARM=$1; LABEL=$2; O=$OUT/out; OFF=$(arm_off "$ARM")
# The harness process is not what is measured, so it runs from arm a's
# checkout for both arms; only the two URLs select the arm.
cd "$REPO_A" || exit 1
load_now > "$O/$LABEL.load"
API_URL="http://localhost:$((8000+OFF))/" FRONTEND_URL="http://localhost:$((5173+OFF))/" \
  HEADLESS=true ROOM_FIXTURE="$OUT/room.json" \
  ROOM_OUT="$O/$LABEL" ROOM_LOADS=1 ROOM_CAPTURE_S=2400 ROOM_PROFILE_US=2000 \
  ROOM_LAST_TEXT="$(cat "$OUT/last-text")" \
  deno test -A --no-check --config deno.jsonc "$HARNESS_DIR/room-load.test.ts" \
  > "$O/$LABEL.browser.log" 2>&1
echo "exit $?" >> "$O/$LABEL.load"
load_now >> "$O/$LABEL.load"
