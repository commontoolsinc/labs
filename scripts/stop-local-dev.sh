#!/usr/bin/env bash
# Kill any deno process on ports 5173 and 8000
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
source "$SCRIPT_DIR/common/port-utils.sh"

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

kill_deno_on_port 5173
kill_deno_on_port 8000
