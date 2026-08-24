#!/bin/bash
# Pattern-test per-run driver: the topics/*.test.tsx files run through the
# repo's own harness (`deno task integration pattern-tests <filter>`), which
# applies the CTS transform plain `deno test` lacks (the p*/r*/m* rc=1 runs
# in this ledger died on exactly that: "module 'commonfabric' does not
# provide an export named 'NAME'"). pattern-tests needs NO server (runner's
# PACKAGES_WITHOUT_SERVER), so posture here is the env var alone — recorded,
# with no toolshed and no port.
# Usage: run-pattern.sh <run-id> <arm:on|off> <filter> [cap-s]
set -uo pipefail

RUN_ID="$1"; ARM="$2"; FILTER="$3"; CAP="${4:-520}"
BENCH="$(cd "$(dirname "$0")" && pwd)"
REPO=/Users/berni/labs-worktrees/topics-benchmark
RUNDIR="$BENCH/runs/$RUN_ID"
LEDGER="$BENCH/run-ledger.txt"

if [ -e "$RUNDIR" ]; then echo "FATAL: run dir exists: $RUNDIR" >&2; exit 2; fi
mkdir -p "$RUNDIR"

log() { echo "$*" >> "$LEDGER"; }

LOAD_BEFORE=$(sysctl -n vm.loadavg | tr -d '{}')
log "== $RUN_ID"
log "start_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ) workload=pattern:$FILTER arm=$ARM (no server; env-var posture only) cap_s=$CAP"
log "load_before={$LOAD_BEFORE}"
log "repo=$REPO head=$(cd "$REPO" && git rev-parse --short=12 HEAD)"
log "llm_env_check: CFTS_AI_LLM keys in env=$(env | grep -c CFTS_AI_LLM || true) toolshed_dotenv=$([ -e "$REPO/packages/toolshed/.env" ] && echo present || echo absent)"
if [ "$ARM" = on ]; then
  log "  posture: EXPERIMENTAL_SERVER_EXECUTION=true (env)"
else
  log "  posture: EXPERIMENTAL_SERVER_EXECUTION unset (env)"
fi

( while true; do echo "$(date -u +%H:%M:%S) $(sysctl -n vm.loadavg | tr -d '{}')" >> "$RUNDIR/load-samples.txt"; sleep 10; done ) </dev/null >/dev/null 2>&1 &
SAMPLER_PID=$!

cd "$REPO"
T0=$(date +%s)
if [ "$ARM" = on ]; then
  env LOG_LEVEL=warn EXPERIMENTAL_SERVER_EXECUTION=true gtimeout --kill-after=30 "$CAP" deno task --no-lock integration "--junit-dir=$RUNDIR" pattern-tests "$FILTER" > "$RUNDIR/test.log" 2>&1
else
  env -u EXPERIMENTAL_SERVER_EXECUTION LOG_LEVEL=warn gtimeout --kill-after=30 "$CAP" deno task --no-lock integration "--junit-dir=$RUNDIR" pattern-tests "$FILTER" > "$RUNDIR/test.log" 2>&1
fi
TEST_RC=$?
T1=$(date +%s)
log "test_rc=$TEST_RC test_wall_s=$((T1-T0)) (rc 124 = hard cap ${CAP}s hit)"
DROPS=$(grep -c "action argument is undefined (potential schema mismatch) -- not running" "$RUNDIR/test.log" || true)
log "echo_drop_guard_lines=$DROPS"
CONFLICTS=$(grep -c "tx-commit-error" "$RUNDIR/test.log" || true)
log "tx_commit_error_lines=$CONFLICTS"
LOAD_AFTER=$(sysctl -n vm.loadavg | tr -d '{}')
log "load_after={$LOAD_AFTER}"

kill "$SAMPLER_PID" 2>/dev/null || true
wait "$SAMPLER_PID" 2>/dev/null || true
log ""
echo "RUN_DONE $RUN_ID rc=$TEST_RC wall=$((T1-T0))s drops=$DROPS"
