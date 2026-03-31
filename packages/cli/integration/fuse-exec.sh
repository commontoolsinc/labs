#!/usr/bin/env bash
set -euo pipefail

export LOG_TO_STDERR=1

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)

error() {
  >&2 echo "ERROR: $1"
  exit 1
}

success() {
  echo "✓ $1"
}

if [ -n "${CT_CLI_INTEGRATION_USE_LOCAL:-}" ]; then
  ct() {
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

  if command -v timeout >/dev/null 2>&1; then
    timeout --signal=KILL 1 test -e "$path" >/dev/null 2>&1
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
  local attempts=$((timeout_seconds * 10))

  for _ in $(seq 1 "$attempts"); do
    if path_exists "$path"; then
      return 0
    fi
    sleep 0.1
  done

  error "Timed out waiting for path: $path"
}

resolve_entity_dir() {
  local entities_dir="$1"
  local bare_id="$2"
  local timeout_seconds="${3:-20}"
  local attempts=$((timeout_seconds * 10))
  local canonical_entity_dir="$entities_dir/of:$bare_id"
  local bare_entity_dir="$entities_dir/$bare_id"

  for _ in $(seq 1 "$attempts"); do
    if path_exists "$canonical_entity_dir"; then
      printf '%s\n' "$canonical_entity_dir"
      return 0
    fi

    if path_exists "$bare_entity_dir"; then
      printf '%s\n' "$bare_entity_dir"
      return 0
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
    actual=$(ct piece get $SPACE_ARGS --piece "$PIECE_ID" "$path" 2>/dev/null || true)
    if [ "$actual" = "$expected" ]; then
      return 0
    fi
    sleep 0.1
  done

  local actual
  actual=$(ct piece get $SPACE_ARGS --piece "$PIECE_ID" "$path" 2>/dev/null || true)
  error "Timed out waiting for piece path '$path'. Expected: $expected, got: $actual"
}

