#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$SCRIPT_DIR"

TSC="${SCRIPT_DIR}/../../../node_modules/.deno/typescript@5.8.3/node_modules/typescript/bin/tsc"
CONFIGS=(
  tsconfig.baseline.json
  tsconfig.key.json
  tsconfig.anycell.json
  tsconfig.schema.json
  tsconfig.ikeyable-cell.json
  tsconfig.ikeyable-schema.json
  tsconfig.ikeyable-realistic.json
)

for config in "${CONFIGS[@]}"; do
  echo "# ${config}"
  output=$(${TSC} --project "${config}" --extendedDiagnostics --pretty false)
  echo "$output"
  echo "$output" | awk '/Instantiations:/ { sub(/^[^0-9]* /, ""); print "Instantiations: " $1 } /Check time:/ { print }'
  echo "----------------------------------------"
  echo
  sleep 0.1
done
