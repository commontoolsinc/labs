#!/usr/bin/env bash
# Shared utilities for port detection across macOS and Linux

# Get PIDs listening on a port (cross-platform)
# Usage: get_pids_on_port <port>
#
# Output contract: newline-separated numeric PIDs, or empty if none found.
# Callers pipe this straight into kill, so no branch may ever leak
# non-numeric text (e.g. tool error messages) to stdout.
get_pids_on_port() {
    local port=$1

    # lsof is the primary detector on macOS, but it lives in /usr/sbin,
    # which minimal PATHs (e.g. launchd-spawned processes) often omit.
    # Probe absolute locations before giving up on it.
    local lsof_bin=""
    if command -v lsof &>/dev/null; then
        lsof_bin=lsof
    elif [[ -x /usr/sbin/lsof ]]; then
        lsof_bin=/usr/sbin/lsof
    elif [[ -x /usr/bin/lsof ]]; then
        lsof_bin=/usr/bin/lsof
    fi

    {
        if [[ -n "$lsof_bin" ]]; then
            "$lsof_bin" -ti :"$port" -sTCP:LISTEN 2>/dev/null
        elif command -v ss &>/dev/null; then
            # Use awk instead of grep -P for portability
            ss -tlnp "sport = :$port" 2>/dev/null | awk -F'pid=' 'NF>1{split($2,a,","); print a[1]}' | sort -u
        elif [[ "$(uname)" == "Linux" ]] && command -v fuser &>/dev/null; then
            # Linux only: macOS fuser has no port/tcp form and would print
            # an error instead of PIDs. fuser outputs to stderr, and
            # prefixes with port info.
            fuser "$port/tcp" 2>&1 | awk '{for(i=2;i<=NF;i++) print $i}'
        fi
    } | grep -E '^[0-9]+$' || true
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
