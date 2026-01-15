#!/usr/bin/env bash
set -e

DENO_VERSIONS_ALLOWED=("2.5.2" "2.6.4")
# This is more portable than parsing `deno --version`
DENO_VERSION=$(echo "console.log(Deno.version.deno)" | deno run -)
if [[ ! " ${DENO_VERSIONS_ALLOWED[@]} " =~ " ${DENO_VERSION} " ]]; then
  echo "ERROR: Deno version is $DENO_VERSION, expected one of: ${DENO_VERSIONS_ALLOWED[*]}."
  exit 1
fi

deno check tasks/*.ts
deno check recipes/[!_]*.ts*

# TODO(runtime-worker-refactor):
# Ignore ct-outliner until re-added
deno check packages/ui/src/v2/components/*[!outliner]/*.ts*

deno check \
  packages/api \
  packages/background-charm-service \
  packages/charm \
  packages/cli/*.ts \
  packages/cli/test \
  packages/cli/commands \
  packages/deno-web-test \
  packages/html \
  packages/identity \
  packages/iframe-sandbox \
  packages/integration \
  packages/js-compiler \
  packages/llm \
  packages/memory \
  packages/patterns/*.ts \
  packages/patterns/*.tsx \
  packages/patterns/battleship \
  packages/patterns/budget-tracker \
  packages/patterns/contacts \
  packages/patterns/deprecated \
  packages/patterns/examples \
  packages/patterns/gideon-tests \
  packages/patterns/google \
  packages/patterns/integration \
  packages/patterns/notes \
  packages/patterns/record \
  packages/patterns/scrabble \
  packages/patterns/system \
  packages/patterns/test \
  packages/patterns/weekly-calendar \
  packages/runner \
  packages/runtime-client \
  packages/seeder \
  packages/shell \
  packages/static/*.ts \
  packages/static/scripts \
  packages/static/test \
  packages/toolshed \
  packages/utils
