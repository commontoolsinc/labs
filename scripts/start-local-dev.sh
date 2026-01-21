#!/usr/bin/env bash
# Change to repository root (parent of scripts directory)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

# Source shared utilities
source "$SCRIPT_DIR/common/port-utils.sh"

# Parse command line arguments
FORCE=false
while [[ $# -gt 0 ]]; do
    case $1 in
        --force)
            FORCE=true
            shift
            ;;
        *)
            shift
            ;;
    esac
done

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

check_port 8000
check_port 5173

# Start shell dev server in background
cd packages/shell
deno task dev-local > local-dev-shell.log 2>&1 &
SHELL_PID=$!

# Wait a moment for shell to start
sleep 2

# Start toolshed dev server in background
cd ../toolshed
SHELL_URL=http://localhost:5173 deno task dev > local-dev-toolshed.log 2>&1 &
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
echo "Toolshed URL: http://localhost:8000"
echo "Shell log file: packages/shell/local-dev-shell.log"
echo "Toolshed log file: packages/toolshed/local-dev-toolshed.log"
