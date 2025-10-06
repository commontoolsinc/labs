#!/usr/bin/env bash

# Start toolshed server in background
echo "Starting toolshed server..."
cd /app/labs/packages/toolshed && deno task dev &
TOOLSHED_PID=$!

# Start shell server in background
echo "Starting shell server..."
cd /app/labs/packages/shell && deno task dev-local &
SHELL_PID=$!

# Function to handle shutdown
cleanup() {
    echo "Shutting down servers..."
    kill $TOOLSHED_PID $SHELL_PID 2>/dev/null
    exit 0
}

# Set up signal handlers
trap cleanup SIGTERM SIGINT

# Keep the script running and show logs
echo "Servers started. Press Ctrl+C to stop."
echo "Toolshed PID: $TOOLSHED_PID"
echo "Shell PID: $SHELL_PID"

# Wait for both processes
wait $TOOLSHED_PID $SHELL_PID
