#!/bin/bash
# run_arm.sh MODE LEAD_S BUMP_MTIME
# Fresh mount per run. The file "appears" LEAD_S seconds after the driver
# starts, via an absolute epoch shared by the C fs and the driver.
set -u
cd /tmp/fuse-exp
MODE="${1:-arm_a}"; LEAD="${2:-8}"; BUMP="${3:-0}"
LOG="fs_${MODE}_bump${BUMP}.log"
DRV="drv_${MODE}_bump${BUMP}.log"

umount mnt 2>/dev/null; sleep 1
: > "$LOG"
# appear epoch = now + settle(2s) + LEAD
NOW_MS=$(python3 -c 'import time;print(int(time.time()*1000))')
APPEAR_EPOCH_MS=$(( NOW_MS + 2000 + LEAD*1000 ))
APPEAR_EPOCH_MS="$APPEAR_EPOCH_MS" BUMP_MTIME="$BUMP" ./synthfs mnt -f ${MOPTS:-} 2>"$LOG" &
FSPID=$!
sleep 2   # let mount settle
python3 driver.py "$MODE" mnt "$APPEAR_EPOCH_MS" | tee "$DRV"
sleep 1
umount mnt 2>/dev/null; sleep 1
kill "$FSPID" 2>/dev/null; wait "$FSPID" 2>/dev/null

echo
echo "===== DAEMON LOG: target/readdir events (noise filtered) ====="
grep -E "target|readdir /dir|mount start" "$LOG" | grep -v "._"
echo "===== end ====="
