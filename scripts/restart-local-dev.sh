#!/usr/bin/env bash
# Change to repository root (parent of scripts directory)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

# Parse command line arguments
CLEAR_CACHE=false
CLEAR_ALL_SPACES=false
FORCE=false
while [[ $# -gt 0 ]]; do
    case $1 in
        --clear-cache)
            CLEAR_CACHE=true
            shift
            ;;
        --dangerously-clear-all-spaces)
            CLEAR_ALL_SPACES=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--clear-cache] [--dangerously-clear-all-spaces] [--force]"
            exit 1
            ;;
    esac
done

echo "Stopping local dev servers..."
./scripts/stop-local-dev.sh

CACHE_DIR="packages/toolshed/cache"

if [[ "$CLEAR_CACHE" == "true" ]]; then
    echo "Clearing disposable caches (preserving spaces/databases)..."
    # Clear all cache subdirectories except 'memory' which contains databases
    if [[ -d "$CACHE_DIR" ]]; then
        find "$CACHE_DIR" -mindepth 1 -maxdepth 1 -type d ! -name 'memory' -exec rm -rf {} +
        # Also remove any loose files in cache root
        find "$CACHE_DIR" -maxdepth 1 -type f -delete
    fi
    echo "Disposable caches cleared."
fi

if [[ "$CLEAR_ALL_SPACES" == "true" ]]; then
    echo "WARNING: Clearing all spaces/databases..."
    if [[ -d "$CACHE_DIR/memory" ]]; then
        rm -rf "$CACHE_DIR/memory"
    fi
    echo "Spaces/databases cleared."
fi

echo "Starting local dev servers..."
if [[ "$FORCE" == "true" ]]; then
    ./scripts/start-local-dev.sh --force
else
    ./scripts/start-local-dev.sh
fi
