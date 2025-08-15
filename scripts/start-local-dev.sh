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

# check if port 8000 + 5173 are free
# if not, throw error or kill processes if force flag is set
check_port() {
    local port=$1
    local pids=$(lsof -Pi :$port -sTCP:LISTEN -t 2>/dev/null)
    if [[ -n "$pids" ]]; then
        if [[ "$FORCE" == "true" ]]; then
            echo "Port $port is in use, killing processes: $pids"
            kill $pids 2>/dev/null
            sleep 1
            # Check if processes are still running and force kill if needed
            local remaining_pids=$(lsof -Pi :$port -sTCP:LISTEN -t 2>/dev/null)
            if [[ -n "$remaining_pids" ]]; then
                echo "Force killing remaining processes on port $port: $remaining_pids"
                kill -9 $remaining_pids 2>/dev/null
                sleep 1
            fi
        else
            echo "Error: Port $port is already in use"
            exit 1
        fi
    fi
}

check_port 8000
check_port 5173

# Start shell dev server in background
cd packages/shell
deno task dev-local > ../../local-dev-shell.log 2>&1 &
SHELL_PID=$!

# Wait a moment for shell to start
sleep 2

# Start toolshed dev server in background
cd ../toolshed
SHELL_URL=http://localhost:5173 deno task dev > ../local-dev-toolshed.log 2>&1 &
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
