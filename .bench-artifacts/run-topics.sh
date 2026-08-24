#!/bin/bash
# W4-protocol per-run driver, topics edition (topics-benchmark seat).
# Usage: run-topics.sh <run-id> <arm:on|off> <port> <workload:test|journey> [series-n]
#   test    = integration/topics-navigation.test.ts (the lifted file, as-is)
#   journey = integration/topics-journey-bench.scratch.test.ts (untracked
#             instrument; source snapshot committed to flip-dossier-raw/)
# Recipe = flip-readiness-dossier.md §2 verbatim (the W4 protocol):
# stray check -> load before -> fresh cwd store -> boot binary --background
# --log-file --port=P with PORT/API_URL/MEMORY_URL on P -> posture probe ->
# ONE test file from packages/patterns under gtimeout 520 -> post stats ->
# load after -> PID-only kill -> port free check -> orphan browser check ->
# store commit count. Topics addition: the OW60 echo-drop guard line count
# ("action argument is undefined (potential schema mismatch) -- not running")
# grepped from test.log into the ledger per run.
set -uo pipefail

RUN_ID="$1"; ARM="$2"; PORT="$3"; WORKLOAD="$4"; SERIES_N="${5:-20}"
BENCH="$(cd "$(dirname "$0")" && pwd)"
REPO=/Users/berni/labs-worktrees/topics-benchmark
BIN_ON="$BENCH/bin/toolshed-on"; BIN_OFF="$BENCH/bin/toolshed-off"
RUNDIR="$BENCH/runs/$RUN_ID"
LEDGER="$BENCH/run-ledger.txt"

if [ -e "$RUNDIR" ]; then echo "FATAL: run dir exists: $RUNDIR" >&2; exit 2; fi
mkdir -p "$RUNDIR/srv"

log() { echo "$*" >> "$LEDGER"; }

# 1. stray check
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | tail -n +2 | grep -q .; then
  echo "FATAL: port $PORT occupied" >&2; lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2; exit 2
fi

# browser snapshot before (for orphan detection; RECORD ONLY, PID-kill later
# only what appeared during the run, is --headless, and has ppid 1)
ps -axo pid,ppid,command | grep -i "[c]hrome" | grep -- "--headless" | awk '{print $1}' | sort > "$RUNDIR/chrome-before.txt" || true

LOAD_BEFORE=$(sysctl -n vm.loadavg | tr -d '{}')
START_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)

log "== $RUN_ID"
log "start_utc=$START_UTC workload=$WORKLOAD arm=$ARM port=$PORT series_n=$SERIES_N"
log "load_before={$LOAD_BEFORE}"

case "$ARM" in
  on)  BINARY="$BIN_ON";;
  off) BINARY="$BIN_OFF";;
  *) echo "FATAL: arm must be on|off" >&2; exit 2;;
esac
SHA=$(shasum -a 256 "$BINARY" | cut -c1-16)
log "binary=$BINARY sha256=$SHA repo=$REPO head=$(cd "$REPO" && git rev-parse --short=12 HEAD)"
log "llm_env_check: CFTS_AI_LLM keys in env=$(env | grep -c CFTS_AI_LLM || true) toolshed_dotenv=$([ -e "$REPO/packages/toolshed/.env" ] && echo present || echo absent)"

# 2. boot (fresh cwd = fresh store)
BOOT_ENV=(PORT="$PORT" API_URL="http://localhost:$PORT" MEMORY_URL="http://localhost:$PORT")
cd "$RUNDIR/srv"
if [ "$ARM" = on ]; then
  env "${BOOT_ENV[@]}" EXPERIMENTAL_SERVER_EXECUTION=true "$BINARY" --background "--log-file=$RUNDIR/toolshed.log" "--port=$PORT" > "$RUNDIR/boot.log" 2>&1
else
  env -u EXPERIMENTAL_SERVER_EXECUTION "${BOOT_ENV[@]}" "$BINARY" --background "--log-file=$RUNDIR/toolshed.log" "--port=$PORT" > "$RUNDIR/boot.log" 2>&1
fi
BOOT_RC=$?
if [ $BOOT_RC -ne 0 ]; then log "BOOT FAILED rc=$BOOT_RC"; cat "$RUNDIR/boot.log" >&2; exit 3; fi
TOOLSHED_PID=$(lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN | head -1)
log "toolshed_pid=$TOOLSHED_PID"

# 3. posture probe
curl -s "http://localhost:$PORT/api/meta" > "$RUNDIR/meta.json"
curl -s "http://localhost:$PORT/api/health/stats" > "$RUNDIR/stats-pre.json"
GITSHA=$(python3 -c "import json;d=json.load(open('$RUNDIR/meta.json'));print(d.get('gitSha','?')[:12])" 2>/dev/null || echo "?")
DEFINE=$(python3 -c "import json;d=json.load(open('$RUNDIR/meta.json'));print(d.get('shellServerExecutionDefine'))" 2>/dev/null || echo "?")
SERVING_PRE=$(python3 -c "import json;d=json.load(open('$RUNDIR/stats-pre.json'));print('servingLoop' in d)" 2>/dev/null || echo "?")
log "  posture: gitSha=$GITSHA define=$DEFINE servingLoop_pre=$SERVING_PRE"

