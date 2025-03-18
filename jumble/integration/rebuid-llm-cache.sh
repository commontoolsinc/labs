#!/bin/bash
set -e  # Exit on error

echo "Starting integration test environment..."

# Ensure we're at the root of the repo
if [[ "$(basename "$(pwd)")" == "integration" && "$(basename "$(dirname "$(pwd)")")" == "jumble" ]]; then
  echo "Currently in jumble/integration, moving to repo root..."
  cd ../..
elif [[ "$(basename "$(pwd)")" == "jumble" ]]; then
  echo "Currently in jumble, moving to repo root..."
  cd ..
fi

# 1. Delete existing cache
echo "Deleting existing LLM cache..."
rm -rf jumble/integration/cache/llm-api-cache
mkdir -p jumble/integration/cache/llm-api-cache

# 2. Start toolshed on port 8000
echo "Starting toolshed on port 8000..."
cd toolshed
deno run dev &
TOOLSHED_PID=$!
cd ..

# Wait for toolshed to start
echo "Waiting for toolshed to start..."
sleep 5

# 3. Start jumble on port 5173
echo "Starting jumble on port 5173..."
cd jumble
deno run dev &
JUMBLE_PID=$!
cd ..

# Wait for jumble to start
echo "Waiting for jumble to start..."
sleep 5

# 4. Run integration tests
echo "Running integration tests..."
cd jumble
deno task integration
cd ..

# 5. Copy cache files
echo "Copying LLM cache files to integration directory..."
mkdir -p integration/cache/llm-api-cache
cp -r toolshed/cache/llm-api-cache/* integration/cache/llm-api-cache/

# 6. Clean up processes
echo "Cleaning up processes..."
kill $TOOLSHED_PID
kill $JUMBLE_PID

# 7. Print report and status
echo "==============================================="
echo "Integration test run complete!"
echo "Cache files have been copied to integration/cache/llm-api-cache"
echo "==============================================="
echo "Git status:"
git status

echo "Done!"
