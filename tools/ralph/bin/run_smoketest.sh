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
# TODO: Change back to "1 2 3" to run all containers
for ID in 1; do
  echo "Starting smoketest for RALPH_ID=$ID"
  docker run --rm -e RALPH_ID=$ID -d \
    -v "$LABS:/app/labs" \
    -v "$LABS/tools/ralph/smoketest:/app/smoketest" \
    --name ralph_$ID \
    ellyxir/ralph

  # Create .claude directory and copy credentials into the running container
  docker exec ralph_$ID mkdir -p /home/ralph/.claude
  docker cp ~/.claude.json ralph_$ID:/home/ralph/.claude.json
  docker cp ~/.claude/.credentials.json ralph_$ID:/home/ralph/.claude/.credentials.json

  # Configure Claude MCP server for Playwright (only if not already configured)
  # --no-sandbox is required because Docker containers restrict namespace creation
  if ! docker exec -u ralph ralph_$ID claude mcp list 2>/dev/null | grep -q playwright; then
    docker exec -u ralph ralph_$ID claude mcp add --scope user playwright npx "@playwright/mcp@latest" -- --headless --isolated --no-sandbox
  fi
done

echo "All smoketests started. Monitoring container status..."
echo ""

# Poll containers until all have exited
while true; do
  RUNNING_CONTAINERS=()

  # Check which containers are still running
  for ID in 1 2 3; do
    if docker ps --filter "name=ralph_$ID" --format "{{.Names}}" | grep -q "ralph_$ID"; then
      RUNNING_CONTAINERS+=("ralph_$ID")
    fi
  done

  # If no containers are running, exit the loop
  if [ ${#RUNNING_CONTAINERS[@]} -eq 0 ]; then
    echo "All smoketests completed!"
    break
  fi

  # Print status
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Still running: ${RUNNING_CONTAINERS[*]}"

  # Wait 10 seconds before checking again
  sleep 10
done
