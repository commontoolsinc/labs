#!/usr/bin/env bash

set -euxo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)
pushd $SCRIPT_DIR

cargo build --release --target wasm32-wasi

pushd ../../target/wasm32-wasi/release

if [[ ! -f ./wasi_snapshot_preview1_reactor.wasm ]]; then
  wget https://github.com/bytecodealliance/wasmtime/releases/download/v20.0.2/wasi_snapshot_preview1.reactor.wasm
fi

wasm-tools component new \
  ./usuba_compat.wasm \
  -o usuba_compat.component.wasm \
  --adapt ./wasi_snapshot_preview1.reactor.wasm

jco transpile --tla-compat ./usuba_compat.component.wasm  \
  -o ./usuba_compat

popd
popd