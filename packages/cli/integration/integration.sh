#!/usr/bin/env bash
set -e

# Redirect logs to stderr so they don't pollute stdout (used for machine-readable output)
export LOG_TO_STDERR=1
SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
error () {
  >&2 echo $1
  exit 1
}
assert_json_eq() {
  local actual="$1"
  local expected="$2"
  local message="$3"
  local expected_file
  local actual_file
  expected_file=$(mktemp)
  actual_file=$(mktemp)
  echo "$expected" | jq -S . > "$expected_file"
  echo "$actual" | jq -S . > "$actual_file"
  if ! diff -u "$expected_file" "$actual_file" > /dev/null; then
    error "$message"
  fi
}
replace () {
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i ' ' "$1" "$2"
  else
    sed -i "$1" "$2"
  fi
}

if [ -n "${CF_CLI_INTEGRATION_USE_LOCAL:-}" ]; then
 cf_impl() {
   deno task cli "$@"
 }
else
 cf_impl() {
   command cf "$@"
 }
fi

cf() {
  if [ -z "$CF_CLI_INTEGRATION_TIMINGS" ]; then
    cf_impl "$@"
    return $?
  fi

  local start_ms=$(python3 -c 'import time; print(int(time.time() * 1000))')
  cf_impl "$@"
  local status=$?
  local end_ms=$(python3 -c 'import time; print(int(time.time() * 1000))')
  local elapsed_ms=$((end_ms - start_ms))
  local timing_line="[cf-timing] ${elapsed_ms}ms :: cf $*"
  >&2 echo "$timing_line"
  if [ -n "${CF_CLI_INTEGRATION_TIMINGS_FILE:-}" ]; then
    printf '%s\n' "$timing_line" >> "$CF_CLI_INTEGRATION_TIMINGS_FILE"
  fi
  return $status
}

PATTERN_SRC="$SCRIPT_DIR/pattern/main.tsx"
SCHEMA_COMPATIBLE_PATTERN_SRC="$SCRIPT_DIR/pattern/schema-compatible.tsx"
SCHEMA_INCOMPATIBLE_PATTERN_SRC="$SCRIPT_DIR/pattern/schema-incompatible.tsx"
CUSTOM_EXPORT="customPatternExport" # for testing this feature
SECTION="${CF_CLI_INTEGRATION_SECTION:-${1:-all}}"

setup_space() {
  if [ -z "$API_URL" ]; then
    error "API_URL must be defined."
  fi

  SPACE=$(mktemp -u XXXXXXXXXX) # generates a random space
  IDENTITY=$(mktemp)
  SPACE_ARGS="--api-url=$API_URL --identity=$IDENTITY --space=$SPACE"
  WORK_DIR=$(mktemp -d)

  echo "API_URL=$API_URL"
  echo "SPACE=$SPACE"
  echo "IDENTITY=$IDENTITY"
  echo "WORK_DIR=$WORK_DIR"

  # Create a key
  cf id new > "$IDENTITY"

  # Check space is empty
  if [ "$(cf piece ls $SPACE_ARGS)" != "" ]; then
    error "Space not empty."
  fi
}

# Helper functions for testing
test_value() {
  local test_name="$1"
  local path="$2"
  local value="$3"
  local expected="$4"
  local flags="$5"

  echo "$value" | cf piece set $SPACE_ARGS --piece $PIECE_ID "$path" $flags
  local result=$(cf piece get $SPACE_ARGS --piece $PIECE_ID "$path" $flags)

  if [ "$result" != "$expected" ]; then
    error "$test_name failed. Expected: $expected, Got: $result"
  fi
}

