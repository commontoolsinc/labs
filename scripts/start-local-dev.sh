#!/usr/bin/env bash
# Change to repository root (parent of scripts directory)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

# Source shared utilities
source "$SCRIPT_DIR/common/port-utils.sh"
read_base_ports

require_command() {
    local command_name=$1
    local install_hint=$2

    if ! command -v "$command_name" &>/dev/null; then
        echo "Error: $command_name is required but not found." >&2
        if [[ -n "$install_hint" ]]; then
            echo "       $install_hint" >&2
        fi
        exit 1
    fi
}

# Default ports and offset
PORT_OFFSET=${PORT_OFFSET:-0}
SHELL_PORT=${SHELL_PORT:-}
TOOLSHED_PORT=${TOOLSHED_PORT:-}
INSPECT=false
INSPECT_BRK=false
INSPECT_PORT=${INSPECT_PORT:-}
LOCAL_DEV_STARTUP_TIMEOUT=${LOCAL_DEV_STARTUP_TIMEOUT:-120}

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

require_command "deno" \
    "Run 'mise install' from the repo root or install Deno before starting local dev."
require_command "curl" \
    "Install curl so startup can verify that local dev servers reached HTTP 200."

KEEP_ALIVE=false
if [[ -n "${CODEX_SANDBOX:-}" ]]; then
    KEEP_ALIVE=true
fi

SHELL_LOG="$SCRIPT_DIR/../packages/shell/local-dev-shell.log"
TOOLSHED_LOG="$SCRIPT_DIR/../packages/toolshed/local-dev-toolshed.log"
BG_LOG="$SCRIPT_DIR/../packages/background-charm-service/local-dev-bg.log"
SHELL_PID=""
TOOLSHED_PID=""
BG_PID=""

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

show_recent_log() {
    local name=$1
    local log_file=$2

    if [[ -f "$log_file" ]]; then
        echo "" >&2
        echo "Last 40 lines from $name log ($log_file):" >&2
        tail -n 40 "$log_file" >&2
    fi
}

kill_port_listeners() {
    local port=$1
    local pids
    pids=$(get_pids_on_port "$port")

    for pid in $pids; do
        kill "$pid" 2>/dev/null
    done
}

cleanup_started_processes() {
    if [[ -n "$BG_PID" ]]; then
        kill "$BG_PID" 2>/dev/null
    fi
    if [[ -n "$TOOLSHED_PID" ]]; then
        kill "$TOOLSHED_PID" 2>/dev/null
    fi
    if [[ -n "$SHELL_PID" ]]; then
        kill "$SHELL_PID" 2>/dev/null
    fi

    kill_port_listeners "$TOOLSHED_PORT"
    kill_port_listeners "$SHELL_PORT"
}

fail_startup() {
    local message=$1

    echo "Error: $message" >&2
    cleanup_started_processes
    show_recent_log "shell" "$SHELL_LOG"
    show_recent_log "toolshed" "$TOOLSHED_LOG"
    exit 1
}

ensure_process_running() {
    local name=$1
    local pid=$2
    local log_file=$3
    local process_state

    if kill -0 "$pid" 2>/dev/null; then
        process_state=$(ps -p "$pid" -o stat= 2>/dev/null)
        if [[ "$process_state" != *Z* ]]; then
            return
        fi
    fi

    wait "$pid" 2>/dev/null
    local exit_status=$?
    echo "Error: $name exited before it became ready (exit $exit_status)." >&2
    cleanup_started_processes
    show_recent_log "$name" "$log_file"
    exit 1
}

wait_for_http() {
    local name=$1
    local url=$2
    local pid=$3
    local log_file=$4
    local deadline=$((SECONDS + LOCAL_DEV_STARTUP_TIMEOUT))
    local remaining
    local status

    echo "Waiting for $name at $url..."
    while (( SECONDS < deadline )); do
        ensure_process_running "$name" "$pid" "$log_file"

        remaining=$((deadline - SECONDS))
        if (( remaining > 2 )); then
            remaining=2
        fi

        status=$(
            curl -s -o /dev/null -w "%{http_code}" --max-time "$remaining" \
                "$url" 2>/dev/null
        )
        if [[ "$status" == "200" ]]; then
            echo "  $name is ready."
            return
        fi

        if (( SECONDS < deadline )); then
            sleep 1
        fi
    done

    fail_startup \
        "$name did not become ready at $url within ${LOCAL_DEV_STARTUP_TIMEOUT}s."
}

# Start shell dev server in background
cd "$SCRIPT_DIR/../packages/shell"
TOOLSHED_PORT="$TOOLSHED_PORT" deno task dev-local > "$SHELL_LOG" 2>&1 &
SHELL_PID=$!

# Start toolshed dev server in background
# We pass --port= as CLI arg because deno --watch doesn't pass env vars to subprocess
cd "$SCRIPT_DIR/../packages/toolshed"
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
    deno run --unstable-otel -A $INSPECT_FLAG $WATCH_FLAG \
        --env-file=.env index.ts --port="$TOOLSHED_PORT" \
        > "$TOOLSHED_LOG" 2>&1 &
TOOLSHED_PID=$!

wait_for_http "shell" "http://localhost:$SHELL_PORT" "$SHELL_PID" "$SHELL_LOG"

# # Function to cleanup background processes
# cleanup() {
#     kill $SHELL_PID $TOOLSHED_PID 2>/dev/null
#     exit
# }

# # Set up trap to cleanup on script exit
# trap cleanup EXIT INT TERM

wait_for_http \
    "toolshed" "http://localhost:$TOOLSHED_PORT/_health" \
    "$TOOLSHED_PID" "$TOOLSHED_LOG"

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

    echo "  Toolshed is ready."

    # Start the background service directly (not via deno task, for reliable PID tracking)
    cd "$SCRIPT_DIR/../packages/background-charm-service"
    OPERATOR_PASS="implicit trust" API_URL="http://localhost:$TOOLSHED_PORT" \
        deno run -A --unstable-worker-options src/main.ts \
        > "$BG_LOG" 2>&1 &
    BG_PID=$!
    cd "$SCRIPT_DIR/.."
    sleep 2
    ensure_process_running "background service" "$BG_PID" "$BG_LOG"

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

if [[ "$KEEP_ALIVE" == "true" ]]; then
    echo ""
    echo "Codex detected; keeping this command attached so Codex does not clean up the dev servers."
    echo "Stop this command or run ./scripts/stop-local-dev.sh from another shell to stop them."
    wait "$SHELL_PID" "$TOOLSHED_PID"
fi
