#!/usr/bin/env bash
set -e
shopt -s extglob nullglob

# Figure out the symlink-resolved program name and directory.
cmdName="$(readlink -f "$0")" || exit "$?"
cmdDir="${cmdName%/*}"
cmdName="${cmdName##*/}"
baseDir="${cmdDir%/*}" # Parent of `cmdDir`, repo root in this case.

# Switch to the root of the project, so that this script can be called when
# `cd`ed anywhere. This is especially useful because the LLM agents often like
# to do `git commit` (which triggers this) in a project subdirectory.
cd "${baseDir}"

# The exact Deno version for this repository is pinned in mise.toml, which mise
# installs (see README.md). A run under any other version stops before
# checking: different Deno versions carry different TypeScript compilers,
# which can return different verdicts on one tree, and an off-pin verdict is
# not the verdict this check exists to report. DENO_CHECK_VERSION_LENIENT=1
# accepts an off-pin version inside the range below; the mismatch is then
# reported again after the diagnostics, where it is the last thing on screen.
# tasks/check-deno-pins.ts verifies that the range contains the pin.
DENO_VERSION_MIN="2.8.0"
DENO_VERSION_MAX="2.10.0"
if [[ ! -f mise.toml ]]; then
  # Checked before the read: `set -e` would otherwise abort on sed's exit
  # status with only sed's own message.
  echo "ERROR: mise.toml not found; cannot read the pinned Deno version."
  exit 1
