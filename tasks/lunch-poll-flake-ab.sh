#!/usr/bin/env bash
# Drives repeated runs of the lunch-poll browser integration test against a
# prebuilt toolshed binary and classifies every failure by its signature:
# the option-card wedge (the second option's vote button never renders), the
# guest join-input stall, or anything else. Part of the lunch-poll-flake-ab
# experiment workflow; not part of regular CI, and it leaves with that
# workflow's pull request.
#
# Inputs (environment):
#   TOOLSHED_BINARY  path to the toolshed binary to serve the tests (required)
#   RUNS             how many times to run the test (default 6)
#   RESULT_DIR       where failure logs and the summary land (default
#                    flake-ab-results)
#   SIDE, SHARD      labels echoed into the summary
#
# Run from the repository root of the tree whose test should execute.
set -euo pipefail

RUNS="${RUNS:-6}"
BINARY="${TOOLSHED_BINARY:?path to toolshed binary}"
OUT="${RESULT_DIR:-flake-ab-results}"
mkdir -p "$OUT"
OUT_ABS="$(cd "$OUT" && pwd)"

chmod +x "$BINARY"
# --background returns once the server has bound its port, so the runs below
# never race a not-yet-listening server (same invocation as the regular
# pattern-integration job).
CFTS_AI_GATEWAY_URL="" \
CFTS_AI_LLM_ANTHROPIC_API_KEY=fake \
  "$BINARY" --background --log-file="$OUT_ABS/toolshed.log"

pass=0
card=0
join=0
other=0
cd packages/patterns
for i in $(seq 1 "$RUNS"); do
  log="$OUT_ABS/run-$i.log"
  code=0
  # 420s caps a run whose in-test wait would otherwise spend its full 300s
  # plus teardown; a pass takes a fraction of that.
  HEADLESS=1 \
  API_URL=http://localhost:8000/ \
  CF_COMPILE_CACHE_FILE="$OUT_ABS/compile-cache.json" \
  timeout 420 deno test --no-check -A integration/lunch-poll-vote.test.ts \
    > "$log" 2>&1 || code=$?
  if [ "$code" -eq 0 ]; then
    pass=$((pass + 1))
    rm -f "$log"
    echo "run $i: pass"
  elif grep -q "data-option-title" "$log" &&
    grep -q "Timed out waiting" "$log"; then
    card=$((card + 1))
    echo "run $i: CARD-WEDGE (exit $code)"
  elif grep -q "lp-join-name" "$log"; then
    join=$((join + 1))
    echo "run $i: join-input stall (exit $code)"
  else
    other=$((other + 1))
    echo "run $i: other failure (exit $code)"
  fi
done

echo "FINAL side=${SIDE:-unlabeled} shard=${SHARD:-1}" \
  "pass=$pass card-wedge=$card join-input=$join other=$other"
{
  echo "### ${SIDE:-unlabeled} shard ${SHARD:-1}"
  echo ""
  echo "| pass | card-wedge | join-input | other |"
  echo "|---|---|---|---|"
  echo "| $pass | $card | $join | $other |"
  echo ""
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
