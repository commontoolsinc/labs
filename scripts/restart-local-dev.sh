#!/usr/bin/env bash
# Change to repository root (parent of scripts directory)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

# Parse command line arguments
CLEAR_CACHE=false
FORCE=false
while [[ $# -gt 0 ]]; do
    case $1 in
        --clear-cache)
            CLEAR_CACHE=true
            shift
            ;;
        --force)
            FORCE=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--clear-cache] [--force]"
            exit 1
            ;;
    esac
done

echo "Stopping local dev servers..."
./scripts/stop-local-dev.sh

if [[ "$CLEAR_CACHE" == "true" ]]; then
    echo "Clearing cache..."
    rm -rf packages/toolshed/cache/*
    echo "Cache cleared."
fi

echo "Starting local dev servers..."
if [[ "$FORCE" == "true" ]]; then
    ./scripts/start-local-dev.sh --force
else
    ./scripts/start-local-dev.sh
fi
