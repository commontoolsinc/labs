#!/usr/bin/env bash
set -euo pipefail

export LOG_TO_STDERR=1
# Surface piece-list build/sync diagnostics in the daemon log; without this a
# "piece dir never appeared" timeout gives no signal about what the daemon saw.
export CF_FUSE_DEBUG=1

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)

error() {
  >&2 echo "ERROR: $1"
  dump_mount_state
  exit 1
}

# On failure, show what the mounted tree actually contains so "path never
# appeared" failures distinguish an empty piece list from a misnamed entry.
dump_mount_state() {
  if [ -z "${MOUNTPOINT:-}" ] || [ -z "${SPACE:-}" ]; then
    return 0
  fi
  local pieces_dir="$MOUNTPOINT/$SPACE/pieces"
  >&2 echo "--- mount state dump ---"
  if path_exists "$pieces_dir" 2; then
    >&2 ls -la "$pieces_dir" 2>&1 || true
    if path_exists "$pieces_dir/pieces.json" 2; then
      >&2 echo "--- pieces.json ---"
      >&2 cat "$pieces_dir/pieces.json" 2>&1 || true
    fi
  else
    >&2 echo "(pieces dir not reachable: $pieces_dir)"
  fi
  >&2 echo "--- end mount state dump ---"
}

success() {
  echo "✓ $1"
}

if [ -n "${CF_CLI_INTEGRATION_USE_LOCAL:-}" ]; then
  cf() {
    deno task cli "$@"
  }
fi

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local message="$3"

  if [[ "$haystack" != *"$needle"* ]]; then
    error "$message"
  fi
}

assert_not_exists() {
  local path="$1"
  local message="$2"

  if path_exists "$path"; then
    error "$message"
  fi
}

path_exists() {
  local path="$1"
  local probe_timeout="${2:-3}"

  if command -v timeout >/dev/null 2>&1; then
    timeout --signal=KILL "$probe_timeout" test -e "$path" >/dev/null 2>&1
    return $?
  fi

  test -e "$path"
}

assert_json_eq() {
  local actual="$1"
  local expected="$2"
  local message="$3"

  local actual_json expected_json
  actual_json=$(printf '%s\n' "$actual" | jq -S -c .)
  expected_json=$(printf '%s\n' "$expected" | jq -S -c .)

  if [ "$actual_json" != "$expected_json" ]; then
    error "$message. Expected: $expected_json, got: $actual_json"
  fi
}

wait_for_path() {
  local path="$1"
  local timeout_seconds="${2:-20}"
  local started_at
  started_at=$(date +%s)

  while true; do
    # Initial lazy hydration of FUSE paths may need a network round-trip.
    if path_exists "$path" 1; then
      return 0
    fi
    if [ $(( $(date +%s) - started_at )) -ge "$timeout_seconds" ]; then
      break
    fi
    sleep 0.1
  done

  error "Timed out waiting for path: $path"
}

# A mounted JSON document answers lookups from a stub while the daemon hydrates
# the piece behind it, and rebuilds land on a debounce after that, so the path
# existing says nothing about the content being final. Poll the document until
# it renders what is expected, the same way the path probes poll for lookups.
wait_for_json() {
  local path="$1"
  local filter="$2"
  local message="$3"
  local timeout_seconds="${4:-20}"
  local started_at
  started_at=$(date +%s)

  while true; do
    if jq -e "$filter" "$path" >/dev/null 2>&1; then
      return 0
    fi
    if [ $(( $(date +%s) - started_at )) -ge "$timeout_seconds" ]; then
      break
    fi
    sleep 0.1
  done

  local actual
  actual=$(head -c 400 "$path" 2>/dev/null || true)
  error "$message. Last content of $(basename "$path"): $actual"
}

fuse_encode_component() {
  local value="$1"
  value="${value//%/%25}"
  value="${value//:/%3A}"
  value="${value//\//%2F}"
  if [[ "$value" == .* ]]; then
    value="%2E${value:1}"
  fi
  printf '%s\n' "$value"
}

