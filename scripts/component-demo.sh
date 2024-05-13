#!/usr/bin/env bash

set -euo pipefail

NEEDED_TOOLS=(
  cargo \
  deno \
  node \
  npm \
  wasm-tools \
  jco
)

for TOOL in "${NEEDED_TOOLS[@]}"; do
  if ! command -v $TOOL &> /dev/null; then
    echo "$TOOL could not be found; did you install it?"
    exit 1
  fi
done

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)

pushd $SCRIPT_DIR/../

echo "
=== TRIVIAL RUST PROGRAM ===
"

cargo run -p example-crate

./rust/example-crate/build-wasm-component.sh &> /dev/null

pushd ./typescript/packages/example-package

npm ci &> /dev/null
npm run build &> /dev/null

echo "
=== RUST -> WASM COMPONENT -> DENO ===
"

npm run deno

echo "
=== RUST -> WASM COMPONENT -> BROWSER ===
"

npm run serve -- --open

popd
popd