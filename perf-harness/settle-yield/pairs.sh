#!/bin/bash
# pairs.sh <render|browser> <prefix> <from> <to> <par|seq>
# Runs pairs <prefix><n>-a and <prefix><n>-b for n in from..to. `par` runs the
# two arms of a pair at the same time, so whatever else loads the machine
# loads both; use it only with cores to spare. `seq` runs them one after the
# other and alternates which goes first, a b b a a b b a.
set -u
source "$(dirname "$0")/env.sh"
KIND=$1; PREFIX=$2; FROM=$3; TO=$4; MODE=$5; RUN="$HARNESS_DIR/$KIND.sh"
for n in $(seq "$FROM" "$TO"); do
  if [ "$MODE" = par ]; then
    "$RUN" a "$PREFIX$n-a" & "$RUN" b "$PREFIX$n-b" & wait
  elif [ $((n % 2)) = 1 ]; then
    "$RUN" a "$PREFIX$n-a"; "$RUN" b "$PREFIX$n-b"
  else
    "$RUN" b "$PREFIX$n-b"; "$RUN" a "$PREFIX$n-a"
  fi
  echo "$PREFIX$n: a $(grep exit "$OUT/out/$PREFIX$n-a.load") b $(grep exit "$OUT/out/$PREFIX$n-b.load")"
done
