#!/usr/bin/env bash
set -e
SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
error () {
  >&2 echo $1
  exit 1
}

# Use e.g. CT_BINARY="deno task cli" to run from repo without building binaries
if [ "$CT_BINARY" != "" ]; then
  echo "ct=$CT_BINARY"
  ct() {
    $CT_BINARY "$@"
  }
fi


if [ "$#" -eq 0 ]; then
  error "Missing required argument: API_URL"
fi

API_URL="$1"
SPACE=$(mktemp -u XXXXXXXXXX) # generates a random space
IDENTITY=$(mktemp)
SPACE_ARGS="--api-url=$API_URL --identity=$IDENTITY --space=$SPACE"
RECIPE_SRC="$SCRIPT_DIR/../../../recipes/counter.tsx"
WORK_DIR=$(mktemp -d)

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

# Create a new charm with {value:5} as input
CHARM_ID=$(ct charm new $SPACE_ARGS $RECIPE_SRC)
echo "Created charm: $CHARM_ID"

# Retrieve the source code for $CHARM_ID to $WORK_DIR
ct charm getsrc $SPACE_ARGS --charm $CHARM_ID $WORK_DIR

# Check file was retrieved
if [ ! -f "$WORK_DIR/main.tsx" ]; then
  error "Source code was not retrieved from $CHARM_ID"
fi

# Update the charm's source code
sed -i 's/Simple counter:/Simple counter 2:/g' "$WORK_DIR/main.tsx"
ct charm setsrc $SPACE_ARGS --charm $CHARM_ID $WORK_DIR/main.tsx

# (Again) Retrieve the source code for $CHARM_ID to $WORK_DIR
rm "$WORK_DIR/main.tsx"
ct charm getsrc $SPACE_ARGS --charm $CHARM_ID $WORK_DIR

# Check file was retrieved with modifications
grep -q "Simple counter 2" "$WORK_DIR/main.tsx"
if [ $? -ne 0 ]; then
  error "Retrieved source code was not modified"
fi

# Apply new input to charm
echo '{"value":5}' | ct charm apply $SPACE_ARGS --charm $CHARM_ID

# Check space has new charm with correct inputs and title
TITLE="Simple counter 2: 5"
ct charm ls $SPACE_ARGS | grep -q "$CHARM_ID $TITLE <unnamed>"
if [ $? -ne 0 ]; then
  error "Charm did not appear in list of space charms."
fi
