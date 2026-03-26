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

if [ -n "$CT_CLI_INTEGRATION_USE_LOCAL" ]; then
 ct() {
   deno task ct "$@"
 }
fi

if [ -z "$API_URL" ]; then
  error "API_URL must be defined."
fi
SPACE=$(mktemp -u XXXXXXXXXX) # generates a random space
IDENTITY=$(mktemp)
SPACE_ARGS="--api-url=$API_URL --identity=$IDENTITY --space=$SPACE"
PATTERN_SRC="$SCRIPT_DIR/pattern/main.tsx"
WORK_DIR=$(mktemp -d)
CUSTOM_EXPORT="customPatternExport" # for testing this feature

echo "API_URL=$API_URL"
echo "SPACE=$SPACE"
echo "IDENTITY=$IDENTITY"
echo "WORK_DIR=$WORK_DIR"

# Create a key
ct id new > $IDENTITY

# Check space is empty
if [ "$(ct piece ls $SPACE_ARGS)" != "" ]; then
  error "Space not empty."
fi

# Create a new piece using custom default export as input
PIECE_ID=$(ct piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS $PATTERN_SRC)
echo "Created piece: $PIECE_ID"

echo "Fetching piece source to $WORK_DIR"
# Retrieve the source code for $PIECE_ID to $WORK_DIR
ct piece getsrc $SPACE_ARGS --piece $PIECE_ID $WORK_DIR

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
ct piece setsrc --main-export $CUSTOM_EXPORT $SPACE_ARGS --piece $PIECE_ID $WORK_DIR/main.tsx

# (Again) Retrieve the source code for $PIECE_ID to $WORK_DIR
rm "$WORK_DIR/main.tsx"
ct piece getsrc $SPACE_ARGS --piece $PIECE_ID $WORK_DIR

# Check file was retrieved with modifications
grep -q "Simple counter 2" "$WORK_DIR/main.tsx"
if [ $? -ne 0 ]; then
  error "Retrieved source code was not modified"
fi

echo "Applying piece input."

# Apply new input to piece
echo '{"value":5}' | ct piece apply $SPACE_ARGS --piece $PIECE_ID

# get, set and then re-get a value from the piece
echo '10' | ct piece set $SPACE_ARGS --piece $PIECE_ID value

# Verify the get returned what we expect
RESULT=$(ct piece get $SPACE_ARGS --piece $PIECE_ID value)
echo '10' | jq . > /tmp/expected.json
echo "$RESULT" | jq . > /tmp/actual.json
if ! diff -q /tmp/expected.json /tmp/actual.json > /dev/null; then
  error "Get operation did not return expected value. Expected: {\"value\":10}, Got: $RESULT"
fi

# Helper functions for testing
test_value() {
  local test_name="$1"
  local path="$2"
  local value="$3"
  local expected="$4"
  local flags="$5"

  echo "$value" | ct piece set $SPACE_ARGS --piece $PIECE_ID "$path" $flags
  local result=$(ct piece get $SPACE_ARGS --piece $PIECE_ID "$path" $flags)

  if [ "$result" != "$expected" ]; then
    error "$test_name failed. Expected: $expected, Got: $result"
  fi
}

test_json_value() {
  local test_name="$1"
  local path="$2"
  local value="$3"
  local flags="$4"

  echo "$value" | ct piece set $SPACE_ARGS --piece $PIECE_ID "$path" $flags
  local result=$(ct piece get $SPACE_ARGS --piece $PIECE_ID "$path" $flags)

  echo "$value" | jq . > /tmp/expected.json
  echo "$result" | jq . > /tmp/actual.json
  if ! diff -q /tmp/expected.json /tmp/actual.json > /dev/null; then
    error "$test_name failed. Expected: $value, Got: $result"
  fi
}

test_get_only() {
  local test_name="$1"
  local path="$2"
  local expected="$3"
  local flags="$4"

  local result=$(ct piece get $SPACE_ARGS --piece $PIECE_ID "$path" $flags)

  if [ "$result" != "$expected" ]; then
    error "$test_name failed. Expected: $expected, Got: $result"
  fi
}

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
test_value "Nested input path" "userData/user/name" '"inputValue"' '"inputValue"' "--input"

echo "Testing piece step..."

# Recompute (one iteration) with updated inputs
ct piece step $SPACE_ARGS --piece $PIECE_ID

# Check space has new piece with correct inputs and title
TITLE="Simple counter 2: 10"
if ! ct piece ls $SPACE_ARGS | grep -q "$PIECE_ID $TITLE <unnamed>"; then
  error "Piece did not appear in list of space pieces."
fi

echo "Testing piece link..."

# Create a second piece from the same pattern
PIECE_ID2=$(ct piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS $PATTERN_SRC)
echo "Created second piece: $PIECE_ID2"

# Initialize piece2 with value 0 and step so output is computed
echo '0' | ct piece set $SPACE_ARGS --piece $PIECE_ID2 value --input
ct piece step $SPACE_ARGS --piece $PIECE_ID2

# Verify piece2 starts with value 0
RESULT=$(ct piece get $SPACE_ARGS --piece $PIECE_ID2 value)
if [ "$RESULT" != "0" ]; then
  error "Piece2 value should be 0 before linking, got: $RESULT"
fi

# Linking from a nonexistent source path should fail
if ct piece link $SPACE_ARGS $PIECE_ID/nonexistent $PIECE_ID2/value 2>/dev/null; then
  error "Linking from nonexistent source path should have failed"
fi

# Linking to a nonexistent target path should fail
if ct piece link $SPACE_ARGS $PIECE_ID/value $PIECE_ID2/nonexistent 2>/dev/null; then
  error "Linking to nonexistent target path should have failed"
fi

# Link piece1's output value to piece2's input value
ct piece link $SPACE_ARGS $PIECE_ID/value $PIECE_ID2/value