resolve_entity_dir() {
  local entities_dir="$1"
  local entity_id="$2"
  local timeout_seconds="${3:-20}"
  local started_at
  started_at=$(date +%s)
  local bare_id="${entity_id#of:}"
  local canonical_entity_dir="$entities_dir/of:$bare_id"
  local bare_entity_dir="$entities_dir/$bare_id"
  local encoded_entity_dir="$entities_dir/$(fuse_encode_component "$entity_id")"
  local encoded_canonical_entity_dir="$entities_dir/$(fuse_encode_component "of:$bare_id")"
  local encoded_bare_entity_dir="$entities_dir/$(fuse_encode_component "$bare_id")"

  while true; do
    if path_exists "$encoded_entity_dir" 1; then
      printf '%s\n' "$encoded_entity_dir"
      return 0
    fi

    if path_exists "$encoded_canonical_entity_dir" 1; then
      printf '%s\n' "$encoded_canonical_entity_dir"
      return 0
    fi

    if path_exists "$encoded_bare_entity_dir" 1; then
      printf '%s\n' "$encoded_bare_entity_dir"
      return 0
    fi

    if path_exists "$canonical_entity_dir" 1; then
      printf '%s\n' "$canonical_entity_dir"
      return 0
    fi

    if path_exists "$bare_entity_dir" 1; then
      printf '%s\n' "$bare_entity_dir"
      return 0
    fi

    if [ $(( $(date +%s) - started_at )) -ge "$timeout_seconds" ]; then
      break
    fi
    sleep 0.1
  done

  return 1
}

wait_for_piece_value() {
  local path="$1"
  local expected="$2"
  local timeout_seconds="${3:-5}"
  local attempts=$((timeout_seconds * 10))

  for _ in $(seq 1 "$attempts"); do
    local actual
    actual=$(cf piece get $SPACE_ARGS --piece "$PIECE_ID" "$path" 2>/dev/null || true)
    if [ "$actual" = "$expected" ]; then
      return 0
    fi
    sleep 0.1
  done

  local actual
  actual=$(cf piece get $SPACE_ARGS --piece "$PIECE_ID" "$path" 2>/dev/null || true)
  error "Timed out waiting for piece path '$path'. Expected: $expected, got: $actual"
}

piece_pattern_identity() {
  cf piece inspect --json $SPACE_ARGS --piece "$PIECE_ID" 2>/dev/null |
    jq -r '.patternRef.identity // empty'
}

wait_for_pattern_identity_change() {
  local previous_identity="$1"
  local timeout_seconds="${2:-10}"
  local attempts=$((timeout_seconds * 10))

  for _ in $(seq 1 "$attempts"); do
    local actual
    actual=$(piece_pattern_identity || true)
    if [ -n "$actual" ] && [ "$actual" != "$previous_identity" ]; then
      printf '%s\n' "$actual"
      return 0
    fi
    sleep 0.1
  done

  error "Timed out waiting for the FUSE source update to change pattern identity."
}

# The daemon writes its `[write-trace]` lines to the log named in the mount
# output. The lines are emitted from the FUSE callbacks themselves, in the
# order the single-threaded session loop runs them, so the log records what the
# daemon decided rather than what the decision eventually did to a cell.
trace_line_count() {
  if [ ! -f "$DAEMON_LOG" ]; then
    printf '0\n'
    return 0
  fi
  wc -l <"$DAEMON_LOG" | tr -d ' '
}

trace_since() {
  local mark="$1"
  tail -n "+$((mark + 1))" "$DAEMON_LOG" 2>/dev/null || true
}

trace_contains() {
  local mark="$1"
  local needle="$2"
  local trace
  trace=$(trace_since "$mark")

  [[ "$trace" == *"$needle"* ]]
}

# Match a whole trace line, so `fh=3` cannot satisfy a search for `fh=33`.
trace_contains_line() {
  local mark="$1"
  local line="$2"
  local trace
  trace=$(trace_since "$mark")

  [[ $'\n'"$trace"$'\n' == *$'\n'"$line"$'\n'* ]]
}

