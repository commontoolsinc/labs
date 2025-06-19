#!/usr/bin/env bash

# Runs relative to the package root when run as a deno task

SOURCE=../api/index.ts
# Using `--outFile` with tsc produces a different module wrapper
OUT=../api/index.d.ts
STATIC=./assets/types/commontools.d.ts

# When running in CI, we need to specific libs
deno run -A npm:typescript/tsc $SOURCE --declaration --emitDeclarationOnly --lib esnext,dom
mv $OUT $STATIC
