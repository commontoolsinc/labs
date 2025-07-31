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
  cd ../../..
elif [[ "$(basename "$(pwd)")" == "jumble" ]]; then
  echo "Currently in jumble, moving to repo root..."
  cd ../..
elif [[ "$(basename "$(pwd)")" == "packages" ]]; then
  echo "Currently in packages, moving to repo root..."
  cd ..
fi

# Verify we're at the root
if [ ! -d "packages/toolshed" ]; then
  echo "ERROR: Not at repo root. Expected to find packages/toolshed"
  echo "Current directory: $(pwd)"
  exit 1
fi

#1. Create temp cache directory
echo "Creating temp cache directory..."
TEMP_CACHE_DIR=$(mktemp -d)

# 2. Start toolshed on port 8000
echo "Starting toolshed on port 8000..."
cd packages/toolshed
CACHE_DIR=$TEMP_CACHE_DIR deno task dev &
TOOLSHED_PID=$!
cd ../..

# Wait for toolshed to start
echo "Waiting for toolshed to start..."
sleep 5

# 3. Start jumble on port 5173
echo "Starting jumble on port 5173..."
cd packages/jumble
deno task dev-local &
JUMBLE_PID=$!
cd ../..

# Wait for jumble to start
echo "Waiting for jumble to start..."
sleep 5

# 4. Run integration tests
echo "Running integration tests..."
cd packages/jumble
# Pass CACHE_DIR to integration tests so they use the same cache
CACHE_DIR=$TEMP_CACHE_DIR API_URL=http://localhost:8000/ FRONTEND_URL=http://localhost:8000/ deno task integration
cd ../..

# 5. Copy cache files
echo "Copying LLM cache files to integration directory..."

# Check if the cache directory was created
if [ -d "$TEMP_CACHE_DIR/llm-api-cache" ]; then
  echo "List of fresh llm cache artifacts:"
  ls -la $TEMP_CACHE_DIR/llm-api-cache
  
  # Ensure target directory exists
  mkdir -p packages/jumble/integration/cache/llm-api-cache
  
  # Copy files from temp cache to integration cache
  cp -r $TEMP_CACHE_DIR/llm-api-cache/* packages/jumble/integration/cache/llm-api-cache/
  
  # Verify files were copied
  echo "Verifying copied files:"
  ls -la packages/jumble/integration/cache/llm-api-cache/
else
  echo "WARNING: No cache directory found at $TEMP_CACHE_DIR/llm-api-cache"
  echo "This might mean the LLM tests were skipped or didn't generate cache"
fi

# 6. Print report and status
echo "==============================================="
echo "Integration test run complete!"
if [ -d "$TEMP_CACHE_DIR/llm-api-cache" ]; then
  echo "Cache files have been copied to packages/jumble/integration/cache/llm-api-cache"
else
  echo "No LLM cache files were generated during this run"
fi
echo "==============================================="
echo "Git status:"
git status

echo "Done!"
