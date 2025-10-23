#!/usr/bin/env bash

# Stop and remove all ralph smoketest containers
for ID in 1 2 3; do
  echo "Stopping ralph_$ID..."
  docker stop ralph_$ID 2>/dev/null || true
  docker rm ralph_$ID 2>/dev/null || true
done

echo "All smoketest containers stopped and removed."
