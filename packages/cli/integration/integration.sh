#!/usr/bin/env bash
set -e

# Redirect logs to stderr so they don't pollute stdout (used for machine-readable output)
export LOG_TO_STDERR=1
SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
error () {
  >&2 echo $1
  exit 1
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
RECIPE_SRC="$SCRIPT_DIR/recipe/main.tsx"
WORK_DIR=$(mktemp -d)
CUSTOM_EXPORT="customRecipeExport" # for testing this feature

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
PIECE_ID=$(ct piece new --main-export $CUSTOM_EXPORT $SPACE_ARGS $RECIPE_SRC)
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

echo "Successfully ran integration tests for ${API_URL}/${SPACE}/${PIECE_ID}."
