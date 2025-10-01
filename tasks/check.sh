#!/usr/bin/env bash
set -e

DENO_VERSIONS_ALLOWED=("2.5.2" "2.4.5")
# This is more portable than parsing `deno --version`
DENO_VERSION=$(echo "console.log(Deno.version.deno)" | deno run -)
if [[ ! " ${DENO_VERSIONS_ALLOWED[@]} " =~ " ${DENO_VERSION} " ]]; then
  echo "ERROR: Deno version is $DENO_VERSION, expected one of: ${DENO_VERSIONS_ALLOWED[*]}."
  exit 1
fi

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
  packages/js-runtime/mod.ts \
  packages/js-runtime/interface.ts \
  packages/js-runtime/program.ts \
  packages/js-runtime/source-map.ts \
  packages/js-runtime/utils.ts \
  packages/js-runtime/runtime \
  packages/js-runtime/typescript \
  packages/js-runtime/test/*.ts \
  packages/llm \
  packages/memory \
  packages/patterns \
  packages/runner \
  packages/seeder \
  packages/shell \
  packages/static/*.ts \
  packages/static/scripts \
  packages/static/test \
  packages/toolshed \
  packages/ui \
  packages/utils
