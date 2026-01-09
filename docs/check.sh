#!/bin/sh
cd "$(dirname "$0")"

exit_code=0
for file in $(find . -name '*.md'); do
  deno check --doc-only "$file" || exit_code=1
done
exit $exit_code
