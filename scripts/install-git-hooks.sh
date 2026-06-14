#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "${repo_root}"

if [[ ! -f ".githooks/pre-commit" ]]; then
  echo "Missing .githooks/pre-commit" >&2
  exit 1
fi

chmod +x .githooks/pre-commit
git config core.hooksPath .githooks

echo "Configured Git hooks path: $(git config --get core.hooksPath)"
