#!/usr/bin/env bash

deno check \
  packages/background-charm-service \
  packages/builder \
  packages/charm \
  packages/cli \
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
