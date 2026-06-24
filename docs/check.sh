#!/bin/sh
# Type-checks the code blocks embedded in the Markdown docs. See docs/check.ts
# for how blocks opt into a context. Pass an optional subfolder to limit the run.
DOCS_DIR="$(cd "$(dirname "$0")" && pwd)"
exec deno run --allow-read --allow-write --allow-run --allow-env \
  "${DOCS_DIR}/check.ts" "$@"
