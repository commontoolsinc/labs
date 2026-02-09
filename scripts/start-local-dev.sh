#!/usr/bin/env bash
# Change to repository root (parent of scripts directory)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

# Source shared utilities
source "$SCRIPT_DIR/common/port-utils.sh"

# Default ports and offset
PORT_OFFSET=${PORT_OFFSET:-0}
SHELL_PORT=${SHELL_PORT:-}
TOOLSHED_PORT=${TOOLSHED_PORT:-}

# Parse command line arguments
FORCE=false
while [[ $# -gt 0 ]]; do
    case $1 in
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
            shift
            ;;
    esac
done

# Apply offset to default ports if not explicitly set
SHELL_PORT=${SHELL_PORT:-$((5173 + PORT_OFFSET))}
TOOLSHED_PORT=${TOOLSHED_PORT:-$((8000 + PORT_OFFSET))}

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
# NOTE: We run directly without --watch because deno's --watch flag doesn't
# pass environment variables to the subprocess it spawns. This is needed
# for PORT_OFFSET to work correctly.
cd ../toolshed
SHELL_URL="http://localhost:$SHELL_PORT" PORT="$TOOLSHED_PORT" \
    deno run --unstable-otel -A --env-file=.env index.ts > local-dev-toolshed.log 2>&1 &
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

# Print the toolshed URL on success
echo "Development servers started successfully!"
echo "  Shell:    http://localhost:$SHELL_PORT"
echo "  Toolshed: http://localhost:$TOOLSHED_PORT"
if [[ "$PORT_OFFSET" -ne 0 ]]; then
    echo "  Offset:   $PORT_OFFSET"
fi
echo "Shell log file: packages/shell/local-dev-shell.log"
echo "Toolshed log file: packages/toolshed/local-dev-toolshed.log"
