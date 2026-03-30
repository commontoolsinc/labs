#!/usr/bin/env bash
set -e
shopt -s extglob nullglob

DENO_VERSION_MIN="2.6.0"
DENO_VERSION_MAX="2.8.0"
# This is more portable than parsing `deno --version`
DENO_VERSION=$(echo "console.log(Deno.version.deno)" | deno run -)
IFS='.' read -r DENO_MAJOR DENO_MINOR DENO_PATCH <<<"${DENO_VERSION}"
if [[ ! "${DENO_MAJOR}" =~ ^[0-9]+$ || ! "${DENO_MINOR}" =~ ^[0-9]+$ || ! "${DENO_PATCH}" =~ ^[0-9]+$ ]]; then
  echo "ERROR: Unexpected Deno version format: ${DENO_VERSION}"
  exit 1
fi

if (( DENO_MAJOR != 2 || DENO_MINOR < 6 || DENO_MINOR >= 8 )); then
  echo "ERROR: Deno version is ${DENO_VERSION}, expected >= ${DENO_VERSION_MIN} and < ${DENO_VERSION_MAX}."
  exit 1
fi

# Figure out the symlink-resolved program name and directory.
cmdName="$(readlink -f "$0")" || exit "$?"
cmdDir="${cmdName%/*}"
cmdName="${cmdName##*/}"
baseDir="${cmdDir%/*}" # Parent of `cmdDir`, repo root in this case.

# Switch to the root of the project, so that this script can be called when
# `cd`ed anywhere. This is especially useful because the LLM agents often like
# to do `git commit` (which triggers this) in a project subdirectory.
cd "${baseDir}"

# Collect all paths to check. Glob patterns will be expanded by bash.
FILES_TO_CHECK=()

# Directory paths (no glob expansion needed)
DIRS=(
  "packages/api"
  "packages/background-charm-service"
  "packages/piece"
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
FILES_TO_CHECK+=(deprecated-patterns/[!_]*.ts*)
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

if (( ${#FILES_TO_CHECK[@]} == 0 )); then
    # This can happen if the repo ends up in a very weird state, but it _can_
    # happen!
    echo 1>&2 "${cmdName}:" 'No files to check?! (Project is in an odd state.)'
    exit 1
fi

echo "Type checking ${#FILES_TO_CHECK[@]} paths..."

reloadArg=()
if [[ "${GITHUB_ACTION}" != '' ]]; then
    echo 'Running in a CI environment; rechecking from scratch...'
    reloadArg=(--reload)
fi

DENO_V8_FLAGS="--max-old-space-size=8192" deno check "${reloadArg[@]}" "${FILES_TO_CHECK[@]}"

echo "Type check complete."
