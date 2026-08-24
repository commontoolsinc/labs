#!/bin/bash
# wait-load.sh <threshold> <max-minutes>: poll 60s until 1-min load < threshold.
# If a gate-threshold file exists beside this script, its value OVERRIDES the
# argument (2026-08-24: set to 6 — today's ambient is 5.5-6 from the box's
# resident daemon pair vs 4.2-5.8 in the dossier era; threshold 5 only burns
# the 20-min timeout and then proceeds at the same load. Per-run loads stay
# in the ledger; pairs stay adjacent).
set -u
THRESH_FILE="$(cd "$(dirname "$0")" && pwd)/gate-threshold"
THRESH="${1:-5}"
[ -r "$THRESH_FILE" ] && THRESH="$(cat "$THRESH_FILE")"
MAXMIN="${2:-15}"
for ((i=0; i<=MAXMIN; i++)); do
  L1=$(sysctl -n vm.loadavg | awk '{print $2}')
  OK=$(python3 -c "print(1 if $L1 < $THRESH else 0)")
  if [ "$OK" = "1" ]; then echo "load-ok $L1 (threshold $THRESH)"; exit 0; fi
  echo "load-high $L1 (poll $i/$MAXMIN, threshold $THRESH)"; sleep 60
done
echo "load-timeout"; exit 1
