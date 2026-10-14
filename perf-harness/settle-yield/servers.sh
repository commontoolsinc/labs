#!/bin/bash
# servers.sh <arm a|b> <store-dir>
# Starts that arm's toolshed and shell from that arm's own checkout, on
# <store-dir>. One checkout per arm: a second pair started from one checkout
# rebuilds the first pair's shell against the wrong toolshed.
set -u
source "$(dirname "$0")/env.sh"
ARM=$1; STORE=$2; mkdir -p "$STORE"
cd "$(arm_repo "$ARM")" || exit 1
# The shell's first build can take minutes on a busy machine; the script's
# own limit is 120 s and it stops both servers when the limit passes.
LOCAL_DEV_STARTUP_TIMEOUT=1500 MEMORY_DIR="file://$STORE/" \
  ./scripts/restart-local-dev.sh --port-offset "$(arm_off "$ARM")" \
  > "$OUT/server-$ARM.log" 2>&1
echo "servers $ARM: exit $?"
