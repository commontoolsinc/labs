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
  packages/background-charm-service \
  packages/builder \
  packages/charm \
  packages/cli/*.ts \
  packages/cli/test \
  packages/cli/commands \
  packages/deno-web-test \
  packages/html \
  packages/identity \
  packages/iframe-sandbox \
  packages/integration \
  packages/js-runtime \
  packages/jumble \
  packages/llm \
  packages/memory \
  packages/runner \
  packages/seeder \
  packages/static/*.ts \
  packages/static/scripts \
  packages/static/test \
  packages/toolshed \
  packages/ui \
  packages/utils
