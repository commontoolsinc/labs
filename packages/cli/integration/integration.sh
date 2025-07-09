#!/usr/bin/env bash
set -e
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
   deno task cli "$@"
 }
fi

if [ "$#" -eq 0 ]; then
  error "Missing required argument: API_URL"
fi
API_URL="$1"
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
if [ "$(ct charm ls $SPACE_ARGS)" != "" ]; then
  error "Space not empty."
fi

# Create a new charm using custom default export as input
CHARM_ID=$(ct charm new --main-export $CUSTOM_EXPORT $SPACE_ARGS $RECIPE_SRC)
echo "Created charm: $CHARM_ID"

echo "Fetching charm source to $WORK_DIR"
# Retrieve the source code for $CHARM_ID to $WORK_DIR
ct charm getsrc $SPACE_ARGS --charm $CHARM_ID $WORK_DIR

# Check file was retrieved
if [ ! -f "$WORK_DIR/main.tsx" ]; then
  error "Source code was not retrieved from $CHARM_ID"
fi
if [ ! -f "$WORK_DIR/utils.ts" ]; then
  error "Source code was not retrieved from $CHARM_ID"
fi

echo "Updating charm source."

# Update the charm's source code
replace 's/Simple counter:/Simple counter 2:/g' "$WORK_DIR/main.tsx"
ct charm setsrc --main-export $CUSTOM_EXPORT $SPACE_ARGS --charm $CHARM_ID $WORK_DIR/main.tsx

# (Again) Retrieve the source code for $CHARM_ID to $WORK_DIR
rm "$WORK_DIR/main.tsx"
ct charm getsrc $SPACE_ARGS --charm $CHARM_ID $WORK_DIR

# Check file was retrieved with modifications
grep -q "Simple counter 2" "$WORK_DIR/main.tsx"
if [ $? -ne 0 ]; then
  error "Retrieved source code was not modified"
fi

echo "Applying charm input."

# Apply new input to charm
echo '{"value":5}' | ct charm apply $SPACE_ARGS --charm $CHARM_ID

# get, set and then re-get a value from the charm
ct charm get $SPACE_ARGS --charm $CHARM_ID testField
echo '{"value":10}' | ct charm set $SPACE_ARGS --charm $CHARM_ID testField

# Verify the get returned what we expect
RESULT=$(ct charm get $SPACE_ARGS --charm $CHARM_ID testField)
echo '{"value":10}' | jq . > /tmp/expected.json
echo "$RESULT" | jq . > /tmp/actual.json
if ! diff -q /tmp/expected.json /tmp/actual.json > /dev/null; then
  error "Get operation did not return expected value. Expected: {\"value\":10}, Got: $RESULT"
fi

# Check space has new charm with correct inputs and title
TITLE="Simple counter 2: 5"
ct charm ls $SPACE_ARGS | grep -q "$CHARM_ID $TITLE <unnamed>"
if [ $? -ne 0 ]; then
  error "Charm did not appear in list of space charms."
fi

echo "Successfully ran integration tests for ${API_URL}/${SPACE}/${CHARM_ID}."
