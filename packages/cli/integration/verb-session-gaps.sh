#!/usr/bin/env bash
# The gap harness for the verb session: what is true today, including what does
# not work yet. Its companion `verb-session-demo.sh` shows the session as it is
# meant to read; this one is the thing that keeps that honest.
#
# Four steps assert a GAP rather than a capability. Each fails loudly the day
# the gap closes, so this script is how we find out that a capability arrived
# rather than discovering it months later in a stale document.
#
# Documented in docs/common/verb-session-walkthrough.md.
#
# It deploys pattern/tracker.tsx and nothing else. That fixture belongs to this
# session alone, so a change to a pattern the product ships can never break a
# demonstration of what driving one through `cf` looks like.
#
# Two steps assert a gap rather than a capability, and say so. When the gap
# closes they fail, which is the point: this script is how we find out.
#
# Run standalone against any host:
#   API_URL=http://localhost:8000 packages/cli/integration/verb-session-gaps.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
API_URL="${API_URL:-http://localhost:8000}"
FIXTURE="$SCRIPT_DIR/pattern/tracker.tsx"

if [ -n "${CF_BINARY:-}" ]; then
  CF="$CF_BINARY"
else
  CF="deno task --quiet --cwd $REPO_ROOT cf"
fi

PASS=0
FAIL=0
step() { printf '\n== %s\n' "$1"; }
ok() { printf '  PASS %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }
check() {
  if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (expected [$1], got [$2])"; fi
}
# A gap we expect to be there. When it closes this fails loudly, which is how
# the script tells us the capability arrived rather than quietly passing.
gap() {
  if [ "$1" = "0" ]; then
    bad "GAP CLOSED — $2 now works; update this script and the walkthrough"
  else
    ok "gap still open: $2"
  fi
}

SPACE="${SPACE:-$(mktemp -u sessXXXXXXXX)}"
if [ -z "${CF_IDENTITY:-}" ]; then
  CF_IDENTITY=$(mktemp)
  $CF id new >"$CF_IDENTITY" 2>/dev/null
fi
ARGS="--api-url=$API_URL --identity=$CF_IDENTITY --space=$SPACE"
echo "API_URL=$API_URL"
echo "SPACE=$SPACE"

START=$(date +%s)

step "1. Arrive by name, not by fid"
BOARD=$($CF piece new "$FIXTURE" $ARGS 2>&1 |
  grep -oE 'fid1:[A-Za-z0-9_-]+' | head -1)
if [ -n "$BOARD" ]; then ok "deployed $BOARD"; else
  bad "deploy failed"
  exit 1
fi
$CF piece set-slug board "$BOARD" $ARGS >/dev/null 2>&1
SLUG_NAME=$($CF piece get --quiet --piece board $ARGS '$NAME' 2>/dev/null | tr -d '"')
check "Work tracker" "$SLUG_NAME" "the slug resolves everywhere --piece is taken"

step "2. Ask what it can do"
VERBS=$($CF piece verbs --piece board $ARGS --json 2>/dev/null)
echo "$VERBS" | jq -r '.verbs[]? | "    " + .name + "  (" + .kind + ")"' 2>/dev/null
echo "$VERBS" | jq -e '[.verbs[]?.name] | index("addItem")' >/dev/null 2>&1 &&
  ok "addItem is listed" || bad "addItem missing from the listing"

step "3. Ask what a verb wants — flags and prose, both derived"
HELP=$($CF piece call --piece board $ARGS addItem -- --help 2>/dev/null)
echo "$HELP" | grep -q -- "--title" &&
  ok "the flag is derived from the event schema" ||
  bad "no --title flag in the generated help"
# The author's JSDoc reaches the COMPILED pattern but not the schema this help
# page reads, so the prose is stripped before a caller can see it. Asserted as
# a gap so the day it flows, this fails and tells us.
echo "$HELP" | grep -qi "one line naming the work"
gap "$?" "JSDoc on an event field reaching its flag description"

step "4. A create hands back the piece, and the address chains"
R=$($CF piece call --quiet --show-links --piece board $ARGS \
  addItem '{"title":"Login rewrite"}' 2>/dev/null)
check "Login rewrite" "$(echo "$R" | jq -r '.result.item["$NAME"] // empty')" \
  "the result carries the created item"
EPIC=$(echo "$R" | jq -r '.links["/item"].id // empty' | sed 's/^of://')
if [ -n "$EPIC" ]; then ok "the result names its document: $EPIC"; else
  bad "no link for /item"
fi
# The receiver axis: call the verb ON the thing you were just handed.
$CF piece call --quiet --piece "$EPIC" $ARGS \
  addChild '{"title":"Session cookies"}' >/dev/null 2>&1
$CF piece call --quiet --piece "$EPIC" $ARGS \
  addChild '{"title":"CSRF tokens"}' >/dev/null 2>&1
KIDS=$($CF piece get --quiet --piece "$EPIC" children $ARGS \
  --schema '{"type":"array","items":{"type":"object","properties":{"title":true}}}' \
  2>/dev/null)
check "2" "$(echo "$KIDS" | jq -r 'length')" \
  "both children landed under the address the create returned"

step "5. Read addresses instead of contents"
ADDR=$($CF piece get --quiet --piece "$EPIC" children $ARGS \
  --schema '{"type":"array","items":{"$link":true,"type":"object","properties":{"title":true}}}' \
  2>/dev/null)
check "true" "$(echo "$ADDR" | jq -c '[.[] | has("$link") and (.title|length>0)] | all')" \
  "a marker beside a projection returns the address AND the fields"
KID=$(echo "$ADDR" | jq -r '.[] | select(.title=="Session cookies") | .["$link"].id')

step "6. Two mechanisms name the piece, and they do not agree"
# MEASURED, and not what you would guess: the address a call hands back
# (--show-links) and the address a read projects ($link) are DIFFERENT entity
# ids for the same piece. Both resolve — each reads back the same title — so
# either is usable, but a caller cannot compare them for equality.
MADE=$($CF piece call --quiet --show-links --piece board $ARGS \
  addItem '{"title":"Rate limiting"}' 2>/dev/null |
  jq -r '.links["/item"].id // empty' | sed 's/^of://')
VIA_READ=$($CF piece get --quiet --piece board items $ARGS --step \
  --schema '{"type":"array","items":{"$link":true,"type":"object","properties":{"title":true}}}' \
  2>/dev/null | jq -r '.[] | select(.title=="Rate limiting") | .["$link"].id' |
  sed 's/^of://')
if [ -z "$MADE" ] || [ -z "$VIA_READ" ]; then
  bad "one of the two routes produced no address (call=$MADE read=$VIA_READ)"
else
  # Both must work as --piece. That is the property a caller depends on.
  M_T=$($CF piece get --quiet --piece "$MADE" title $ARGS 2>/dev/null | tr -d '"')
  R_T=$($CF piece get --quiet --piece "$VIA_READ" title $ARGS 2>/dev/null | tr -d '"')
  check "Rate limiting" "$M_T" "the address the call returned addresses the piece"
  check "Rate limiting" "$R_T" "the address the read returned addresses the piece too"
  if [ "$MADE" = "$VIA_READ" ]; then
    bad "GAP CLOSED — the two routes now agree; simplify this step"
  else
    ok "gap still open: the two routes give different ids for one piece"
  fi
fi

step "7. A verb returns what only the pattern could compute"
N=$($CF piece call --quiet --piece "$EPIC" $ARGS \
  recordNote '{"body":"blocked on the cookie spec"}' 2>/dev/null)
check "1" "$(echo "$N" | jq -r '.result.noteCount // empty')" \
  "recordNote returns the count after the append"
AT=$(echo "$N" | jq -r '.result.note.at // 0')
[ "$AT" -gt 0 ] && ok "and a timestamp the caller never supplied ($AT)" ||
  bad "no pattern-stamped time on the note"

step "8. Finishing reports what the caller could not know"
$CF piece call --quiet --piece "$KID" $ARGS \
  addChild '{"title":"Rotate signing key"}' >/dev/null 2>&1
# Unshaped: a PROJECTED read of this path fails once `finish` has run, while
# the same path unshaped resolves fine. Counting is all this step needs.
DIRECT=$($CF piece get --quiet --piece "$EPIC" children $ARGS --step 2>/dev/null |
  jq -r 'length')
F=$($CF piece call --quiet --piece "$EPIC" $ARGS \
  finish '{"body":"shipping behind a flag"}' 2>/dev/null)
OPEN=$(echo "$F" | jq -r '.result.openBelow // empty')
# Captured rather than hard-coded: the property is that it counted deeper than
# one level, which holds however many items earlier steps created.
if [ -n "$OPEN" ] && [ -n "$DIRECT" ] && [ "$OPEN" -gt "$DIRECT" ]; then
  ok "openBelow ($OPEN) exceeds the $DIRECT direct children — it recursed"
else
  bad "openBelow did not walk past the direct children (open=$OPEN direct=$DIRECT)"
fi

step "9. A value-less verb settles with the empty witness"
V=$($CF piece call --quiet --piece "$KID" $ARGS archive '{}' 2>/dev/null)
check "settled" "$(echo "$V" | jq -r '.status')" "archive settled"
check "{}" "$(echo "$V" | jq -c '.result // {}')" "its result is the empty witness"

step "10. GAP: an address cannot be a verb argument"
# blockOn declares `on: Writable<ItemOutput>` — a reference. `send()` already
# resolves a native sigil (measured), so the pre-dispatch gate is the only
# thing refusing this. Verbs plan item 11 closes it; see
# docs/plans/references-as-arguments.md.
OTHER=$($CF piece get --quiet --piece board items $ARGS \
  --schema '{"type":"array","items":{"$link":true}}' 2>/dev/null |
  jq -r '.[0]["$link"].id')
$CF piece call --quiet --piece "$KID" $ARGS \
  blockOn "{\"on\":\"$OTHER\"}" >/dev/null 2>&1
gap "$?" "blockOn with a bare address"

step "11. GAP: a verb returning a child piece crashes readback"
# The returned item carries `parent`, which points back at its container, so
# the result is cyclic and rendering it fails — issue #5577. The write lands
# regardless, which is the property worth not losing.
BEFORE=$($CF piece get --quiet --piece "$EPIC" children $ARGS --step 2>/dev/null |
  jq -r 'length')
$CF piece call --quiet --piece "$EPIC" $ARGS \
  addChild '{"title":"Cycle probe"}' >/dev/null 2>&1
gap "$?" "addChild readback on a doubly-linked tree"
AFTER=$($CF piece get --quiet --piece "$EPIC" children $ARGS --step 2>/dev/null |
  jq -r 'length')
check "$((BEFORE + 1))" "$AFTER" \
  "the write landed anyway — an absent result is not a failed mutation"

ELAPSED=$(($(date +%s) - START))
printf '\n== %d passed, %d failed — %ds wall clock\n' "$PASS" "$FAIL" "$ELAPSED"
[ "$FAIL" -eq 0 ]