read_piece_value_or_default() {
  local piece_id="$1"
  local path="$2"
  local fallback="$3"
  local actual

  actual=$(cf piece get $SPACE_ARGS --piece "$piece_id" "$path" 2>/dev/null || true)
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

test_json_value() {
  local test_name="$1"
  local path="$2"
  local value="$3"
  local flags="$4"

  echo "$value" | cf piece set $SPACE_ARGS --piece $PIECE_ID "$path" $flags
  local result=$(cf piece get $SPACE_ARGS --piece $PIECE_ID "$path" $flags)

  assert_json_eq "$result" "$value" "$test_name failed. Expected: $value, Got: $result"
}

test_get_only() {
  local test_name="$1"
  local path="$2"
  local expected="$3"
  local flags="$4"

  local result=$(cf piece get $SPACE_ARGS --piece $PIECE_ID "$path" $flags)

  if [ "$result" != "$expected" ]; then
    error "$test_name failed. Expected: $expected, Got: $result"
  fi
}

create_stepped_counter_piece() {
  local value="$1"

  PIECE_ID=$(cf piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS $PATTERN_SRC)
  echo "Created source piece: $PIECE_ID"

  printf '{"value":%s}\n' "$value" | cf piece apply $SPACE_ARGS --piece $PIECE_ID
  echo "$value" | cf piece set $SPACE_ARGS --piece $PIECE_ID value
  cf piece step $SPACE_ARGS --piece $PIECE_ID

  RESULT=$(cf piece get $SPACE_ARGS --piece $PIECE_ID value)
  if [ "$RESULT" != "$value" ]; then
    error "Source piece value should be $value before linking, got: $RESULT"
  fi
}

run_piece_values() {
  setup_space

  # Create a new piece using custom default export as input
  PIECE_ID=$(cf piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS $PATTERN_SRC)
  echo "Created piece: $PIECE_ID"

  echo "Fetching piece source to $WORK_DIR"
  # Retrieve the source code for $PIECE_ID to $WORK_DIR
  cf piece getsrc $SPACE_ARGS --piece $PIECE_ID $WORK_DIR

  # Check file was retrieved
  if [ ! -f "$WORK_DIR/main.tsx" ]; then
    error "Source code was not retrieved from $PIECE_ID"
  fi
  if [ ! -f "$WORK_DIR/utils.ts" ]; then
    error "Source code was not retrieved from $PIECE_ID"
  fi

  echo "Updating piece source."

  # Update the piece's source code
  replace 's/Simple counter:/Simple counter 2:/g' "$WORK_DIR/main.tsx"
  cf piece setsrc --main-export $CUSTOM_EXPORT $SPACE_ARGS --piece $PIECE_ID $WORK_DIR/main.tsx

  # (Again) Retrieve the source code for $PIECE_ID to $WORK_DIR
  rm "$WORK_DIR/main.tsx"
  cf piece getsrc $SPACE_ARGS --piece $PIECE_ID $WORK_DIR

  # Check file was retrieved with modifications
  if ! grep -q "Simple counter 2" "$WORK_DIR/main.tsx"; then
    error "Retrieved source code was not modified"
  fi

  echo "Testing explicitly authorized incompatible source updates."
  local schema_piece_id schema_identity_before schema_identity_after_rejection
  local schema_identity_after_override schema_value
  schema_piece_id=$(cf piece new --no-start $SPACE_ARGS "$SCHEMA_COMPATIBLE_PATTERN_SRC")
  echo '{"value":5}' | cf piece apply $SPACE_ARGS --piece "$schema_piece_id"
  cf piece step $SPACE_ARGS --piece "$schema_piece_id"
  schema_identity_before=$(
    cf piece inspect --json $SPACE_ARGS --piece "$schema_piece_id" |
      jq -r '.patternRef.identity'
  )

  if cf piece setsrc $SPACE_ARGS --piece "$schema_piece_id" \
    "$SCHEMA_INCOMPATIBLE_PATTERN_SRC" \
    >"$WORK_DIR/incompatible-setsrc.out" \
    2>"$WORK_DIR/incompatible-setsrc.err"; then
    error "Incompatible setsrc should fail without the dangerous override."
  fi
  if ! grep -q "not backward compatible" "$WORK_DIR/incompatible-setsrc.err"; then
    error "Incompatible setsrc failed for an unexpected reason."
  fi
  schema_identity_after_rejection=$(
    cf piece inspect --json $SPACE_ARGS --piece "$schema_piece_id" |
      jq -r '.patternRef.identity'
  )
  if [ "$schema_identity_after_rejection" != "$schema_identity_before" ]; then
    error "Rejected incompatible setsrc changed the piece source."
  fi

  cf piece setsrc --dangerously-allow-incompatible-schema $SPACE_ARGS \
    --piece "$schema_piece_id" "$SCHEMA_INCOMPATIBLE_PATTERN_SRC"
  schema_identity_after_override=$(
    cf piece inspect --json $SPACE_ARGS --piece "$schema_piece_id" |
      jq -r '.patternRef.identity'
  )
  if [ "$schema_identity_after_override" = "$schema_identity_before" ]; then
    error "Dangerously authorized setsrc did not change the piece source."
  fi
  schema_value=$(cf piece get $SPACE_ARGS --piece "$schema_piece_id" value)
  if [ "$schema_value" != "5" ]; then
    error "Dangerously authorized setsrc did not preserve the valid result."
  fi

  echo "Applying piece input."

  # Apply new input to piece
  echo '{"value":5}' | cf piece apply $SPACE_ARGS --piece $PIECE_ID

  # get, set and then re-get a value from the piece
  echo '10' | cf piece set $SPACE_ARGS --piece $PIECE_ID value

  # Verify the get returned what we expect
  RESULT=$(cf piece get $SPACE_ARGS --piece $PIECE_ID value)
  assert_json_eq "$RESULT" '10' "Get operation did not return expected value. Expected: 10, Got: $RESULT"

  echo "Testing different data types and nested paths..."

  # Test different data types
  test_value "String value" "stringField" '"hello world"' '"hello world"'
  test_value "Number value" "numberField" '42' '42'
  test_value "Boolean value" "booleanField" 'true' 'true'
  test_json_value "Array value" "arrayField" '[1,2,3]'
  test_json_value "Nested object" "userData" '{"user":{"name":"John","age":30}}'

  # Test nested path access
  test_get_only "Nested path access" "userData/user/name" '"John"'
  test_json_value "Array indexing" "listField" '["first","second","third"]'
  test_get_only "Array index access" "listField/1" '"second"'

  # Test setting nested value
  test_value "Nested path set" "userData/user/name" '"Jane"' '"Jane"'

  echo "Testing --input flag operations..."

  # Test input flag operations
  test_json_value "Input flag set" "userData" '{"user":{"name":"test"}}' "--input"
  test_value \
    "Nested input path" \
    "userData/user/name" \
    '"piece-search-input-value-7301"' \
    '"piece-search-input-value-7301"' \
    "--input"

  echo '"piece-search-result-value-9146"' |
    cf piece set $SPACE_ARGS --piece $PIECE_ID stringField
  SEARCH_INPUT=$(cf piece search $SPACE_ARGS --json "INPUT-VALUE-7301")
  echo "$SEARCH_INPUT" | jq -e --arg id "$PIECE_ID" \
    'length == 1 and .[0].id == $id' > /dev/null ||
    error "Piece search should find nested input data case-insensitively"
  SEARCH_RESULT=$(cf piece search $SPACE_ARGS --json "RESULT-VALUE-9146")
  echo "$SEARCH_RESULT" | jq -e --arg id "$PIECE_ID" \
    'length == 1 and .[0].id == $id' > /dev/null ||
    error "Piece search should find nested result data case-insensitively"
  SEARCH_NONE=$(cf piece search $SPACE_ARGS --json "piece-search-absent-5283")
  echo "$SEARCH_NONE" | jq -e 'length == 0' > /dev/null ||
    error "Piece search should return an empty JSON array when nothing matches"
  SEARCH_NAME=$(cf piece search $SPACE_ARGS --json "Simple counter:")
  echo "$SEARCH_NAME" | jq -e 'length == 0' > /dev/null ||
    error "Piece search should not match a piece name"

  echo "Testing piece step..."

  # Recompute (one iteration) with updated inputs
  cf piece step $SPACE_ARGS --piece $PIECE_ID

  # Check space has new piece with correct inputs and title
  TITLE="Simple counter 2: 10"
  if ! cf piece ls $SPACE_ARGS | grep -q "$PIECE_ID $TITLE"; then
    error "Piece did not appear in list of space pieces."
  fi

  echo "Successfully ran CLI piece values integration tests for ${API_URL}/${SPACE}/${PIECE_ID}."
}

run_piece_links() {
  setup_space

  create_stepped_counter_piece 10

  echo "Testing piece link..."

  cf piece set-slug $SPACE_ARGS counter-alias $PIECE_ID

  cf piece get $SPACE_ARGS --piece counter-alias value > /dev/null

  cf piece set-slug $SPACE_ARGS resolved-counter counter-alias --resolve-before-linking

  cf piece get $SPACE_ARGS --piece resolved-counter value > /dev/null

  # Create a second piece from the same pattern
  PIECE_ID2=$(cf piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS $PATTERN_SRC)
  echo "Created second piece: $PIECE_ID2"

  # Initialize piece2 with value 0 and step so output is computed
  echo '0' | cf piece set $SPACE_ARGS --piece $PIECE_ID2 value --input
  cf piece step $SPACE_ARGS --piece $PIECE_ID2

  # Verify piece2 starts with value 0
  RESULT=$(cf piece get $SPACE_ARGS --piece $PIECE_ID2 value)
  if [ "$RESULT" != "0" ]; then
    error "Piece2 value should be 0 before linking, got: $RESULT"
  fi

  # Linking from a nonexistent source path should fail
  if cf piece link $SPACE_ARGS $PIECE_ID/nonexistent $PIECE_ID2/value 2>/dev/null; then
    error "Linking from nonexistent source path should have failed"
  fi

  # Linking to a nonexistent target path should fail
  if cf piece link $SPACE_ARGS $PIECE_ID/value $PIECE_ID2/nonexistent 2>/dev/null; then
    error "Linking to nonexistent target path should have failed"
  fi

  # Link piece1's output value to piece2's input value
  cf piece link $SPACE_ARGS $PIECE_ID/value $PIECE_ID2/value

  # Linking to a missing destination slug should fail instead of treating it
  # as an invented target piece ID.
  if cf piece link $SPACE_ARGS $PIECE_ID/value missing-destination-slug/value 2>/dev/null; then
    error "Linking to missing destination slug should have failed"
  fi

  # Read back piece2's input value - should be piece1's output value (10)
  RESULT=$(cf piece get $SPACE_ARGS --piece $PIECE_ID2 value --input)
  if [ "$RESULT" != "10" ]; then
    error "After linking, piece2's input value should be 10 (from piece1), got: $RESULT"
  fi

  # Step piece2 to recompute with linked input
  cf piece step $SPACE_ARGS --piece $PIECE_ID2

  # Verify piece2's output value is now 10 (from piece1 via link)
  RESULT=$(cf piece get $SPACE_ARGS --piece $PIECE_ID2 value)
  if [ "$RESULT" != "10" ]; then
    error "After linking and stepping, piece2's output value should be 10, got: $RESULT"
  fi

  # Call increment handler on piece2; since its value is linked to piece1's
  # output cell, this should update piece1's value too.
  cf piece call $SPACE_ARGS --piece $PIECE_ID2 increment '{}'

  # Verify piece1's value is now 11 (was 10, incremented via piece2's handler)
  RESULT=$(cf piece get $SPACE_ARGS --piece $PIECE_ID value)
  if [ "$RESULT" != "11" ]; then
    error "After calling increment on piece2, piece1's value should be 11, got: $RESULT"
  fi

  echo "Testing piece link with invented piece ID..."

  # Use an invented piece ID (not created via cf piece new) as a data source
  INVENTED_ID="fid1:zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"

  # Write a value to the invented piece
  echo '42' | cf piece set $SPACE_ARGS --piece $INVENTED_ID value

  # Create a third piece and link the invented piece's value to its input
  PIECE_ID3=$(cf piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS $PATTERN_SRC)
  echo "Created third piece: $PIECE_ID3"

  # Linking from invented piece should fail without --allow-non-existing
  if cf piece link $SPACE_ARGS $INVENTED_ID/value $PIECE_ID3/value 2>/dev/null; then
    error "Linking from invented piece should have failed without --allow-non-existing"
  fi

  # Now link with --allow-non-existing
  cf piece link $SPACE_ARGS --allow-non-existing $INVENTED_ID/value $PIECE_ID3/value

  # Read back piece3's input value - should be 42 from the invented piece
  RESULT=$(cf piece get $SPACE_ARGS --piece $PIECE_ID3 value --input)
  if [ "$RESULT" != "42" ]; then
    error "After linking invented piece, piece3's input value should be 42, got: $RESULT"
  fi

  # Step piece3 to recompute with linked input
  cf piece step $SPACE_ARGS --piece $PIECE_ID3

  # Verify piece3's output value is 42
  RESULT=$(cf piece get $SPACE_ARGS --piece $PIECE_ID3 value)
  if [ "$RESULT" != "42" ]; then
    error "After stepping piece3 with invented link, output value should be 42, got: $RESULT"
  fi

  # Call increment on piece3 and verify the invented piece's value updates
  cf piece call $SPACE_ARGS --piece $PIECE_ID3 increment '{}'

  RESULT=$(cf piece get $SPACE_ARGS --piece $INVENTED_ID value)
  if [ "$RESULT" != "43" ]; then
    error "After calling increment on piece3, invented piece's value should be 43, got: $RESULT"
  fi

  echo "Successfully ran CLI piece link integration tests for ${API_URL}/${SPACE}/${PIECE_ID}."
}

run_piece_call() {
  setup_space

  echo "Testing piece call with schema-derived flags and tools..."

  CALLABLE_PATTERN_SRC="$SCRIPT_DIR/pattern/fuse-exec.tsx"
  CALLABLE_PIECE_ID=$(cf piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS $CALLABLE_PATTERN_SRC)
  echo "Created callable piece: $CALLABLE_PIECE_ID"

  CALL_HELP=$(cf piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID search --help)
  echo "$CALL_HELP" | grep -q "cf piece call ... search --help" ||
    error "Top-level callable help should work without the delimiter"
  echo "$CALL_HELP" | grep -q "cf piece call ... search <json>" ||
    error "Piece-call help should describe JSON input without --json"
  echo "$CALL_HELP" | grep -q "cf piece call ... search --json \[<json>\]" ||
    error "Piece-call help should describe explicit --json input"

  CALL_HELP_JSON=$(cf piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID search --help --json)
  echo "$CALL_HELP_JSON" | jq -e '.inputSchema.properties.query.type == "string"' > /dev/null ||
    error "Top-level --help --json should return the machine-readable schema"

  JSON_TOOL_RESULT=$(cf piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID search --json '{"query":"json-input"}')
  assert_json_eq \
    "$JSON_TOOL_RESULT" \
    '{"query":"json-input","help":"","source":"bound-source","summary":"bound-source:json-input:"}' \
    "Explicit inline --json should pass the complete tool input"

  cf piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID recordMessage -- --message "piece-flags"
  RESULT=$(cf piece get $SPACE_ARGS --piece $CALLABLE_PIECE_ID lastMessage)
  if [ "$RESULT" != '"piece-flags"' ]; then
    error "Flag-based handler call should update lastMessage, got: $RESULT"
  fi

  LEGACY_COUNT_BEFORE=$(read_piece_value_or_default "$CALLABLE_PIECE_ID" "legacyCount" "0")
  cf piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID legacyWrite
  RESULT=$(cf piece get $SPACE_ARGS --piece $CALLABLE_PIECE_ID legacyCount)
  if [ "$RESULT" != "$((LEGACY_COUNT_BEFORE + 1))" ]; then
    error "Bare no-arg handler call should increment legacyCount, got: $RESULT"
  fi

  cf piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID legacyWrite -- invoke
  RESULT=$(cf piece get $SPACE_ARGS --piece $CALLABLE_PIECE_ID legacyCount)
  if [ "$RESULT" != "$((LEGACY_COUNT_BEFORE + 2))" ]; then
    error "Explicit invoke should still call an empty-object handler, got legacyCount=$RESULT"
  fi

  TOOL_RESULT=$(cf piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID search -- --query tea)
  assert_json_eq \
    "$TOOL_RESULT" \
    '{"query":"tea","help":"","source":"bound-source","summary":"bound-source:tea:"}' \
    "Flag-based tool call should return the tool result"

  echo "Successfully ran CLI piece call integration tests for ${API_URL}/${SPACE}/${CALLABLE_PIECE_ID}."
}

run_wish() {
  setup_space

  echo "Testing cf wish (blessed headless read)..."

  # A fresh identity has no profile yet: `cf wish '#profile'` must resolve
  # through the wish builtin's headless path, surface the zero-profile WishError,
  # print it to stderr and exit non-zero.
  WISH_ERR_FILE=$(mktemp)
  set +e
  WISH_OUT=$(cf wish '#profile' --api-url="$API_URL" --identity="$IDENTITY" 2>"$WISH_ERR_FILE")
  WISH_CODE=$?
  set -e
  if [ "$WISH_CODE" == "0" ]; then
    error "cf wish '#profile' with no profile should exit non-zero, got 0 (stdout: $WISH_OUT)"
  fi
  grep -q "No profile exists yet" "$WISH_ERR_FILE" ||
    error "cf wish '#profile' with no profile should mention the missing profile on stderr"

  # --allow-empty turns the same empty read into 'null' on stdout with exit 0.
  WISH_EMPTY=$(cf wish '#profile' --allow-empty --api-url="$API_URL" --identity="$IDENTITY")
  if [ "$WISH_EMPTY" != "null" ]; then
    error "cf wish '#profile' --allow-empty should print 'null', got: $WISH_EMPTY"
  fi

  echo "Successfully ran CLI wish integration tests for ${API_URL}."
}

case "$SECTION" in
  all)
    run_piece_values
    run_piece_links
    run_piece_call
    run_wish
    ;;
  piece-basics)
    run_piece_values
    run_piece_links
    ;;
  piece-values)
    run_piece_values
    ;;
  piece-links)
    run_piece_links
    ;;
  piece-call)
    run_piece_call
    ;;
  wish)
    run_wish
    ;;
  *)
    error "Unknown CLI integration section: $SECTION"
    ;;
esac
