#!/usr/bin/env bash
# Change to repository root (parent of scripts directory)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

# Source shared utilities
source "$SCRIPT_DIR/common/port-utils.sh"
read_base_ports

# Default ports and offset
PORT_OFFSET=${PORT_OFFSET:-0}
SHELL_PORT=${SHELL_PORT:-}
TOOLSHED_PORT=${TOOLSHED_PORT:-}
INSPECT=false
INSPECT_BRK=false
INSPECT_PORT=${INSPECT_PORT:-}

# Parse command line arguments
FORCE=false
WATCH=false
BG_UPDATER=false
while [[ $# -gt 0 ]]; do
    case $1 in
        --force)
            FORCE=true
            shift
            ;;
        --watch)
            WATCH=true
            shift
            ;;
        --bg-updater)
            BG_UPDATER=true
            shift
            ;;
        --inspect)
            INSPECT=true
            shift
            ;;
        --inspect-brk)
            INSPECT=true
            INSPECT_BRK=true
            shift
            ;;
        --inspect-port)
            INSPECT=true
            INSPECT_PORT="$2"
            shift 2
            ;;
        --inspect-port=*)
            INSPECT=true
            INSPECT_PORT="${1#*=}"
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
            shift
            ;;
    esac
done

# Apply offset to default ports if not explicitly set
SHELL_PORT=${SHELL_PORT:-$((BASE_SHELL_PORT + PORT_OFFSET))}
TOOLSHED_PORT=${TOOLSHED_PORT:-$((BASE_TOOLSHED_PORT + PORT_OFFSET))}
INSPECT_PORT=${INSPECT_PORT:-$((BASE_INSPECTOR_PORT + PORT_OFFSET))}

# Export for child processes
export SHELL_PORT
export TOOLSHED_PORT

# Check if port is free; kill processes if --force, otherwise error
check_port() {
    local port=$1
    local pids
    pids=$(get_pids_on_port "$port")

    if [[ -n "$pids" ]]; then
        if [[ "$FORCE" == "true" ]]; then
            echo "Port $port is in use, killing processes: $pids"
            echo "$pids" | xargs kill 2>/dev/null
            sleep 1
            # Force kill if still running
            pids=$(get_pids_on_port "$port")
            if [[ -n "$pids" ]]; then
                echo "Force killing remaining processes: $pids"
                echo "$pids" | xargs kill -9 2>/dev/null
                sleep 1
            fi
        else
            echo "Error: Port $port is already in use" >&2
            exit 1
        fi
    fi
}

check_port "$TOOLSHED_PORT"
check_port "$SHELL_PORT"

# Start shell dev server in background
cd packages/shell
TOOLSHED_PORT="$TOOLSHED_PORT" deno task dev-local > local-dev-shell.log 2>&1 &
SHELL_PID=$!

# Wait a moment for shell to start
sleep 2

# Start toolshed dev server in background
# We pass --port= as CLI arg because deno --watch doesn't pass env vars to subprocess
cd ../toolshed
WATCH_FLAG=""
if [[ "$WATCH" == "true" ]]; then
    WATCH_FLAG="--watch"
fi
INSPECT_FLAG=""
if [[ "$INSPECT" == "true" ]]; then
    if [[ "$INSPECT_BRK" == "true" ]]; then
        INSPECT_FLAG="--inspect-brk=127.0.0.1:$INSPECT_PORT"
    else
        INSPECT_FLAG="--inspect=127.0.0.1:$INSPECT_PORT"
    fi
fi
SHELL_URL="http://localhost:$SHELL_PORT" \
    deno run --unstable-otel -A $INSPECT_FLAG $WATCH_FLAG --env-file=.env index.ts --port="$TOOLSHED_PORT" > local-dev-toolshed.log 2>&1 &
TOOLSHED_PID=$!

# # Function to cleanup background processes
# cleanup() {
#     kill $SHELL_PID $TOOLSHED_PID 2>/dev/null
#     exit
# }

# # Set up trap to cleanup on script exit
# trap cleanup EXIT INT TERM

# Wait a moment for toolshed to start
sleep 3

# Print the toolshed URL on success (when not using --bg-updater, which prints after health check)
if [[ "$BG_UPDATER" != "true" ]]; then
    echo "Development servers started successfully!"
    echo "  Shell:    http://localhost:$SHELL_PORT"
    echo "  Toolshed: http://localhost:$TOOLSHED_PORT"
    if [[ "$INSPECT" == "true" ]]; then
        echo "  Inspect:  127.0.0.1:$INSPECT_PORT"
    fi
    if [[ "$PORT_OFFSET" -ne 0 ]]; then
        echo "  Offset:   $PORT_OFFSET"
    fi
    echo "Shell log file: packages/shell/local-dev-shell.log"
    echo "Toolshed log file: packages/toolshed/local-dev-toolshed.log"
fi

# Optionally start background-charm-service for bgUpdater polling
if [[ "$BG_UPDATER" == "true" ]]; then
    echo ""
    echo "Starting background-charm-service..."

    # Kill any previously running bg service to avoid orphaned processes
    BG_PID_FILE="$SCRIPT_DIR/../.bg-charm-service.pid"
    if [[ -f "$BG_PID_FILE" ]]; then
        OLD_BG_PID=$(cat "$BG_PID_FILE")
        if kill -0 "$OLD_BG_PID" 2>/dev/null; then
            echo "  Stopping previous bg service (PID $OLD_BG_PID)..."
            kill "$OLD_BG_PID" 2>/dev/null
            sleep 1
            if kill -0 "$OLD_BG_PID" 2>/dev/null; then
                echo "  Force killing previous bg service..."
                kill -9 "$OLD_BG_PID" 2>/dev/null
            fi
        fi
        rm -f "$BG_PID_FILE"
    fi

    # Wait for toolshed to be healthy before starting bg service
    echo "  Waiting for toolshed to be ready..."
    for i in $(seq 1 30); do
        if curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://localhost:$TOOLSHED_PORT/_health" 2>/dev/null | grep -q "200"; then
            echo "  Toolshed is ready!"
            break
        fi
        if [[ $i -eq 30 ]]; then
            echo "  Warning: Toolshed not ready after 30s, starting bg service anyway"
        fi
        sleep 1
    done

    # Start the background service directly (not via deno task, for reliable PID tracking)
    cd "$SCRIPT_DIR/../packages/background-charm-service"
    OPERATOR_PASS="implicit trust" API_URL="http://localhost:$TOOLSHED_PORT" \
        deno run -A --unstable-worker-options src/main.ts \
        > "$SCRIPT_DIR/../packages/background-charm-service/local-dev-bg.log" 2>&1 &
    BG_PID=$!
    cd "$SCRIPT_DIR/.."

    # Save PID for stop script
    echo "$BG_PID" > "$BG_PID_FILE"

    echo "  Background service: PID $BG_PID (polling bgUpdater every 60s)"
    echo "  Log file: packages/background-charm-service/local-dev-bg.log"
    echo ""
    echo "Development servers started successfully!"
    echo "  Shell:    http://localhost:$SHELL_PORT"
    echo "  Toolshed: http://localhost:$TOOLSHED_PORT"
    if [[ "$INSPECT" == "true" ]]; then
        echo "  Inspect:  127.0.0.1:$INSPECT_PORT"
    fi
    if [[ "$PORT_OFFSET" -ne 0 ]]; then
        echo "  Offset:   $PORT_OFFSET"
    fi
    echo "Shell log file: packages/shell/local-dev-shell.log"
    echo "Toolshed log file: packages/toolshed/local-dev-toolshed.log"
fi
