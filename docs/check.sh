#!/bin/sh
DOCS_DIR="$(cd "$(dirname "$0")" && pwd)"

# Optional subfolder argument (e.g., "concepts" or "concepts/computed")
target="${DOCS_DIR}/${1:-.}"

exit_code=0
for file in $(find "$target" -name '*.md'); do
  deno check --doc-only "$file" || exit_code=1
done
exit $exit_code