# 4. 10-s load sampler
( while true; do echo "$(date -u +%H:%M:%S) $(sysctl -n vm.loadavg | tr -d '{}')" >> "$RUNDIR/load-samples.txt"; sleep 10; done ) </dev/null >/dev/null 2>&1 &
SAMPLER_PID=$!

# 5. the ONE test file
case "$WORKLOAD" in
  test) TEST_FILE=integration/topics-navigation.test.ts
        WL_ENV=(CF_TOPICS_SERIES=0);;
  journey) TEST_FILE=integration/topics-journey-bench.scratch.test.ts
        WL_ENV=(CF_TOPICS_SERIES="$SERIES_N" CF_TOPICS_SERIES_DELAY_MS=2000);;
  *) echo "FATAL: workload" >&2; exit 2;;
esac
TEST_ENV=(LOG_LEVEL=warn HEADLESS=1 API_URL="http://localhost:$PORT" SPACE_NAME="topicsbench-$RUN_ID" "${WL_ENV[@]}")
cd "$REPO/packages/patterns"
T0=$(date +%s)
if [ "$ARM" = on ]; then
  env "${TEST_ENV[@]}" EXPERIMENTAL_SERVER_EXECUTION=true gtimeout --kill-after=30 520 deno test -A --no-lock --v8-flags=--max-old-space-size=4096 --trace-leaks --junit-path="$RUNDIR/junit.xml" "$TEST_FILE" > "$RUNDIR/test.log" 2>&1
else
  env -u EXPERIMENTAL_SERVER_EXECUTION "${TEST_ENV[@]}" gtimeout --kill-after=30 520 deno test -A --no-lock --v8-flags=--max-old-space-size=4096 --trace-leaks --junit-path="$RUNDIR/junit.xml" "$TEST_FILE" > "$RUNDIR/test.log" 2>&1
fi
TEST_RC=$?
T1=$(date +%s)
log "test_rc=$TEST_RC test_wall_s=$((T1-T0)) (rc 124 = hard cap 520s hit)"
DROPS=$(grep -c "action argument is undefined (potential schema mismatch) -- not running" "$RUNDIR/test.log" || true)
log "echo_drop_guard_lines=$DROPS"
CONFLICTS=$(grep -c "tx-commit-error" "$RUNDIR/test.log" || true)
log "tx_commit_error_lines=$CONFLICTS"

# 6. post stats + teardown
curl -s "http://localhost:$PORT/api/health/stats" > "$RUNDIR/stats-post.json"
LOAD_AFTER=$(sysctl -n vm.loadavg | tr -d '{}')
log "load_after={$LOAD_AFTER}"
DEFAULT_MODEL=$(grep -o "No default model available" "$RUNDIR/toolshed.log" | head -1)
[ -z "$DEFAULT_MODEL" ] && DEFAULT_MODEL="(default-model line ABSENT - check log)"
log "default_model=$DEFAULT_MODEL"

kill "$SAMPLER_PID" 2>/dev/null || true
wait "$SAMPLER_PID" 2>/dev/null || true

if [ -n "$TOOLSHED_PID" ]; then kill "$TOOLSHED_PID" 2>/dev/null || true; fi
for i in 1 2 3 4 5 6 7 8 9 10; do
  if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | tail -n +2 | grep -q .; then break; fi
  sleep 1
done
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | tail -n +2 | grep -q .; then
  LEFT=$(lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN | head -1)
  kill -9 "$LEFT" 2>/dev/null || true
  sleep 1
fi
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | tail -n +2 | grep -q . && log "WARN: port $PORT still occupied" || log "port_free=yes"

# 7. orphaned headless browsers that appeared during the run (ppid 1 only)
ps -axo pid,ppid,command | grep -i "[c]hrome" | grep -- "--headless" | awk '$2==1{print $1}' | sort > "$RUNDIR/chrome-after-orphans.txt" || true
ORPHANS=$(comm -13 "$RUNDIR/chrome-before.txt" "$RUNDIR/chrome-after-orphans.txt" 2>/dev/null || true)
if [ -n "$ORPHANS" ]; then
  log "orphan_headless_pids_killed=$(echo "$ORPHANS" | tr '\n' ' ')"
  for p in $ORPHANS; do kill "$p" 2>/dev/null || true; done
else
  log "orphan_headless=none"
fi

# 8. store commit count by class
STORE_COUNT=$(python3 "$BENCH/count-store.py" "$RUNDIR/srv" 2>&1 || echo "count-failed")
log "store_commits: $STORE_COUNT"
log ""
echo "RUN_DONE $RUN_ID rc=$TEST_RC wall=$((T1-T0))s drops=$DROPS"
