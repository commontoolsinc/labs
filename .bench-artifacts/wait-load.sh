#!/bin/bash
# wait-load.sh <threshold> <max-minutes>: poll 60s until 1-min load < threshold.
set -u
THRESH="${1:-5}"; MAXMIN="${2:-15}"
for ((i=0; i<=MAXMIN; i++)); do
  L1=$(sysctl -n vm.loadavg | awk '{print $2}')
  OK=$(python3 -c "print(1 if $L1 < $THRESH else 0)")
  if [ "$OK" = "1" ]; then echo "load-ok $L1"; exit 0; fi
  echo "load-high $L1 (poll $i/$MAXMIN)"; sleep 60
done
echo "load-timeout"; exit 1
