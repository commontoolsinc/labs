#!/usr/bin/env bash
set -e
shopt -s extglob nullglob

DENO_VERSIONS_ALLOWED=("2.5.2" "2.6.4")
# This is more portable than parsing `deno --version`
DENO_VERSION=$(echo "console.log(Deno.version.deno)" | deno run -)
if [[ ! " ${DENO_VERSIONS_ALLOWED[@]} " =~ " ${DENO_VERSION} " ]]; then
  echo "ERROR: Deno version is $DENO_VERSION, expected one of: ${DENO_VERSIONS_ALLOWED[*]}."
  exit 1
fi

# Collect all paths to check. Glob patterns will be expanded by bash.
FILES_TO_CHECK=()

# Directory paths (no glob expansion needed)
DIRS=(
  "packages/api"
  "packages/background-charm-service"
  "packages/charm"
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
  "packages/static/scripts"
  "packages/static/test"
  "packages/toolshed"
  "packages/utils"
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
  "packages/patterns/google/core/util"
  "packages/patterns/google/core/integration"
)

FILES_TO_CHECK+=("${DIRS[@]}")

# Glob patterns - bash expands these with nullglob set
FILES_TO_CHECK+=(tasks/*.ts)
FILES_TO_CHECK+=(recipes/[!_]*.ts*)
FILES_TO_CHECK+=(packages/ui/src/v2/components/*[!outliner]/*.ts*)
FILES_TO_CHECK+=(packages/cli/*.ts)
FILES_TO_CHECK+=(packages/static/*.ts)
FILES_TO_CHECK+=(packages/patterns/*.ts)
FILES_TO_CHECK+=(packages/patterns/*.tsx)

# Google patterns (previously checked individually to avoid OOM, now included
# with increased heap limit)
FILES_TO_CHECK+=(packages/patterns/google/core/*.ts)
FILES_TO_CHECK+=(packages/patterns/google/core/*.tsx)
FILES_TO_CHECK+=(packages/patterns/google/core/experimental/*.ts)
FILES_TO_CHECK+=(packages/patterns/google/core/experimental/*.tsx)
FILES_TO_CHECK+=(packages/patterns/google/extractors/*.ts)
FILES_TO_CHECK+=(packages/patterns/google/extractors/*.tsx)
FILES_TO_CHECK+=(packages/patterns/google/WIP/*.ts)
FILES_TO_CHECK+=(packages/patterns/google/WIP/*.tsx)

echo "Type checking ${#FILES_TO_CHECK[@]} paths..."
deno check --reload "${FILES_TO_CHECK[@]}"
echo "Type check complete."
