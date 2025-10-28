#!/usr/bin/env bash

# Ralph IDs to run smoketests for
RALPH_IDS="1 2 3 4 5 6 7 8 9"

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Get the ralph directory (parent of bin)
RALPH_DIR="$(dirname "$SCRIPT_DIR")"
# Get the labs directory (two levels up from bin)
LABS="$(dirname "$(dirname "$RALPH_DIR")")"

# Change to labs directory
cd "$LABS"

# Pull latest image from Docker Hub
echo "Pulling latest ellyxir/ralph image from Docker Hub..."
docker pull ellyxir/ralph

# Stop and remove any existing ralph containers first
for ID in $RALPH_IDS; do
  docker stop ralph_$ID 2>/dev/null || true
  docker rm ralph_$ID 2>/dev/null || true
done

# Remove existing results after containers are stopped
rm -rf "$LABS/tools/ralph/smoketest"/[0-9]*

# Ensure smoketest directory exists and is writable
mkdir -p "$LABS/tools/ralph/smoketest"

# Pre-create directories with correct ownership to avoid permission issues
# This ensures the host user creates them (with correct UID) before containers try to
for ID in $RALPH_IDS; do
  mkdir -p "$LABS/tools/ralph/smoketest/$ID"
done

# Run smoketests
for ID in $RALPH_IDS; do
  echo "Starting smoketest for RALPH_ID=$ID"
  docker run --rm -e RALPH_ID=$ID -d \
    -u $(id -u):$(id -g) \
    -e HOME=/tmp/home \
    -v "$LABS:/app/labs:z" \
    -v "$LABS/tools/ralph/smoketest:/app/smoketest:z" \
    --cap-add=SYS_ADMIN \
    --security-opt seccomp=unconfined \
    --shm-size=2g \
    --name ralph_$ID \
    ellyxir/ralph

  # Copy Claude credentials into container's writable /tmp/home
  # Each container gets its own copy to avoid conflicts
  docker exec ralph_$ID mkdir -p /tmp/home/.claude
  docker cp ~/.claude.json ralph_$ID:/tmp/home/.claude.json

  # Handle credentials based on platform
  if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS: Extract credentials from keychain
    echo "Extracting credentials from macOS keychain..."
    CREDS=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)
    if [ -n "$CREDS" ]; then
      echo "$CREDS" | docker exec -i ralph_$ID tee /tmp/home/.claude/.credentials.json > /dev/null
      echo "Credentials copied from keychain for ralph_$ID"
    else
      echo "Warning: Could not find credentials in keychain for ralph_$ID"
    fi
  else
    # Linux/other: Copy from file
    docker cp ~/.claude/.credentials.json ralph_$ID:/tmp/home/.claude/.credentials.json
  fi

  # Configure Claude MCP server for Playwright
  # Container runs as host user with HOME=/tmp/home
  if ! docker exec ralph_$ID claude mcp list 2>/dev/null | grep -q playwright; then
    docker exec ralph_$ID claude mcp add --scope user playwright npx "@playwright/mcp@latest" -- --headless --isolated --no-sandbox
  fi
done

echo "All smoketests started. Monitor logs in tools/ralph/smoketest/<ID>/ralph.log"
echo ""

# Poll containers until all have exited
while true; do
  RUNNING_CONTAINERS=()

  # Check which containers are still running
  for ID in $RALPH_IDS; do
    if docker ps --filter "name=ralph_$ID" --format "{{.Names}}" | grep -q "ralph_$ID"; then
      RUNNING_CONTAINERS+=("ralph_$ID")
    fi
  done

  # If no containers are running, exit the loop
  if [ ${#RUNNING_CONTAINERS[@]} -eq 0 ]; then
    echo "All smoketests completed!"

    # Move screenshots to appropriate smoketest directories
    if [ -d "$LABS/.playwright-mcp" ]; then
      for screenshot in "$LABS/.playwright-mcp"/ralph_*-*.png; do
        if [ -f "$screenshot" ]; then
          # Extract RALPH_ID from filename (ralph_1-foo.png -> 1)
          filename=$(basename "$screenshot")
          ralph_id=$(echo "$filename" | sed 's/ralph_\([0-9]*\)-.*/\1/')
          if [ -d "$LABS/tools/ralph/smoketest/$ralph_id" ]; then
            mv "$screenshot" "$LABS/tools/ralph/smoketest/$ralph_id/"
            echo "Moved $filename to smoketest/$ralph_id/"
          fi
        fi
      done
    fi

    echo ""

    # Summarize scores
    SUCCESS_COUNT=0
    PARTIAL_COUNT=0
    FAILURE_COUNT=0

    for ID in $RALPH_IDS; do
      if [ -f "$LABS/tools/ralph/smoketest/$ID/SCORE.txt" ]; then
        SCORE=$(cat "$LABS/tools/ralph/smoketest/$ID/SCORE.txt" | tr -d '[:space:]')
        case "$SCORE" in
          SUCCESS) SUCCESS_COUNT=$((SUCCESS_COUNT + 1)) ;;
          PARTIAL) PARTIAL_COUNT=$((PARTIAL_COUNT + 1)) ;;
          FAILURE) FAILURE_COUNT=$((FAILURE_COUNT + 1)) ;;
        esac
      fi
    done

    echo "Summary: $SUCCESS_COUNT success, $PARTIAL_COUNT partial, $FAILURE_COUNT failure"
    echo ""
    echo "Results available in tools/ralph/smoketest/<ID>/"
    echo "  - SCORE.txt: SUCCESS/PARTIAL/FAILURE"
    echo "  - RESULTS.md: Test summary"
    echo "  - ralph.log: Full execution log"
    echo "  - Pattern files and screenshots"

    break
  fi

  # Print status (strip "ralph_" prefix from container names)
  IDS=("${RUNNING_CONTAINERS[@]#ralph_}")
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Still running: ${IDS[*]}"

  # Wait 10 seconds before checking again
  sleep 10
done
