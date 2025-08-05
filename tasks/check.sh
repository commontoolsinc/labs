#!/usr/bin/env bash
set -e

DENO_VERSION_REQUIRED="2.3.5"
# This is more portable than parsing `deno --version`
DENO_VERSION=$(echo "console.log(Deno.version.deno)" | deno run -)
if [ "$DENO_VERSION" != "$DENO_VERSION_REQUIRED" ]; then
  echo "ERROR: Deno version is $DENO_VERSION, expected $DENO_VERSION_REQUIRED."
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
  packages/jumble \
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
