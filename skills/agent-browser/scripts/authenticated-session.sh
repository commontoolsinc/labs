#!/bin/bash
# Script: Authenticated Session Workflow
# Purpose: Discover login refs or perform a single credentialed login.

set -euo pipefail

SCRIPT_NAME="${SKILL_SCRIPT:-scripts/authenticated-session.sh}"
CDP="${AGENT_BROWSER_CDP:-}"
LOGIN_URL=""
USERNAME_REF=""
PASSWORD_REF=""
SUBMIT_REF=""
WAIT_LOAD="networkidle"
WAIT_URL=""
DISCOVERY_ONLY=0

usage() {
  cat <<USAGE
Usage:
  $SCRIPT_NAME --cdp <http://localhost:port> <login-url>
  $SCRIPT_NAME --cdp <http://localhost:port> <login-url> \\
    --username-ref @e1 --password-ref @e2 --submit-ref @e3 [--wait-url "**/dashboard"]

Environment:
  AGENT_BROWSER_CDP  Local CDP origin, used when --cdp is omitted.
  APP_USERNAME       Username/email for credentialed mode.
  APP_PASSWORD       Password for credentialed mode.

Notes:
  - The CDP endpoint must be a local http origin with an explicit port.
  - Without all three refs, the script runs in discovery mode and prints the
    login page snapshot so refs can be supplied on a later run.
  - This script does not save or load browser state; reuse the connected
    browser/session outside the script when persistence is needed.
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
    *) fail "login-url must be http:// or https://" ;;
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
    --username-ref)
      require_value "$1" "${2:-}"
      USERNAME_REF="$2"
      shift 2
      ;;
    --username-ref=*)
      USERNAME_REF="${1#*=}"
      [[ -n "$USERNAME_REF" ]] || fail "--username-ref requires a value"
      shift
      ;;
    --password-ref)
      require_value "$1" "${2:-}"
      PASSWORD_REF="$2"
      shift 2
      ;;
    --password-ref=*)
      PASSWORD_REF="${1#*=}"
      [[ -n "$PASSWORD_REF" ]] || fail "--password-ref requires a value"
      shift
      ;;
    --submit-ref)
      require_value "$1" "${2:-}"
      SUBMIT_REF="$2"
      shift 2
      ;;
    --submit-ref=*)
      SUBMIT_REF="${1#*=}"
      [[ -n "$SUBMIT_REF" ]] || fail "--submit-ref requires a value"
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
    --wait-url)
      require_value "$1" "${2:-}"
      WAIT_URL="$2"
      shift 2
      ;;
    --wait-url=*)
      WAIT_URL="${1#*=}"
      [[ -n "$WAIT_URL" ]] || fail "--wait-url requires a value"
      shift
      ;;
    --discovery)
      DISCOVERY_ONLY=1
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
      [[ -z "$LOGIN_URL" ]] || fail "unexpected argument: $1"
      LOGIN_URL="$1"
      shift
      ;;
  esac
done

while (($# > 0)); do
  [[ -z "$LOGIN_URL" ]] || fail "unexpected argument: $1"
  LOGIN_URL="$1"
  shift
done

[[ -n "$LOGIN_URL" ]] || {
  usage >&2
  exit 2
}
[[ -n "$CDP" ]] || fail "provide --cdp or set AGENT_BROWSER_CDP"
CDP="${CDP%/}"
validate_cdp_endpoint "$CDP"
validate_page_url "$LOGIN_URL"
command -v agent-browser >/dev/null 2>&1 || fail "agent-browser is not on PATH"

echo "Authentication workflow: $LOGIN_URL"
browser open "$LOGIN_URL"
browser wait --load "$WAIT_LOAD"

echo
echo "Login page snapshot:"
echo "---"
browser snapshot -i
echo "---"

if ((DISCOVERY_ONLY == 1)) ||
  [[ -z "$USERNAME_REF" || -z "$PASSWORD_REF" || -z "$SUBMIT_REF" ]]; then
  echo
  echo "Discovery mode complete."
  echo "Re-run with --username-ref, --password-ref, and --submit-ref to submit credentials."
  exit 0
fi

: "${APP_USERNAME:?Set APP_USERNAME in the script execution environment}"
: "${APP_PASSWORD:?Set APP_PASSWORD in the script execution environment}"

echo
echo "Submitting credentials..."
browser fill "$USERNAME_REF" "$APP_USERNAME"
browser fill "$PASSWORD_REF" "$APP_PASSWORD"
browser click "$SUBMIT_REF"

if [[ -n "$WAIT_URL" ]]; then
  browser wait --url "$WAIT_URL"
else
  browser wait --load "$WAIT_LOAD"
fi

echo
echo "Post-login URL:"
browser get url
echo
echo "Post-login snapshot:"
echo "---"
browser snapshot -i
echo "---"
