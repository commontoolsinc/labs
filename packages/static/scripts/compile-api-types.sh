#!/usr/bin/env bash

# Runs relative to the package root when run as a deno task

SOURCE=../api/index.ts
# Using `--outFile` with tsc produces a different module wrapper
OUT=../api/index.d.ts
STATIC=./assets/types/commontools.d.ts

deno run -A npm:typescript/tsc $SOURCE --declaration --emitDeclarationOnly
mv $OUT $STATIC
