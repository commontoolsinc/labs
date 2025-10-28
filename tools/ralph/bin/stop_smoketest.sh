#!/usr/bin/env bash

# Ralph IDs to stop (generous range to catch any running containers)
RALPH_IDS="1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20"

# Stop and remove all ralph smoketest containers
for ID in $RALPH_IDS; do
  echo "Stopping ralph_$ID..."
  docker stop ralph_$ID 2>/dev/null || true
  docker rm ralph_$ID 2>/dev/null || true
done

echo "All smoketest containers stopped and removed."
