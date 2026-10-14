#!/bin/bash
# last-text.sh <label>
# Writes $OUT/last-text: the text of the highest-numbered message a render
# of the room shows, which a browser load waits for. The seed can lose a
# send when the machine is busy, so this is read from the room and not
# assumed to be message thirty.
set -u
source "$(dirname "$0")/env.sh"
grep -o 'Message [0-9]* from member [0-9]*' "$OUT/out/$1.html" \
  | sort -t' ' -k2 -n | tail -1 > "$OUT/last-text"
echo "$(grep -o 'Message [0-9]* from member [0-9]*' "$OUT/out/$1.html" | sort -u | wc -l | tr -d ' ') messages; last: $(cat "$OUT/last-text")"
