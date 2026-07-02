#!/usr/bin/env bash
set -euo pipefail

deno lint

(
  cd packages/generated-patterns
  deno lint .
)

(
  cd packages/js-compiler
  deno lint .
)

(
  cd packages/ts-transformers
  deno lint src/ test/
)