# Read back piece2's input value - should be piece1's output value (10)
RESULT=$(ct piece get $SPACE_ARGS --piece $PIECE_ID2 value --input)
if [ "$RESULT" != "10" ]; then
  error "After linking, piece2's input value should be 10 (from piece1), got: $RESULT"
fi

# Step piece2 to recompute with linked input
ct piece step $SPACE_ARGS --piece $PIECE_ID2

# Verify piece2's output value is now 10 (from piece1 via link)
RESULT=$(ct piece get $SPACE_ARGS --piece $PIECE_ID2 value)
if [ "$RESULT" != "10" ]; then
  error "After linking and stepping, piece2's output value should be 10, got: $RESULT"
fi

# Call increment handler on piece2 — since its value is linked to piece1's
# output cell, this should update piece1's value too
ct piece call $SPACE_ARGS --piece $PIECE_ID2 increment '{}'

# Verify piece1's value is now 11 (was 10, incremented via piece2's handler)
RESULT=$(ct piece get $SPACE_ARGS --piece $PIECE_ID value)
if [ "$RESULT" != "11" ]; then
  error "After calling increment on piece2, piece1's value should be 11, got: $RESULT"
fi

echo "Testing piece link with invented piece ID..."

# Use an invented piece ID (not created via ct piece new) as a data source
INVENTED_ID="baedreizzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"

# Write a value to the invented piece
echo '42' | ct piece set $SPACE_ARGS --piece $INVENTED_ID value

# Create a third piece and link the invented piece's value to its input
PIECE_ID3=$(ct piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS $PATTERN_SRC)
echo "Created third piece: $PIECE_ID3"

# Linking from invented piece should fail without --allow-non-existing
if ct piece link $SPACE_ARGS $INVENTED_ID/value $PIECE_ID3/value 2>/dev/null; then
  error "Linking from invented piece should have failed without --allow-non-existing"
fi

# Now link with --allow-non-existing
ct piece link $SPACE_ARGS --allow-non-existing $INVENTED_ID/value $PIECE_ID3/value

# Read back piece3's input value - should be 42 from the invented piece
RESULT=$(ct piece get $SPACE_ARGS --piece $PIECE_ID3 value --input)
if [ "$RESULT" != "42" ]; then
  error "After linking invented piece, piece3's input value should be 42, got: $RESULT"
fi

# Step piece3 to recompute with linked input
ct piece step $SPACE_ARGS --piece $PIECE_ID3

# Verify piece3's output value is 42
RESULT=$(ct piece get $SPACE_ARGS --piece $PIECE_ID3 value)
if [ "$RESULT" != "42" ]; then
  error "After stepping piece3 with invented link, output value should be 42, got: $RESULT"
fi

# Call increment on piece3 and verify the invented piece's value updates
ct piece call $SPACE_ARGS --piece $PIECE_ID3 increment '{}'

RESULT=$(ct piece get $SPACE_ARGS --piece $INVENTED_ID value)
if [ "$RESULT" != "43" ]; then
  error "After calling increment on piece3, invented piece's value should be 43, got: $RESULT"
fi

echo "Testing piece call with schema-derived flags and tools..."

CALLABLE_PATTERN_SRC="$SCRIPT_DIR/pattern/fuse-exec.tsx"
CALLABLE_PIECE_ID=$(ct piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS $CALLABLE_PATTERN_SRC)
echo "Created callable piece: $CALLABLE_PIECE_ID"

CALL_HELP=$(ct piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID search --help)
echo "$CALL_HELP" | grep -q "ct piece call ... search --help" ||
  error "Top-level callable help should work without the delimiter"
echo "$CALL_HELP" | grep -q "ct piece call ... search <json>" ||
  error "Piece-call help should describe JSON input without --json"

CALL_HELP_JSON=$(ct piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID search --help --json)
echo "$CALL_HELP_JSON" | jq -e '.inputSchema.properties.query.type == "string"' > /dev/null ||
  error "Top-level --help --json should return the machine-readable schema"

# --json is now a registered no-op on ct piece call (CT-1393): agents expect
# it to work because it's valid on all other piece subcommands.
ct piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID search --json < /dev/null > /dev/null 2>&1 ||
  error "Redundant --json should be accepted (no-op) on ct piece call"

ct piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID recordMessage -- --message "piece-flags"
RESULT=$(ct piece get $SPACE_ARGS --piece $CALLABLE_PIECE_ID lastMessage)
if [ "$RESULT" != '"piece-flags"' ]; then
  error "Flag-based handler call should update lastMessage, got: $RESULT"
fi

NO_ARG_HANDLER_ERR=$(mktemp)
if ct piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID legacyWrite > /dev/null 2>"$NO_ARG_HANDLER_ERR"; then
  error "Bare no-arg handler calls should fail without explicit invoke"
fi
grep -q "Expected JSON on stdin for --json" "$NO_ARG_HANDLER_ERR" ||
  error "Bare no-arg handler call should explain that JSON input is required"

ct piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID legacyWrite -- invoke
RESULT=$(ct piece get $SPACE_ARGS --piece $CALLABLE_PIECE_ID legacyCount)
if [ "$RESULT" != "1" ]; then
  error "Explicit invoke should call a no-input handler, got legacyCount=$RESULT"
fi

TOOL_RESULT=$(ct piece call $SPACE_ARGS --piece $CALLABLE_PIECE_ID search -- --query tea)
assert_json_eq \
  "$TOOL_RESULT" \
  '{"query":"tea","help":"","source":"bound-source","summary":"bound-source:tea:"}' \
  "Flag-based tool call should return the tool result"

echo "Successfully ran integration tests for ${API_URL}/${SPACE}/${PIECE_ID}."