fi
DENO_PINS="$(sed -n 's/^deno = "\([^"]*\)"$/\1/p' mise.toml)"
# Counted rather than taking the first: TOML rejects a key defined twice, so a
# second pin means mise cannot load the file, and reading past it would report
# a version no developer actually gets.
DENO_PIN_COUNT="$(printf '%s' "${DENO_PINS}" | grep -c . || true)"
if (( DENO_PIN_COUNT == 0 )); then
  echo "ERROR: Could not read the pinned Deno version from mise.toml."
  exit 1
fi
if (( DENO_PIN_COUNT > 1 )); then
  echo "ERROR: mise.toml defines the Deno pin ${DENO_PIN_COUNT} times; TOML rejects a key defined twice, so mise cannot load it."
  exit 1
fi
DENO_VERSION_PINNED="${DENO_PINS}"
# This is more portable than parsing `deno --version`
DENO_VERSION=$(echo "console.log(Deno.version.deno)" | deno run -)
IFS='.' read -r DENO_MAJOR DENO_MINOR DENO_PATCH <<<"${DENO_VERSION}"
if [[ ! "${DENO_MAJOR}" =~ ^[0-9]+$ || ! "${DENO_MINOR}" =~ ^[0-9]+$ || ! "${DENO_PATCH}" =~ ^[0-9]+$ ]]; then
  echo "ERROR: Unexpected Deno version format: ${DENO_VERSION}"
  exit 1
fi

# Maps a MAJOR.MINOR.PATCH version to a single integer for range comparison.
# Components are read as base-10 and must be below 1000.
version_num() {
  local major minor patch
  IFS='.' read -r major minor patch <<<"$1"
  echo $(( (10#${major} * 1000 + 10#${minor}) * 1000 + 10#${patch} ))
}

if (( $(version_num "${DENO_VERSION}") < $(version_num "${DENO_VERSION_MIN}") ||
      $(version_num "${DENO_VERSION}") >= $(version_num "${DENO_VERSION_MAX}") )); then
  echo "ERROR: Deno version is ${DENO_VERSION}, expected >= ${DENO_VERSION_MIN} and < ${DENO_VERSION_MAX}."
  exit 1
fi

if [[ "${DENO_VERSION}" != "${DENO_VERSION_PINNED}" ]]; then
  if [[ "${DENO_CHECK_VERSION_LENIENT:-}" == '' ]]; then
    echo "ERROR: Deno version is ${DENO_VERSION}; this repository pins ${DENO_VERSION_PINNED} (mise.toml)."
    echo "ERROR: An off-pin toolchain can pass code the pin refuses, and refuse code the pin passes."
    echo "ERROR: Install the pin with mise <https://mise.jdx.dev/> and 'mise install', then run"
    echo "ERROR: 'mise exec -- deno task check'; or set DENO_CHECK_VERSION_LENIENT=1 to accept"
    echo "ERROR: an off-pin verdict."
    exit 1
  fi
  echo "WARNING: Deno version is ${DENO_VERSION}; this repository pins ${DENO_VERSION_PINNED} (mise.toml)."
  echo "WARNING: DENO_CHECK_VERSION_LENIENT is set, so the check runs anyway."
  # Repeated when the run ends, pass or fail: the lines above scroll away
  # behind one Check line per module, and the verdict's provenance belongs
  # next to the verdict.
  version_mismatch_reminder() {
    echo "WARNING: This check ran under Deno ${DENO_VERSION}, not the pinned ${DENO_VERSION_PINNED}."
  }
  trap version_mismatch_reminder EXIT
fi

# Collect all paths to check. Glob patterns will be expanded by bash.
#
# This list is the single type-checking point for the paths it names: the CI
# test jobs and the package test tasks that cover these paths run
# `deno test --no-check` and rely on this script (via the Check job's
# "Type check codebase" step) for type safety. Before adding --no-check to a
# test invocation, make sure every file it loads is under a path listed here.
# Removing a path from this list removes its type checking entirely.
FILES_TO_CHECK=()

# Directory paths (no glob expansion needed)
DIRS=(
  "packages/api"
  "packages/background-piece-service"
  "packages/cli/commands"
  "packages/cli/lib"
  "packages/cli/support"
  "packages/cli/test"
  "packages/deno-web-test"
  "packages/html"
  "packages/identity"
  "packages/iframe-sandbox"
  "packages/integration"
  "packages/js-compiler"
  "packages/llm"
  "packages/memory"
  "packages/patterns/battleship"
  "packages/patterns/budget-tracker"
  "packages/patterns/contacts"
  "packages/patterns/examples"
  "packages/patterns/gideon-tests"
  "packages/patterns/google/core/integration"
  "packages/patterns/google/core/util"
  "packages/patterns/integration"
  "packages/patterns/notes"
  "packages/patterns/record"
  "packages/patterns/scrabble"
  "packages/patterns/system"
  "packages/patterns/test"
  "packages/patterns/tools"
  "packages/patterns/weekly-calendar"
  "packages/piece"
  "packages/runner"
  "packages/runtime-client"
  "packages/shell"
  "packages/static/scripts"
  "packages/static/test"
  "packages/toolshed"
  "packages/ts-transformers/src"
  "packages/utils"
)

FILES_TO_CHECK+=("${DIRS[@]}")

# Glob patterns - bash expands these with nullglob set
FILES_TO_CHECK+=(tasks/*.ts)
FILES_TO_CHECK+=(scripts/*.ts)
FILES_TO_CHECK+=(packages/ui/src/v2/components/*[!outliner]/*.ts*)
FILES_TO_CHECK+=(packages/cli/*.ts)
FILES_TO_CHECK+=(packages/static/*.ts)
FILES_TO_CHECK+=(packages/patterns/*.ts)
FILES_TO_CHECK+=(packages/patterns/*.tsx)

while IFS= read -r testFile; do
  FILES_TO_CHECK+=("${testFile}")
done < <(find packages/ts-transformers/test -type f -name '*.test.ts' -print)

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
if [[ "${DENO_CHECK_RELOAD:-}" != '' ]]; then
    echo 'Reloading Deno dependencies before checking...'
    reloadArg=(--reload)
fi

DENO_V8_FLAGS="--max-old-space-size=8192" deno check "${reloadArg[@]}" "${FILES_TO_CHECK[@]}"

echo "Type check complete."
