#!/usr/bin/env bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Stopping dev servers..."
"$SCRIPT_DIR/stop-local-dev.sh"

echo "Removing cached databases..."
rm -f "$REPO_ROOT/packages/toolshed/cache/memory/did:key:z6Mk"*.sqlite

echo "Starting dev servers..."
"$SCRIPT_DIR/start-local-dev.sh"

echo "Running reconnection test..."
cd "$REPO_ROOT/packages/runner"
deno test --allow-all ./integration/reconnection.test.ts
