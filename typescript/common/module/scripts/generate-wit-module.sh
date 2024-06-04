#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
cd $SCRIPT_DIR

BODY="$(</dev/stdin)"

echo "export const wit = \`$BODY\`;"

# MODULES=($(ls ../../*/wit/*.wit))

# for MODULE_PATH in "${MODULES[@]}"; do
#   EXPORT_NAME=$(echo $MODULE_PATH | sed "s/\.\.\/\.\.\/\([^\/]*\).*/\1/")
#   EXPORT_BODY=$(cat $MODULE_PATH)

#   echo "export const ${EXPORT_NAME} = \`${EXPORT_BODY}\`;
# "
# done


