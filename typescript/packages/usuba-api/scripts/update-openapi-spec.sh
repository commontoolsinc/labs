#!/usr/bin/env bash

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)

set -euo pipefail

pushd $SCRIPT_DIR/../../../

docker compose up -d --build

popd
pushd $SCRIPT_DIR/../

curl http://localhost:8080/openapi.json | jq -r > ./openapi.json