wait_for_trace_line() {
  local mark="$1"
  local needle="$2"
  local timeout_seconds="${3:-20}"
  local started_at
  started_at=$(date +%s)

  while true; do
    if trace_contains "$mark" "$needle"; then
      return 0
    fi
    if [ $(( $(date +%s) - started_at )) -ge "$timeout_seconds" ]; then
      break
    fi
    sleep 0.1
  done

  error "Timed out waiting for daemon trace line: $needle"
}

assert_trace_line_absent() {
  local mark="$1"
  local line="$2"
  local message="$3"

  if trace_contains_line "$mark" "$line"; then
    error "$message"
  fi
}

# Print the daemon's release trace line for a handle. `releaseCb` traces the
# handle's dirty/flushing/pending state as it found it, before making its own
# flush decision, so the line states what close() saw regardless of which
# callback ends up doing the flushing.
trace_release_line() {
  local mark="$1"
  local fh="$2"

  trace_since "$mark" |
    sed -n "s/^\(\[write-trace\] release fh=$fh .*\)$/\1/p" |
    tail -n 1
}

# Report the handle number the daemon assigned to the descriptor that wrote
# `size` bytes at offset 0 since `mark`. The write callback traces its line
# before replying, so the line is in the log once the write() has returned.
resolve_traced_write_fh() {
  local mark="$1"
  local size="$2"
  local timeout_seconds="${3:-20}"
  local started_at
  started_at=$(date +%s)
  local fh

  while true; do
    fh=$(trace_since "$mark" |
      sed -n "s/^\[write-trace\] write fh=\([0-9][0-9]*\) size=$size offset=0$/\1/p" |
      tail -n 1)
    if [ -n "$fh" ]; then
      printf '%s\n' "$fh"
      return 0
    fi
    if [ $(( $(date +%s) - started_at )) -ge "$timeout_seconds" ]; then
      break
    fi
    sleep 0.1
  done

  return 1
}

