#!/usr/bin/env bash
# Kill any deno process on ports 5173 and 8000
# Cross-platform compatible (macOS and Linux)

# Cross-platform function to get PIDs listening on a port
get_pids_on_port() {
    local port=$1
    local pids=""

    if command -v lsof &>/dev/null; then
        # macOS and Linux with lsof installed
        pids=$(lsof -ti:$port 2>/dev/null)
    elif command -v ss &>/dev/null; then
        # Linux with ss (part of iproute2, commonly available)
        pids=$(ss -tlnp "sport = :$port" 2>/dev/null | grep -oP 'pid=\K\d+' | sort -u)
    elif command -v fuser &>/dev/null; then
        # Fallback to fuser
        pids=$(fuser $port/tcp 2>/dev/null | tr -s ' ' '\n' | grep -v '^$')
    fi

    echo "$pids"
}

# Kill deno processes on a specific port
kill_deno_on_port() {
    local port=$1
    local pids=$(get_pids_on_port $port)

    if [[ -n "$pids" ]]; then
        for pid in $pids; do
            # Check if this is a deno process
            if ps -p "$pid" -o comm= 2>/dev/null | grep -q deno; then
                kill -9 "$pid" 2>/dev/null
            fi
        done
    fi
}

kill_deno_on_port 5173
kill_deno_on_port 8000
