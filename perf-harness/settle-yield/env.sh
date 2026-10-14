# Sourced by every script here. Two arms: `a` is this checkout (the branch
# under test), `b` is a worktree of the main commit the branch last merged.
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_A="$(cd "$HARNESS_DIR/../.." && pwd)"
# Everything the measurement writes goes here, outside both checkouts.
OUT="${SETTLE_YIELD_OUT:-$HOME/settle-yield-measure}"
REPO_B="${REPO_B:-$OUT/base}"
OFF_A="${OFF_A:-37}"
OFF_B="${OFF_B:-38}"
arm_repo() { if [ "$1" = a ]; then echo "$REPO_A"; else echo "$REPO_B"; fi; }
arm_off() { if [ "$1" = a ]; then echo "$OFF_A"; else echo "$OFF_B"; fi; }
load_now() { uptime | sed -E 's/.*load averages?: //'; }
mkdir -p "$OUT/out"
