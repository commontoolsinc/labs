#!/bin/bash
# render.sh <arm a|b> <label>
# One `cf piece render` of the seeded room, run from that arm's checkout
# against that arm's toolshed. Writes <label>.* under $OUT/out: the CPU
# times, the frame log, the logger's timing rows, and the timestamped spans.
set -u
source "$(dirname "$0")/env.sh"
ARM=$1; LABEL=$2; O=$OUT/out; FIX=$OUT/room.json
field() { python3 -c "import json;print(json.load(open('$FIX'))['$1'])"; }
cd "$(arm_repo "$ARM")" || exit 1
load_now > "$O/$LABEL.load"
TIMEFORMAT='%R real %U user %S sys'
{ time CF_TIMING_MEASURES=1 CF_PROF_OUT="$O/$LABEL" \
  CF_MEMORY_FRAME_LOG="$O/$LABEL.frames.jsonl" CF_IDENTITY="$(field keyPath)" \
  CF_API_URL="http://localhost:$((8000+$(arm_off "$ARM")))/" \
  deno run --quiet --config deno.jsonc --allow-net --allow-ffi --allow-read \
  --allow-write --allow-env --allow-run --allow-sys \
  skills/perf-investigation/scripts/profile-cf.ts piece render \
  --space "$(field roomSpace)" --cell "$(field roomId)" \
  > "$O/$LABEL.html" 2> "$O/$LABEL.err" ; } 2>> "$O/$LABEL.err"
echo "exit $?" >> "$O/$LABEL.load"
load_now >> "$O/$LABEL.load"
