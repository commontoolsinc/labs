#!/usr/bin/env bash
# profile-reflect.sh — Profile reflection agent.
#
# Reads the space's audit log, wish queue, and note content, then updates
# the user profile with observations about preferences and patterns.
#
# Run this after one or more scan-agent runs to build up the profile.
#
# Usage:
#   ./scripts/profile-reflect.sh
#
# Environment variables:
#   CT_MOUNT     — FUSE mount path          (default: /tmp/ct)
#   CT_SPACE     — Space name to read       (default: home)
#   CT_API_URL   — Toolshed URL             (default: http://localhost:8000)
#   CT_IDENTITY  — Path to identity key     (required; auto-detected from ~/.ct/)

set -euo pipefail

CT_MOUNT="${CT_MOUNT:-/tmp/ct}"
CT_SPACE="${CT_SPACE:-home}"
CT_API_URL="${CT_API_URL:-http://localhost:8000}"

if [[ -z "${CT_IDENTITY:-}" ]]; then
  detected=$(find "${HOME}/.ct" -maxdepth 1 -type f \( -name "*.pem" -o -name "*.key" -o -name "identity" \) 2>/dev/null | head -n 1 || true)
  if [[ -n "$detected" ]]; then
    CT_IDENTITY="$detected"
    echo "Auto-detected identity: $CT_IDENTITY"
  fi
fi

export CT_MOUNT CT_SPACE CT_API_URL CT_IDENTITY

# Validation
if [[ ! -d "$CT_MOUNT" ]]; then
  echo "Error: CT_MOUNT directory does not exist: $CT_MOUNT" >&2
  exit 1
fi

if [[ ! -d "$CT_MOUNT/$CT_SPACE/pieces" ]]; then
  echo "Error: Space not accessible: $CT_MOUNT/$CT_SPACE/pieces" >&2
  exit 1
fi

if [[ -z "${CT_IDENTITY:-}" ]]; then
  echo "Error: CT_IDENTITY not set" >&2
  exit 1
fi

if ! command -v claude &>/dev/null; then
  echo "Error: 'claude' CLI not found" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT_FILE="$SCRIPT_DIR/profile-reflect-prompt.md"

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "Error: Prompt file not found: $PROMPT_FILE" >&2
  exit 1
fi

echo "Reflecting on space '$CT_SPACE' to update profile..."
echo ""

claude \
  --model sonnet \
  --system-prompt "$(cat "$PROMPT_FILE")" \
  --allowedTools "Bash" \
  --allowedTools "Read" \
  --allowedTools "Glob" \
  --allowedTools "Grep" \
  --verbose \
  --output-format stream-json \
  -p "Read the audit log, wish queue, and note content in $CT_MOUNT/$CT_SPACE, then update the user profile in the home space with any new observations."
