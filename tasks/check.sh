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
  packages/llm \
  packages/jumble \
  packages/memory \
  packages/runner \
  packages/seeder \
  packages/toolshed \
  packages/ui \
  packages/utils
