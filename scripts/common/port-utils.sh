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

# Read base ports from ports.json at repo root
read_base_ports() {
    if ! command -v jq &>/dev/null; then
        echo "Error: jq is required but not found. Install with: brew install jq" >&2
        exit 1
    fi
    local ports_file
    ports_file="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/ports.json"
    if [[ ! -f "$ports_file" ]]; then
        echo "Error: $ports_file not found" >&2
        exit 1
    fi
    BASE_TOOLSHED_PORT=$(jq -e '.toolshed' "$ports_file") || { echo "Error: ports.json missing .toolshed" >&2; exit 1; }
    BASE_SHELL_PORT=$(jq -e '.shell' "$ports_file") || { echo "Error: ports.json missing .shell" >&2; exit 1; }
    BASE_INSPECTOR_PORT=$(jq -e '.inspector' "$ports_file") || { echo "Error: ports.json missing .inspector" >&2; exit 1; }
}
