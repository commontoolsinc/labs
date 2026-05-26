#!/bin/bash
# Script: Form Automation Workflow
# Purpose: Discover form refs or run a parameterized form interaction sequence.

set -euo pipefail

SCRIPT_NAME="${SKILL_SCRIPT:-scripts/form-automation.sh}"
CDP="${AGENT_BROWSER_CDP:-}"
FORM_URL=""
WAIT_LOAD="networkidle"
WAIT_URL=""
NO_FINAL_WAIT=0
ACTION_KINDS=()
ACTION_VALUES=()

usage() {
  cat <<USAGE
Usage:
  $SCRIPT_NAME --cdp <http://localhost:port> <form-url>
  $SCRIPT_NAME --cdp <http://localhost:port> <form-url> \\
    --fill @e1="Jane Doe" --type @e2="jane@example.com" --click @e5

Actions run in the order provided:
  --fill REF=VALUE     Fill a native input or textarea.
  --type REF=VALUE     Type into an element, useful for custom inputs.
  --select REF=VALUE   Select an option.
  --check REF          Check a checkbox.
  --click REF          Click a control, link, button, or radio option.
  --press KEY          Press a key, such as Enter.

Options:
  --wait-url PATTERN   After actions, wait for a URL glob.
  --wait-load STATE    Load state for initial and final waits (default: networkidle).
  --no-final-wait      Do not wait after actions.

Environment:
  AGENT_BROWSER_CDP  Local CDP origin, used when --cdp is omitted.

Notes:
  - The CDP endpoint must be a local http origin with an explicit port.
  - With no actions, the script prints an interactive snapshot for ref discovery.
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
    *) fail "form-url must be http:// or https://" ;;
  esac
}

add_action() {
  ACTION_KINDS+=("$1")
  ACTION_VALUES+=("$2")
}

split_assignment() {
  local flag="$1"
  local assignment="$2"
  [[ "$assignment" == *=* ]] || fail "$flag expects REF=VALUE"
  REF="${assignment%%=*}"
  VALUE="${assignment#*=}"
  [[ -n "$REF" ]] || fail "$flag requires a non-empty ref"
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
    --fill)
      require_value "$1" "${2:-}"
      add_action "fill" "$2"
      shift 2
      ;;
    --fill=*)
      add_action "fill" "${1#*=}"
      shift
      ;;
    --type)
      require_value "$1" "${2:-}"
      add_action "type" "$2"
      shift 2
      ;;
    --type=*)
      add_action "type" "${1#*=}"
      shift
      ;;
    --select)
      require_value "$1" "${2:-}"
      add_action "select" "$2"
      shift 2
      ;;
    --select=*)
      add_action "select" "${1#*=}"
      shift
      ;;
    --check)
      require_value "$1" "${2:-}"
      add_action "check" "$2"
      shift 2
      ;;
    --check=*)
      add_action "check" "${1#*=}"
      shift
      ;;
    --click)
      require_value "$1" "${2:-}"
      add_action "click" "$2"
      shift 2
      ;;
    --click=*)
      add_action "click" "${1#*=}"
      shift
      ;;
    --press)
      require_value "$1" "${2:-}"
      add_action "press" "$2"
      shift 2
      ;;
    --press=*)
      add_action "press" "${1#*=}"
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
    --no-final-wait)
      NO_FINAL_WAIT=1
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
      [[ -z "$FORM_URL" ]] || fail "unexpected argument: $1"
      FORM_URL="$1"
      shift
      ;;
  esac
done

while (($# > 0)); do
  [[ -z "$FORM_URL" ]] || fail "unexpected argument: $1"
  FORM_URL="$1"
  shift
done

[[ -n "$FORM_URL" ]] || {
  usage >&2
  exit 2
}
[[ -n "$CDP" ]] || fail "provide --cdp or set AGENT_BROWSER_CDP"
CDP="${CDP%/}"
validate_cdp_endpoint "$CDP"
validate_page_url "$FORM_URL"
command -v agent-browser >/dev/null 2>&1 || fail "agent-browser is not on PATH"

echo "Form workflow: $FORM_URL"
browser open "$FORM_URL"
browser wait --load "$WAIT_LOAD"

echo
echo "Initial form snapshot:"
echo "---"
browser snapshot -i
echo "---"

if ((${#ACTION_KINDS[@]} == 0)); then
  echo
  echo "Discovery mode complete. Re-run with --fill, --type, --select, --check, --click, or --press actions."
  exit 0
fi

echo
echo "Running ${#ACTION_KINDS[@]} action(s)..."
for index in "${!ACTION_KINDS[@]}"; do
  kind="${ACTION_KINDS[$index]}"
  payload="${ACTION_VALUES[$index]}"
  case "$kind" in
    fill)
      split_assignment "--fill" "$payload"
      browser fill "$REF" "$VALUE"
      ;;
    type)
      split_assignment "--type" "$payload"
      browser type "$REF" "$VALUE"
      ;;
    select)
      split_assignment "--select" "$payload"
      browser select "$REF" "$VALUE"
      ;;
    check)
      browser check "$payload"
      ;;
    click)
      browser click "$payload"
      ;;
    press)
      browser press "$payload"
      ;;
    *)
      fail "internal error: unknown action kind $kind"
      ;;
  esac
done

if ((NO_FINAL_WAIT == 0)); then
  if [[ -n "$WAIT_URL" ]]; then
    browser wait --url "$WAIT_URL"
  else
    browser wait --load "$WAIT_LOAD"
  fi
fi

echo
echo "Result URL:"
browser get url
echo
echo "Result snapshot:"
echo "---"
browser snapshot -i
echo "---"
