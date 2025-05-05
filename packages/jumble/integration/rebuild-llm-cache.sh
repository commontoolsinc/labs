#!/bin/bash
set -e  # Exit on error

# Function to clean up processes
cleanup() {
  echo "Cleaning up processes..."
  if [ ! -z "$TOOLSHED_PID" ]; then
    kill $TOOLSHED_PID 2>/dev/null || true
  fi
  if [ ! -z "$JUMBLE_PID" ]; then
    kill $JUMBLE_PID 2>/dev/null || true
  fi
}

# Set up trap to call cleanup on script exit (success or failure)
trap cleanup EXIT

echo "Starting integration test environment..."

# Ensure we're at the root of the repo
if [[ "$(basename "$(pwd)")" == "integration" && "$(basename "$(dirname "$(pwd)")")" == "jumble" ]]; then
  echo "Currently in jumble/integration, moving to repo root..."
  cd ../..
elif [[ "$(basename "$(pwd)")" == "jumble" ]]; then
  echo "Currently in jumble, moving to repo root..."
  cd ..
fi

#1. Create temp cache directory
echo "Creating temp cache directory..."
TEMP_CACHE_DIR=$(mktemp -d)

# 2. Start toolshed on port 8000
echo "Starting toolshed on port 8000..."
cd toolshed
CACHE_DIR=$TEMP_CACHE_DIR deno run dev &
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

echo "List of fresh llm cache artifacts:"
ls -la $TEMP_CACHE_DIR/llm-api-cache

# Ensure target directory exists
mkdir -p jumble/integration/cache/llm-api-cache

# Copy files from temp cache to integration cache
cp -r $TEMP_CACHE_DIR/llm-api-cache/* jumble/integration/cache/llm-api-cache/

# Verify files were copied
echo "Verifying copied files:"
ls -la jumble/integration/cache/llm-api-cache/

# 6. Print report and status
echo "==============================================="
echo "Integration test run complete!"
echo "Cache files have been copied to integration/cache/llm-api-cache"
echo "==============================================="
echo "Git status:"
git status

echo "Done!"
