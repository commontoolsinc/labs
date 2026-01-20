#!/usr/bin/env bash
set -e
shopt -s extglob

DENO_VERSIONS_ALLOWED=("2.5.2" "2.6.4")
# This is more portable than parsing `deno --version`
DENO_VERSION=$(echo "console.log(Deno.version.deno)" | deno run -)
if [[ ! " ${DENO_VERSIONS_ALLOWED[@]} " =~ " ${DENO_VERSION} " ]]; then
  echo "ERROR: Deno version is $DENO_VERSION, expected one of: ${DENO_VERSIONS_ALLOWED[*]}."
  exit 1
fi

# Function to check a path (handles globs via eval)
check_path() {
  echo "Checking: $1"
  eval "deno check $1"
}

# All paths to check
PATHS=(
  "tasks/*.ts"
  "recipes/[!_]*.ts*"
  "packages/ui/src/v2/components/*[!outliner]/*.ts*"
  "packages/api"
  "packages/background-charm-service"
  "packages/charm"
  "packages/cli/*.ts"
  "packages/cli/test"
  "packages/cli/commands"
  "packages/deno-web-test"
  "packages/html"
  "packages/identity"
  "packages/iframe-sandbox"
  "packages/integration"
  "packages/js-compiler"
  "packages/llm"
  "packages/memory"
  "packages/runner"
  "packages/runtime-client"
  "packages/seeder"
  "packages/shell"
  "packages/static/*.ts"
  "packages/static/scripts"
  "packages/static/test"
  "packages/toolshed"
  "packages/utils"
  "packages/patterns/*.ts"
  "packages/patterns/*.tsx"
  "packages/patterns/battleship"
  "packages/patterns/budget-tracker"
  "packages/patterns/contacts"
  "packages/patterns/examples"
  "packages/patterns/gideon-tests"
  "packages/patterns/integration"
  "packages/patterns/notes"
  "packages/patterns/record"
  "packages/patterns/scrabble"
  "packages/patterns/system"
  "packages/patterns/test"
  "packages/patterns/weekly-calendar"
  "packages/patterns/google/util"
  "packages/patterns/google/integration"
)

# Check each path separately
for path in "${PATHS[@]}"; do
  check_path "$path"
done

# Google patterns are checked individually to avoid TypeScript exhaustion
# due to their large file sizes
echo "Checking google patterns individually..."
for file in packages/patterns/google/*.ts packages/patterns/google/*.tsx; do
  if [[ -f "$file" ]]; then
    check_path "$file"
  fi
done
