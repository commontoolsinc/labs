#!/usr/bin/env bash
# Check health of local dev servers.

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
source "$SCRIPT_DIR/common/port-utils.sh"

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
            echo "Unknown option: $1"
            echo "Usage: $0 [--port-offset N] [--shell-port PORT] [--toolshed-port PORT]"
            exit 1
            ;;
    esac
done

# Apply offset to default ports if not explicitly set
SHELL_PORT=${SHELL_PORT:-$((5173 + PORT_OFFSET))}
TOOLSHED_PORT=${TOOLSHED_PORT:-$((8000 + PORT_OFFSET))}

ALL_OK=true

check_server() {
    local name=$1
    local url=$2
    local port=$3

    local pids
    pids=$(get_pids_on_port "$port")

    if [[ -z "$pids" ]]; then
        echo "  $name: not running (nothing on port $port)"
        ALL_OK=false
        return
    fi

    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$url" 2>/dev/null)

    if [[ "$status" == "200" ]]; then
        echo "  $name: ok ($url)"
    else
        echo "  $name: process on port $port but HTTP status $status ($url)"
        ALL_OK=false
    fi
}

check_server "Toolshed" "http://localhost:$TOOLSHED_PORT/_health" "$TOOLSHED_PORT"
check_server "Shell" "http://localhost:$SHELL_PORT" "$SHELL_PORT"

if [[ "$ALL_OK" == "true" ]]; then
    echo "All servers healthy."
else
    echo "Some servers are not healthy."
    exit 1
fi