read_piece_value_or_default() {
  local path="$1"
  local fallback="$2"
  local actual

  actual=$(ct piece get $SPACE_ARGS --piece "$PIECE_ID" "$path" 2>/dev/null || true)
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
    ct fuse unmount "$MOUNTPOINT" >/dev/null 2>&1
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

ct id new >"$IDENTITY"

PIECE_ID=$(ct piece new --main-export "$CUSTOM_EXPORT" $SPACE_ARGS "$PATTERN_SRC")
echo "Created piece: $PIECE_ID"
MOUNT_OUTPUT=$(ct fuse mount "$MOUNTPOINT" --api-url="$API_URL" --identity="$IDENTITY" --background)
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

for _ in $(seq 1 30); do
  if ! kill -0 "$MOUNT_PID" >/dev/null 2>&1; then
    error "Fuse daemon exited before mount became ready."
  fi
  sleep 0.1
done

sleep 1

wait_for_path "$MOUNTPOINT/$SPACE/pieces"

PIECE_NAME="Fuse Exec Fixture"
PIECE_DIR="$MOUNTPOINT/$SPACE/pieces/$PIECE_NAME"
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
ENTITY_DIR=$(resolve_entity_dir "$ENTITIES_DIR" "$ENTITY_BARE_ID" 20 || true)
if [ -z "$ENTITY_DIR" ]; then
  error "Timed out waiting for entity directory entry for $ENTITY_BARE_ID."
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
jq -e '.recordMessage == {"/handler":"recordMessage"}' "$RESULT_JSON" >/dev/null ||
  error "result.json should render recordMessage as a handler sigil."
jq -e '.legacyWrite == {"/handler":"legacyWrite"}' "$RESULT_JSON" >/dev/null ||
  error "result.json should render legacyWrite as a handler sigil."
jq -e '.search == {"/tool":"search"}' "$RESULT_JSON" >/dev/null ||
  error "result.json should render search as a tool sigil."
success "Mounted JSON surface hides callable internals"

HANDLER_FIRST_LINE=$(head -n 1 "$HANDLER_FILE")
TOOL_FIRST_LINE=$(head -n 1 "$TOOL_FILE")
test -x "$HANDLER_FILE" || error "Handler file should be executable."
test -x "$TOOL_FILE" || error "Tool file should be executable."
assert_contains "$HANDLER_FIRST_LINE" "#!" "Handler file should start with a shebang."
assert_contains "$HANDLER_FIRST_LINE" " exec" "Handler shebang should invoke ct exec."
assert_contains "$TOOL_FIRST_LINE" "#!" "Tool file should start with a shebang."
assert_contains "$TOOL_FIRST_LINE" " exec" "Tool shebang should invoke ct exec."
success "Callable files are executable and expose ct exec shebangs"

COUNT_BEFORE_HELP=$(read_piece_value_or_default "messageCount" "0")
HANDLER_HELP=$(ct exec "$HANDLER_FILE" --help)
TOOL_HELP=$(ct exec "$TOOL_FILE" --help)
TOOL_HELP_JSON=$(ct exec "$TOOL_FILE" --help --json)
DIRECT_HANDLER_HELP=$("$HANDLER_FILE" --help)
assert_contains "$HANDLER_HELP" "ct exec" "ct exec help should describe the ct exec call form."
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
if [[ "$DIRECT_HANDLER_HELP" == *"ct exec $HANDLER_FILE"* ]]; then
  error "Direct help should hide the ct exec call form."
fi
printf '%s\n' "$TOOL_HELP_JSON" | jq -e '.inputSchema.required == ["query"]' >/dev/null ||
  error "Machine-readable help should include the input schema."
printf '%s\n' "$TOOL_HELP_JSON" | jq -e '.outputSchema.properties.summary.type == "string"' >/dev/null ||
  error "Machine-readable help should include the output schema."
COUNT_AFTER_HELP=$(read_piece_value_or_default "messageCount" "0")
if [ "$COUNT_AFTER_HELP" != "$COUNT_BEFORE_HELP" ]; then
  error "Top-level ct exec --help should not mutate messageCount. Expected: $COUNT_BEFORE_HELP, got: $COUNT_AFTER_HELP"
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

printf '{"message":"stdin-handler"}' | ct exec "$HANDLER_FILE" --json
wait_for_piece_value "lastMessage" '"stdin-handler"'
wait_for_piece_value "messageCount" "2"
success "ct exec reads handler JSON input from stdin"

DIRECT_TOOL_STDIN=$(printf '{"query":"stdin-tool","help":"stdin-help"}' | "$TOOL_FILE" --json)
assert_json_eq \
  "$DIRECT_TOOL_STDIN" \
  '{"help":"stdin-help","query":"stdin-tool","source":"bound-source","summary":"bound-source:stdin-tool:stdin-help"}' \
  "Direct tool execution with stdin JSON returned unexpected JSON"
success "Mounted tools read JSON input from stdin"

ct exec "$HANDLER_FILE" --message "piece-explicit"
wait_for_piece_value "lastMessage" '"piece-explicit"'
wait_for_piece_value "messageCount" "3"
success "ct exec invokes mounted handlers with schema-derived flags"

ct exec "$HANDLER_FILE" --message "piece-implicit"
wait_for_piece_value "lastMessage" '"piece-implicit"'
wait_for_piece_value "messageCount" "4"
success "ct exec invokes mounted handlers without an explicit verb"

TOOL_EXPLICIT=$(ct exec "$TOOL_FILE" --query "explicit" --help "schema-field")
assert_json_eq \
  "$TOOL_EXPLICIT" \
  '{"help":"schema-field","query":"explicit","source":"bound-source","summary":"bound-source:explicit:schema-field"}' \
  "Explicit tool execution returned unexpected JSON"
success "ct exec runs mounted tools with schema-derived flags"

HELP_FIELD_OUTPUT=$(ct exec "$TOOL_FILE" --help "literal-help" --query "help-field")
assert_json_eq \
  "$HELP_FIELD_OUTPUT" \
  '{"help":"literal-help","query":"help-field","source":"bound-source","summary":"bound-source:help-field:literal-help"}' \
  "Top-level --help with a value should be parsed as the tool schema field"
success "Top-level --help with a value is parsed as the schema field when present"

TOOL_IMPLICIT=$(ct exec "$TOOL_FILE" --query "implicit" --help "")
assert_json_eq \
  "$TOOL_IMPLICIT" \
  '{"help":"","query":"implicit","source":"bound-source","summary":"bound-source:implicit:"}' \
  "Implicit tool execution returned unexpected JSON"
success "ct exec runs mounted tools without an explicit verb"

LEGACY_COUNT_BEFORE_EXEC=$(read_piece_value_or_default "legacyCount" "0")
ct exec "$LEGACY_HANDLER_FILE"
wait_for_piece_value "legacyCount" "$((LEGACY_COUNT_BEFORE_EXEC + 1))"
ct exec "$LEGACY_HANDLER_FILE" invoke
wait_for_piece_value "legacyCount" "$((LEGACY_COUNT_BEFORE_EXEC + 2))"
success "Empty-object handlers run without an explicit verb, and invoke still works"

COUNT_BEFORE_PIECES_SHARED=$(read_piece_value_or_default "messageCount" "0")
ct exec "$HANDLER_FILE" --message "shared-message"
wait_for_piece_value "lastMessage" '"shared-message"'
wait_for_piece_value "messageCount" "$((COUNT_BEFORE_PIECES_SHARED + 1))"

if [ "$ENTITY_DEEP_PROBE" = "1" ]; then
  ENTITY_RESULT_DIR="$ENTITY_DIR/result"
  ENTITY_HANDLER_FILE="$ENTITY_RESULT_DIR/recordMessage.handler"
  ENTITY_TOOL_FILE="$ENTITY_RESULT_DIR/search.tool"

  wait_for_path "$ENTITY_HANDLER_FILE"
  wait_for_path "$ENTITY_TOOL_FILE"

  COUNT_BEFORE_ENTITIES_SHARED=$(read_piece_value_or_default "messageCount" "0")
  ct exec "$ENTITY_HANDLER_FILE" --message "shared-message"
  wait_for_piece_value "lastMessage" '"shared-message"'
  wait_for_piece_value "messageCount" "$((COUNT_BEFORE_ENTITIES_SHARED + 1))"
  success "Handler execution through pieces/ and entities/ reaches the same backing cell"

  PIECES_TOOL_SHARED=$(ct exec "$TOOL_FILE" --query "shared-tool" --help "entity-compare")
  ENTITIES_TOOL_SHARED=$(ct exec "$ENTITY_TOOL_FILE" --query "shared-tool" --help "entity-compare")
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

echo "FUSE exec integration passed."
