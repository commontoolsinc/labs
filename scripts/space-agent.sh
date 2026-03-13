#!/usr/bin/env bash
# space-agent.sh — Launcher for the space scanning agent.
#
# Invokes Claude Code non-interactively to scan a FUSE-mounted Common Tools
# space, fulfill @wish annotations in note content, and update the audit log.
#
# Usage:
#   ./scripts/space-agent.sh
#
# Environment variables (all optional except CT_IDENTITY):
#   CT_MOUNT     — FUSE mount path          (default: /tmp/ct)
#   CT_SPACE     — Space name to scan       (default: home)
#   CT_API_URL   — Toolshed URL             (default: http://localhost:8000)
#   CT_IDENTITY  — Path to identity key     (required; auto-detected from ~/.ct/ if unset)

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve environment variables with defaults
# ---------------------------------------------------------------------------
CT_MOUNT="${CT_MOUNT:-/tmp/ct}"
CT_SPACE="${CT_SPACE:-home}"
CT_API_URL="${CT_API_URL:-http://localhost:8000}"

# Auto-detect CT_IDENTITY if not set: pick the first .pem or key file in ~/.ct/
if [[ -z "${CT_IDENTITY:-}" ]]; then
  detected=$(find "${HOME}/.ct" -maxdepth 1 -type f \( -name "*.pem" -o -name "*.key" -o -name "identity" \) 2>/dev/null | head -n 1 || true)
  if [[ -n "$detected" ]]; then
    CT_IDENTITY="$detected"
    echo "Auto-detected identity: $CT_IDENTITY"
  fi
fi

# Export so the Claude Code subprocess inherits them
export CT_MOUNT CT_SPACE CT_API_URL CT_IDENTITY

# ---------------------------------------------------------------------------
# Validation checks
# ---------------------------------------------------------------------------

# 1. CT_MOUNT directory must exist
if [[ ! -d "$CT_MOUNT" ]]; then
  echo "Error: CT_MOUNT directory does not exist: $CT_MOUNT" >&2
  echo "  Is the FUSE filesystem set up? Try: ct fuse mount $CT_MOUNT" >&2
  exit 1
fi

# 2. Pieces directory must be accessible (confirms FUSE is mounted + space connected)
PIECES_PATH="$CT_MOUNT/$CT_SPACE/pieces"
if [[ ! -d "$PIECES_PATH" ]]; then
  echo "Error: Space pieces directory not accessible: $PIECES_PATH" >&2
  echo "  Is the FUSE mount active and space '$CT_SPACE' connected?" >&2
  echo "  Try: ls $CT_MOUNT/$CT_SPACE/ to trigger auto-connect" >&2
  exit 1
fi

# 3. CT_IDENTITY must be set and the file must exist
if [[ -z "${CT_IDENTITY:-}" ]]; then
  echo "Error: CT_IDENTITY is not set and could not be auto-detected from ~/.ct/" >&2
  echo "  Set it explicitly: export CT_IDENTITY=/path/to/identity.pem" >&2
  exit 1
fi
if [[ ! -f "$CT_IDENTITY" ]]; then
  echo "Error: CT_IDENTITY file does not exist: $CT_IDENTITY" >&2
  exit 1
fi

# 4. claude CLI must be available
if ! command -v claude &>/dev/null; then
  echo "Error: 'claude' CLI not found in PATH" >&2
  echo "  Install Claude Code: https://claude.ai/code" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Resolve paths
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEM_PROMPT_FILE="$SCRIPT_DIR/space-agent-prompt.md"

if [[ ! -f "$SYSTEM_PROMPT_FILE" ]]; then
  echo "Error: System prompt file not found: $SYSTEM_PROMPT_FILE" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Launch
# ---------------------------------------------------------------------------
echo "Scanning space '$CT_SPACE' at $CT_MOUNT..."
echo "  Toolshed: $CT_API_URL"
echo "  Identity: $CT_IDENTITY"
echo ""

claude \
  --model sonnet \
  --system-prompt "$(cat "$SYSTEM_PROMPT_FILE")" \
  --allowedTools "Bash" \
  --allowedTools "WebSearch" \
  --allowedTools "WebFetch" \
  --allowedTools "Read" \
  --allowedTools "Glob" \
  --allowedTools "Grep" \
  --allowedTools "Write" \
  --allowedTools "Edit" \
  --verbose \
  --output-format stream-json \
  -p "Scan the space at $CT_MOUNT/$CT_SPACE now. Find all @wish annotations and wishable items in note content, fulfill them, and update the audit log."