read_piece_value_or_default() {
  local path="$1"
  local fallback="$2"
  local actual

  actual=$(cf piece get $SPACE_ARGS --piece "$PIECE_ID" "$path" 2>/dev/null || true)
  if [ -z "$actual" ]; then
    printf '%s\n' "$fallback"
    return 0
  fi

  if [[ ! "$actual" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$fallback"
    return 0
  fi

  printf '%s\n' "$actual"
}

mount_is_active() {
  local path="$1"
  local canonical

  canonical=$(cd -P -- "$path" >/dev/null 2>&1 && pwd) || return 1
  mount | grep -Fq " on $canonical "
}

cleanup() {
  set +e
  local can_remove_mountpoint=true
  if [ -n "${MOUNTPOINT:-}" ] && [ -d "${MOUNTPOINT:-}" ]; then
    cf fuse unmount "$MOUNTPOINT" >/dev/null 2>&1
    if mount_is_active "$MOUNTPOINT"; then
      >&2 echo "WARN: leaving mounted filesystem at $MOUNTPOINT because unmount failed"
      can_remove_mountpoint=false
    fi
  fi
  if [ "$can_remove_mountpoint" = true ] && [ -n "${MOUNTPOINT:-}" ]; then
    rm -rf "$MOUNTPOINT"
  fi
  if [ -n "${IDENTITY:-}" ]; then
    rm -f "$IDENTITY"
  fi
  if [ -n "${NO_ARG_HANDLER_ERR:-}" ]; then
    rm -f "$NO_ARG_HANDLER_ERR"
  fi
  if [ -n "${INCOMPATIBLE_PATTERN_SRC:-}" ]; then
    rm -f "$INCOMPATIBLE_PATTERN_SRC"
  fi
}

trap cleanup EXIT

if ! command -v jq >/dev/null 2>&1; then
  error "jq must be installed."
fi

if [ -z "${API_URL:-}" ]; then
  error "API_URL must be defined."
fi

SPACE=$(mktemp -u XXXXXXXXXX)
IDENTITY=$(mktemp)
MOUNTPOINT=$(mktemp -d)
SPACE_ARGS="--api-url=$API_URL --identity=$IDENTITY --space=$SPACE"
PATTERN_SRC="$SCRIPT_DIR/pattern/fuse-exec.tsx"
CUSTOM_EXPORT="customPatternExport"

echo "API_URL=$API_URL"
echo "SPACE=$SPACE"
echo "IDENTITY=$IDENTITY"
echo "MOUNTPOINT=$MOUNTPOINT"

cf id new >"$IDENTITY"

PIECE_ID=$(cf piece new --main-export "$CUSTOM_EXPORT" $SPACE_ARGS "$PATTERN_SRC")
echo "Created piece: $PIECE_ID"
cf piece step $SPACE_ARGS --piece "$PIECE_ID"
echo "Stepped piece: $PIECE_ID"
MOUNT_OUTPUT=$(cf fuse mount "$MOUNTPOINT" --api-url="$API_URL" --identity="$IDENTITY" --space="$SPACE" --background --dangerously-allow-incompatible-schema)
echo "$MOUNT_OUTPUT"

MOUNT_PID="${MOUNT_OUTPUT#*PID }"
if [ "$MOUNT_PID" = "$MOUNT_OUTPUT" ]; then
  error "Could not parse fuse daemon PID from mount output."
fi

MOUNT_PID="${MOUNT_PID%%)*}"
case "$MOUNT_PID" in
  ''|*[!0-9]*)
    error "Could not parse fuse daemon PID from mount output."
    ;;
esac

DAEMON_LOG=$(printf '%s\n' "$MOUNT_OUTPUT" | sed -n 's/^[[:space:]]*log:[[:space:]]*//p')
if [ -z "$DAEMON_LOG" ]; then
  error "Could not parse fuse daemon log path from mount output."
fi

# 'cf fuse mount --background' returns only after the daemon has reported the
# 'mounted' supervisor state and been confirmed alive. The daemon reports that
# just before it enters its FUSE session loop, and mounted paths hydrate lazily,
# so the wait_for_path calls below cover the rest.
if ! kill -0 "$MOUNT_PID" >/dev/null 2>&1; then
  error "Fuse daemon exited immediately after reporting mount readiness."
fi

wait_for_path "$MOUNTPOINT/$SPACE/pieces"

PIECE_NAME="Fuse-Exec-Fixture"
PIECE_DIR="$MOUNTPOINT/$SPACE/pieces/$PIECE_NAME"
INPUT_DIR="$PIECE_DIR/input"
INPUT_LAST_MESSAGE="$INPUT_DIR/lastMessage"
RESULT_DIR="$PIECE_DIR/result"
RESULT_JSON="$PIECE_DIR/result.json"
META_JSON="$PIECE_DIR/meta.json"
wait_for_path "$PIECE_DIR"
wait_for_path "$RESULT_DIR"
wait_for_path "$RESULT_JSON"
wait_for_path "$META_JSON"

ENTITY_ID=$(jq -r '.entityId' "$META_JSON")
if [ -z "$ENTITY_ID" ] || [ "$ENTITY_ID" = "null" ]; then
  error "Mounted meta.json did not include an entityId."
fi

ENTITY_BARE_ID="${ENTITY_ID#of:}"
ENTITY_DEEP_PROBE="${FUSE_DEEP_ENTITY_PROBE:-0}"
ENTITIES_DIR="$MOUNTPOINT/$SPACE/entities"
wait_for_path "$ENTITIES_DIR"
ENTITY_DIR=$(resolve_entity_dir "$ENTITIES_DIR" "$ENTITY_ID" 20 || true)
if [ -z "$ENTITY_DIR" ]; then
  error "Timed out waiting for entity directory entry for $ENTITY_ID."
fi

HANDLER_FILE="$RESULT_DIR/recordMessage.handler"
LEGACY_HANDLER_FILE="$RESULT_DIR/legacyWrite.handler"
TOOL_FILE="$RESULT_DIR/search.tool"

wait_for_path "$HANDLER_FILE"
wait_for_path "$LEGACY_HANDLER_FILE"
wait_for_path "$TOOL_FILE"

path_exists "$HANDLER_FILE" || error "recordMessage.handler was not mounted."
path_exists "$LEGACY_HANDLER_FILE" || error "legacyWrite.handler was not mounted."
path_exists "$TOOL_FILE" || error "search.tool was not mounted."
success "Mounted callable entries exist"
success "Entities namespace exposes matching entry for mounted piece"

assert_not_exists "$RESULT_DIR/search" "Pattern tool internals should not be exposed as a directory."
wait_for_json "$RESULT_JSON" '.recordMessage == {"/handler":"recordMessage"}' \
  "result.json should render recordMessage as a handler sigil"
wait_for_json "$RESULT_JSON" '.legacyWrite == {"/handler":"legacyWrite"}' \
  "result.json should render legacyWrite as a handler sigil"
wait_for_json "$RESULT_JSON" '.search == {"/tool":"search"}' \
  "result.json should render search as a tool sigil"
success "Mounted JSON surface hides callable internals"

HANDLER_FIRST_LINE=$(head -n 1 "$HANDLER_FILE")
TOOL_FIRST_LINE=$(head -n 1 "$TOOL_FILE")
test -x "$HANDLER_FILE" || error "Handler file should be executable."
test -x "$TOOL_FILE" || error "Tool file should be executable."
assert_contains "$HANDLER_FIRST_LINE" "#!" "Handler file should start with a shebang."
assert_contains "$HANDLER_FIRST_LINE" " exec" "Handler shebang should invoke cf exec."
assert_contains "$TOOL_FIRST_LINE" "#!" "Tool file should start with a shebang."
assert_contains "$TOOL_FIRST_LINE" " exec" "Tool shebang should invoke cf exec."
success "Callable files are executable and expose cf exec shebangs"

COUNT_BEFORE_HELP=$(read_piece_value_or_default "messageCount" "0")
HANDLER_HELP=$(cf exec "$HANDLER_FILE" --help)
TOOL_HELP=$(cf exec "$TOOL_FILE" --help)
TOOL_HELP_JSON=$(cf exec "$TOOL_FILE" --help --json)
DIRECT_HANDLER_HELP=$("$HANDLER_FILE" --help)
assert_contains "$HANDLER_HELP" "cf exec" "cf exec help should describe the cf exec call form."
assert_contains "$HANDLER_HELP" "[invoke] --message <string>" "Handler help should show the optional invoke verb."
assert_contains "$HANDLER_HELP" "--message <string>" "Handler help should expand schema-derived flags."
assert_contains "$HANDLER_HELP" "Required." "Handler help should mark required flags."
assert_contains "$HANDLER_HELP" "No output on success." "Handler help should describe handler output."
assert_contains "$HANDLER_HELP" "Alternatively, write JSON to this file to invoke the handler." "Handler help should mention write-through invocation."
assert_contains "$TOOL_HELP" "[run] --query <string>" "Tool help should show the optional run verb."
assert_contains "$TOOL_HELP" "--query <string>" "Tool help should expand schema-derived flags."
assert_contains "$TOOL_HELP" "JSON on success:" "Tool help should show JSON output."
assert_contains "$TOOL_HELP" "--help --json" "Tool help should mention machine-readable schema help."
assert_contains "$DIRECT_HANDLER_HELP" "[invoke] --message <string>" "Direct help should show the optional invoke verb."
assert_contains "$DIRECT_HANDLER_HELP" "$HANDLER_FILE" "Direct help should mention the mounted file path."
assert_contains "$DIRECT_HANDLER_HELP" "--message <string>" "Direct help should show the mounted file call form."
if [[ "$DIRECT_HANDLER_HELP" == *"cf exec $HANDLER_FILE"* ]]; then
  error "Direct help should hide the cf exec call form."
fi
printf '%s\n' "$TOOL_HELP_JSON" | jq -e '.inputSchema.required == ["query"]' >/dev/null ||
  error "Machine-readable help should include the input schema."
printf '%s\n' "$TOOL_HELP_JSON" | jq -e '.outputSchema.properties.summary.type == "string"' >/dev/null ||
  error "Machine-readable help should include the output schema."
COUNT_AFTER_HELP=$(read_piece_value_or_default "messageCount" "0")
if [ "$COUNT_AFTER_HELP" != "$COUNT_BEFORE_HELP" ]; then
  error "Top-level cf exec --help should not mutate messageCount. Expected: $COUNT_BEFORE_HELP, got: $COUNT_AFTER_HELP"
fi
success "Top-level and direct --help print agent-oriented callable help without invoking callables"

"$HANDLER_FILE" --message "piece-direct"
wait_for_piece_value "lastMessage" '"piece-direct"'
wait_for_piece_value "messageCount" "1"
DIRECT_TOOL=$("$TOOL_FILE" --query "direct" --help "via-shebang")
assert_json_eq \
  "$DIRECT_TOOL" \
  '{"help":"via-shebang","query":"direct","source":"bound-source","summary":"bound-source:direct:via-shebang"}' \
  "Direct tool execution returned unexpected JSON"
success "Mounted callables can be executed directly through their shebangs"

printf '{"message":"stdin-handler"}' | cf exec "$HANDLER_FILE" --json
wait_for_piece_value "lastMessage" '"stdin-handler"'
wait_for_piece_value "messageCount" "2"
success "cf exec reads handler JSON input from stdin"

DIRECT_TOOL_STDIN=$(printf '{"query":"stdin-tool","help":"stdin-help"}' | "$TOOL_FILE" --json)
assert_json_eq \
  "$DIRECT_TOOL_STDIN" \
  '{"help":"stdin-help","query":"stdin-tool","source":"bound-source","summary":"bound-source:stdin-tool:stdin-help"}' \
  "Direct tool execution with stdin JSON returned unexpected JSON"
success "Mounted tools read JSON input from stdin"

cf exec "$HANDLER_FILE" --message "piece-explicit"
wait_for_piece_value "lastMessage" '"piece-explicit"'
wait_for_piece_value "messageCount" "3"
success "cf exec invokes mounted handlers with schema-derived flags"

cf exec "$HANDLER_FILE" --message "piece-implicit"
wait_for_piece_value "lastMessage" '"piece-implicit"'
wait_for_piece_value "messageCount" "4"
success "cf exec invokes mounted handlers without an explicit verb"

TOOL_EXPLICIT=$(cf exec "$TOOL_FILE" --query "explicit" --help "schema-field")
assert_json_eq \
  "$TOOL_EXPLICIT" \
  '{"help":"schema-field","query":"explicit","source":"bound-source","summary":"bound-source:explicit:schema-field"}' \
  "Explicit tool execution returned unexpected JSON"
success "cf exec runs mounted tools with schema-derived flags"

HELP_FIELD_OUTPUT=$(cf exec "$TOOL_FILE" --help "literal-help" --query "help-field")
assert_json_eq \
  "$HELP_FIELD_OUTPUT" \
  '{"help":"literal-help","query":"help-field","source":"bound-source","summary":"bound-source:help-field:literal-help"}' \
  "Top-level --help with a value should be parsed as the tool schema field"
success "Top-level --help with a value is parsed as the schema field when present"

TOOL_IMPLICIT=$(cf exec "$TOOL_FILE" --query "implicit" --help "")
assert_json_eq \
  "$TOOL_IMPLICIT" \
  '{"help":"","query":"implicit","source":"bound-source","summary":"bound-source:implicit:"}' \
  "Implicit tool execution returned unexpected JSON"
success "cf exec runs mounted tools without an explicit verb"

LEGACY_COUNT_BEFORE_EXEC=$(read_piece_value_or_default "legacyCount" "0")
cf exec "$LEGACY_HANDLER_FILE"
wait_for_piece_value "legacyCount" "$((LEGACY_COUNT_BEFORE_EXEC + 1))"
cf exec "$LEGACY_HANDLER_FILE" invoke
wait_for_piece_value "legacyCount" "$((LEGACY_COUNT_BEFORE_EXEC + 2))"
success "Empty-object handlers run without an explicit verb, and invoke still works"

COUNT_BEFORE_PIECES_SHARED=$(read_piece_value_or_default "messageCount" "0")
cf exec "$HANDLER_FILE" --message "shared-message"
wait_for_piece_value "lastMessage" '"shared-message"'
wait_for_piece_value "messageCount" "$((COUNT_BEFORE_PIECES_SHARED + 1))"

if [ "$ENTITY_DEEP_PROBE" = "1" ]; then
  ENTITY_RESULT_DIR="$ENTITY_DIR/result"
  ENTITY_HANDLER_FILE="$ENTITY_RESULT_DIR/recordMessage.handler"
  ENTITY_TOOL_FILE="$ENTITY_RESULT_DIR/search.tool"

  wait_for_path "$ENTITY_HANDLER_FILE"
  wait_for_path "$ENTITY_TOOL_FILE"

  COUNT_BEFORE_ENTITIES_SHARED=$(read_piece_value_or_default "messageCount" "0")
  cf exec "$ENTITY_HANDLER_FILE" --message "shared-message"
  wait_for_piece_value "lastMessage" '"shared-message"'
  wait_for_piece_value "messageCount" "$((COUNT_BEFORE_ENTITIES_SHARED + 1))"
  success "Handler execution through pieces/ and entities/ reaches the same backing cell"

  PIECES_TOOL_SHARED=$(cf exec "$TOOL_FILE" --query "shared-tool" --help "entity-compare")
  ENTITIES_TOOL_SHARED=$(cf exec "$ENTITY_TOOL_FILE" --query "shared-tool" --help "entity-compare")
  assert_json_eq \
    "$PIECES_TOOL_SHARED" \
    "$ENTITIES_TOOL_SHARED" \
    "Tool output should match between pieces/ and entities/ paths"
  success "Tool execution through pieces/ and entities/ is identical"
else
  success "Deep entities callable probe skipped"
fi

LEGACY_COUNT_BEFORE=$(read_piece_value_or_default "legacyCount" "0")
echo '{}' > "$LEGACY_HANDLER_FILE"
wait_for_piece_value "legacyCount" "$((LEGACY_COUNT_BEFORE + 1))"
success "Legacy handler write-through still works"

wait_for_path "$INPUT_LAST_MESSAGE"

# `handles.write` overlays the buffer the open seeded from the file, so the
# stale value is this content over whatever tail of the old value outlives it.
# The assertions below read the daemon's trace and do not depend on which.
STALE_CONTENT="open-stale-descriptor"
STALE_TRACE_MARK=$(trace_line_count)

# Write and truncate under one sustained redirect of fd 9. On Linux the kernel
# sends FUSE flush on every close(), and `printf >&9` closes a dup of fd 9 when
# the redirect ends — which would flush the descriptor's buffered write before
# the truncate ever runs, defeating the point of the test. Redirecting the whole
# group keeps fd 9's buffered write on the handle until the group ends, so every
# flush of it happens after the truncate has disarmed it.
exec 9<> "$INPUT_LAST_MESSAGE"
{
  printf '%s' "$STALE_CONTENT"
  : > "$INPUT_LAST_MESSAGE"
} >&9
exec 9>&-

# The write above leaves fd 9's handle holding the stale content and marked
# dirty. The truncate empties the buffer of every descriptor open on this inode
# and clears `dirty` on all of them, and leaves `truncatePending` set only on
# the truncating handle. `dirty || truncatePending` is what `flushHandle`,
# `flushCb` and `releaseCb` gate on, so clearing both is what makes fd 9's
# handle inert.
#
# `releaseCb` traces the handle's state before deciding anything, so its line
# reports whether close() found the descriptor armed, on either truncate path
# and whichever callback does the flushing. The cell value cannot report that;
# `docs/development/waiting-in-tests.md` records why.
STALE_FH=$(resolve_traced_write_fh "$STALE_TRACE_MARK" "${#STALE_CONTENT}") ||
  error "Could not resolve the handle the daemon assigned to fd 9."

wait_for_trace_line "$STALE_TRACE_MARK" "[write-trace] release fh=$STALE_FH "
STALE_RELEASE_LINE=$(trace_release_line "$STALE_TRACE_MARK" "$STALE_FH")

if [[ "$STALE_RELEASE_LINE" != *" pending="* ]] ||
  [[ "$STALE_RELEASE_LINE" != *" flushing="* ]]; then
  error "Daemon release trace no longer reports flushing/pending: $STALE_RELEASE_LINE"
fi

# `pending` is `dirty || truncatePending`, the pair every flush path gates on.
if [[ "$STALE_RELEASE_LINE" != *" pending=false"* ]]; then
  error "Truncate left the open descriptor armed at close(). Daemon traced: $STALE_RELEASE_LINE"
fi

# A flush already in flight carries the buffer it copied when it started, which
# the truncate cannot recall.
if [[ "$STALE_RELEASE_LINE" != *" flushing=false"* ]]; then
  error "A flush was already in flight for the descriptor at close(). Daemon traced: $STALE_RELEASE_LINE"
fi

# The release line alone would miss a descriptor whose flush had already
# finished by the time release arrived, which clears the same fields the disarm
# does. `flushCb` traces `flush-fire` only for a handle that got past the gate,
# so its absence rules that out. close() sends flush before release and the
# daemon runs its callbacks on one thread, so a traced release means the flush
# decision is already traced too.
assert_trace_line_absent "$STALE_TRACE_MARK" \
  "[write-trace] flush-fire fh=$STALE_FH" \
  "Truncate left the open descriptor armed: the daemon flushed fh=$STALE_FH on close()"
success "Path truncate disarms an already-open descriptor's buffered write"

wait_for_piece_value "lastMessage" '""'
success "Path truncate clears stale open write handles"

FUSE_PATTERN_SRC="$PIECE_DIR/.src/fuse-exec.tsx"
wait_for_path "$FUSE_PATTERN_SRC"
PATTERN_IDENTITY_BEFORE_SOURCE_WRITE=$(piece_pattern_identity)
if [ -z "$PATTERN_IDENTITY_BEFORE_SOURCE_WRITE" ]; then
  error "Could not read the piece pattern identity before the FUSE source update."
fi

INCOMPATIBLE_PATTERN_SRC=$(mktemp)
awk '
  /^interface Output \{/ { in_output = 1 }
  in_output && /^  lastMessage: string;$/ {
    print "  lastMessage: string | number;"
    in_output = 0
    next
  }
  { print }
' "$PATTERN_SRC" >"$INCOMPATIBLE_PATTERN_SRC"
if ! grep -q '^  lastMessage: string | number;$' "$INCOMPATIBLE_PATTERN_SRC"; then
  error "Failed to build the incompatible FUSE source update fixture."
fi

tee "$FUSE_PATTERN_SRC" <"$INCOMPATIBLE_PATTERN_SRC" >/dev/null
PATTERN_IDENTITY_AFTER_SOURCE_WRITE=$(
  wait_for_pattern_identity_change "$PATTERN_IDENTITY_BEFORE_SOURCE_WRITE"
)
if [ "$PATTERN_IDENTITY_AFTER_SOURCE_WRITE" = "$PATTERN_IDENTITY_BEFORE_SOURCE_WRITE" ]; then
  error "Dangerously authorized FUSE source write did not update the piece."
fi
wait_for_piece_value "lastMessage" '""'
success "FUSE source writes can explicitly authorize an incompatible schema update"

echo "FUSE exec integration passed."
