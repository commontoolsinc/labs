#!/usr/bin/env bash
# Change to repository root (parent of scripts directory)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

# Default ports and offset
PORT_OFFSET=${PORT_OFFSET:-0}
SHELL_PORT=${SHELL_PORT:-}
TOOLSHED_PORT=${TOOLSHED_PORT:-}

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
        --port-offset)
            PORT_OFFSET="$2"
            shift 2
            ;;
        --port-offset=*)
            PORT_OFFSET="${1#*=}"
            shift
            ;;
        --shell-port)
            SHELL_PORT="$2"
            shift 2
            ;;
        --shell-port=*)
            SHELL_PORT="${1#*=}"
            shift
            ;;
        --toolshed-port)
            TOOLSHED_PORT="$2"
            shift 2
            ;;
        --toolshed-port=*)
            TOOLSHED_PORT="${1#*=}"
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--clear-cache] [--dangerously-clear-all-spaces] [--force] [--port-offset N] [--shell-port PORT] [--toolshed-port PORT]"
            exit 1
            ;;
    esac
done

# Apply offset to default ports if not explicitly set
SHELL_PORT=${SHELL_PORT:-$((5173 + PORT_OFFSET))}
TOOLSHED_PORT=${TOOLSHED_PORT:-$((8000 + PORT_OFFSET))}

# Export for child scripts
export SHELL_PORT
export TOOLSHED_PORT
export PORT_OFFSET

echo "Stopping local dev servers..."
./scripts/stop-local-dev.sh --shell-port "$SHELL_PORT" --toolshed-port "$TOOLSHED_PORT"

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
    ./scripts/start-local-dev.sh --force --shell-port "$SHELL_PORT" --toolshed-port "$TOOLSHED_PORT"
else
    ./scripts/start-local-dev.sh --shell-port "$SHELL_PORT" --toolshed-port "$TOOLSHED_PORT"
fi
