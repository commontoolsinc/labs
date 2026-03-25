#!/usr/bin/env bash
# Kill any deno process on the specified ports
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
source "$SCRIPT_DIR/common/port-utils.sh"
read_base_ports

# Default ports and offset
PORT_OFFSET=${PORT_OFFSET:-0}
SHELL_PORT=${SHELL_PORT:-}
TOOLSHED_PORT=${TOOLSHED_PORT:-}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
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

# Kill deno processes listening on a specific port
kill_deno_on_port() {
    local port=$1
    local pids
    pids=$(get_pids_on_port "$port")

    for pid in $pids; do
        # Only kill if it's a deno process
        if ps -p "$pid" -o comm= 2>/dev/null | grep -q deno; then
            kill -9 "$pid" 2>/dev/null
        fi
    done
}

kill_deno_on_port "$SHELL_PORT"
kill_deno_on_port "$TOOLSHED_PORT"

# Kill background-charm-service if running (tracked via PID file)
BG_PID_FILE="$SCRIPT_DIR/../.bg-charm-service.pid"
if [[ -f "$BG_PID_FILE" ]]; then
    BG_PID=$(cat "$BG_PID_FILE")
    if ps -p "$BG_PID" > /dev/null 2>&1; then
        kill "$BG_PID" 2>/dev/null
        sleep 1
        # Force kill if still running
        if ps -p "$BG_PID" > /dev/null 2>&1; then
            kill -9 "$BG_PID" 2>/dev/null
        fi
    fi
    rm -f "$BG_PID_FILE"
fi
