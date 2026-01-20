#!/usr/bin/env bash
# Shared utilities for port detection across macOS and Linux

# Get PIDs listening on a port (cross-platform)
# Usage: get_pids_on_port <port>
get_pids_on_port() {
    local port=$1

    if command -v lsof &>/dev/null; then
        lsof -ti :"$port" -sTCP:LISTEN 2>/dev/null
    elif command -v ss &>/dev/null; then
        # Use awk instead of grep -P for portability
        ss -tlnp "sport = :$port" 2>/dev/null | awk -F'pid=' 'NF>1{split($2,a,","); print a[1]}' | sort -u
    elif command -v fuser &>/dev/null; then
        # fuser outputs to stderr, and prefixes with port info
        fuser "$port/tcp" 2>&1 | awk '{for(i=2;i<=NF;i++) print $i}'
    fi
}
