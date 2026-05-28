#!/bin/bash
# Script: Content Capture Workflow
# Purpose: Capture page metadata, structure, and text to stdout.

set -euo pipefail

SCRIPT_NAME="${SKILL_SCRIPT:-scripts/capture-workflow.sh}"
CDP="${AGENT_BROWSER_CDP:-}"
TARGET_URL=""
WAIT_LOAD="networkidle"
TEXT_TARGET="body"
SKIP_TEXT=0

usage() {
  cat <<USAGE
Usage:
  $SCRIPT_NAME --cdp <http://localhost:port> <url> [--text-target <selector-or-ref>]

Environment:
  AGENT_BROWSER_CDP  Local CDP origin, used when --cdp is omitted.

Notes:
  - The CDP endpoint must be a local http origin with an explicit port.
  - Output is written to stdout so cf-harness can capture the run artifact.
  - Screenshots, PDFs, browser state, and file downloads are intentionally
    excluded from this first-class skill script.
USAGE
}

fail() {
  echo "$SCRIPT_NAME: $*" >&2
  exit 2
}

require_value() {
  local flag="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || fail "$flag requires a value"
}

validate_cdp_endpoint() {
  local endpoint="$1"
  if [[ ! "$endpoint" =~ ^http://(localhost|127\.0\.0\.1|host\.docker\.internal):[0-9]+$ ]] &&
    [[ ! "$endpoint" =~ ^http://\[::1\]:[0-9]+$ ]]; then
    fail "--cdp must be an http:// local origin with an explicit port"
  fi

  local port="${endpoint##*:}"
  [[ "$port" =~ ^[0-9]+$ ]] || fail "--cdp port must be numeric"
  local port_number=$((10#$port))
  ((port_number >= 1 && port_number <= 65535)) ||
    fail "--cdp port must be between 1 and 65535"
}

validate_page_url() {
  case "$1" in
    http://* | https://*) ;;
    *) fail "url must be http:// or https://" ;;
  esac
}

browser() {
  agent-browser --cdp "$CDP" "$@"
}

while (($# > 0)); do
  case "$1" in
    --cdp)
      require_value "$1" "${2:-}"
      CDP="$2"
      shift 2
      ;;
    --cdp=*)
      CDP="${1#*=}"
      [[ -n "$CDP" ]] || fail "--cdp requires a value"
      shift
      ;;
    --text-target)
      require_value "$1" "${2:-}"
      TEXT_TARGET="$2"
      shift 2
      ;;
    --text-target=*)
      TEXT_TARGET="${1#*=}"
      [[ -n "$TEXT_TARGET" ]] || fail "--text-target requires a value"
      shift
      ;;
    --wait-load)
      require_value "$1" "${2:-}"
      WAIT_LOAD="$2"
      shift 2
      ;;
    --wait-load=*)
      WAIT_LOAD="${1#*=}"
      [[ -n "$WAIT_LOAD" ]] || fail "--wait-load requires a value"
      shift
      ;;
    --skip-text)
      SKIP_TEXT=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      fail "unknown option: $1"
      ;;
    *)
      [[ -z "$TARGET_URL" ]] || fail "unexpected argument: $1"
      TARGET_URL="$1"
      shift
      ;;
  esac
done

while (($# > 0)); do
  [[ -z "$TARGET_URL" ]] || fail "unexpected argument: $1"
  TARGET_URL="$1"
  shift
done

[[ -n "$TARGET_URL" ]] || {
  usage >&2
  exit 2
}
[[ -n "$CDP" ]] || fail "provide --cdp or set AGENT_BROWSER_CDP"
CDP="${CDP%/}"
validate_cdp_endpoint "$CDP"
validate_page_url "$TARGET_URL"
command -v agent-browser >/dev/null 2>&1 || fail "agent-browser is not on PATH"

echo "Capturing: $TARGET_URL"
browser open "$TARGET_URL"
browser wait --load "$WAIT_LOAD"

echo
echo "Metadata:"
echo "Title: $(browser get title)"
echo "URL: $(browser get url)"

echo
echo "Interactive snapshot:"
echo "---"
browser snapshot -i
echo "---"

if ((SKIP_TEXT == 0)); then
  echo
  echo "Text content ($TEXT_TARGET):"
  echo "---"
  browser get text "$TEXT_TARGET"
  echo "---"
fi
