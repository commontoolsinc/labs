#!/usr/bin/env bash

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Get the ralph directory (parent of bin)
RALPH_DIR="$(dirname "$SCRIPT_DIR")"
# Get the labs directory (two levels up from bin)
LABS="$(dirname "$(dirname "$RALPH_DIR")")"

# Change to labs directory
cd "$LABS"

# Stop and remove any existing ralph containers first
for ID in 1 2 3; do
  docker stop ralph_$ID 2>/dev/null || true
  docker rm ralph_$ID 2>/dev/null || true
done

# Remove existing results after containers are stopped
rm -rf "$LABS/tools/ralph/smoketest"/[0-9]*

# Run smoketests for IDs 1 through 3
for ID in 1 2 3; do
  echo "Starting smoketest for RALPH_ID=$ID"
  docker run --rm -e RALPH_ID=$ID -d \
    -v ~/.claude.json:/home/ralph/.claude.json \
    -v ~/.claude/.credentials.json:/home/ralph/.claude/.credentials.json \
    -v "$LABS/tools/ralph/smoketest:/app/smoketest" \
    --name ralph_$ID \
    ellyxir/ralph
done

echo "All smoketests started. Use 'docker logs ralph_<ID>' to monitor progress."
