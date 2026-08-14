#!/usr/bin/env bash
# The gap harness for the verb session: what is true today, including what does
# not work yet. Its companion `verb-session-demo.sh` shows the session as it is
# meant to read; this one is the thing that keeps that honest.
#
# Some steps assert a GAP rather than a capability. Each fails loudly the day
# the gap closes, so this script is how we find out that a capability arrived
# rather than discovering it months later in a stale document. How many are
# open is tallied as they run and printed on the last line, so no prose here
# can fall out of step with the assertions below.
#
# Documented in docs/common/verb-session-walkthrough.md.
#
# It deploys pattern/tracker.tsx and nothing else. That fixture belongs to this
# session alone, so a change to a pattern the product ships can never break a
# demonstration of what driving one through `cf` looks like.
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
GAPS=0
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
    GAPS=$((GAPS + 1))
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
# --quiet makes the piece id stdout's only line; stderr is dropped and the
# grep anchored so a compile warning carrying a fid1: token cannot be taken
# for the deploy's id.
BOARD=$($CF piece new --quiet "$FIXTURE" $ARGS 2>/dev/null |
  grep -oE '^fid1:[A-Za-z0-9_-]+' | head -1)
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
# The other half of a discovery surface, and the half that has no natural
# witness: what it does NOT name. The board's `items` and `$NAME` are data, and
# a listing that offers them hands a client operations that do not exist.
check "addItem" "$(echo "$VERBS" | jq -r '[.verbs[]?.name] | sort | join(",")')" \
  "the listing names the verb and nothing else"

step "3. Ask what a verb wants — flags and prose, both derived"
HELP=$($CF piece call --piece board $ARGS addItem -- --help 2>/dev/null)
echo "$HELP" | grep -q -- "--title" &&
  ok "the flag is derived from the event schema" ||
  bad "no --title flag in the generated help"
# The author's JSDoc reaches the COMPILED pattern but not the schema this help
# page reads, so the prose is stripped before a caller can see it. Asserted as
# a gap so the day it flows, this fails and tells us. The needle is read out
# of the fixture rather than hard-coded, so rewording the doc comment moves
# the probe with it instead of silently "re-opening" the gap.
NEEDLE=$(sed -n '/interface AddItemEvent {/,/^}/p' "$FIXTURE" |
  sed -n 's/.*\/\*\* *\(.*[^ ]\) *\*\/.*/\1/p' | head -1)
if [ -z "$NEEDLE" ]; then
  bad "no JSDoc on AddItemEvent's field in the fixture — the probe has no needle"
else
  echo "$HELP" | grep -qiF "$NEEDLE"
  gap "$?" "JSDoc on an event field reaching its flag description"
fi

step "4. A create hands back the piece, and the address chains"
R=$($CF piece call --quiet --show-links --piece board $ARGS \
  addItem '{"title":"Login rewrite"}' 2>/dev/null)
check "Login rewrite" "$(echo "$R" | jq -r '.result.item["$NAME"] // empty')" \
  "the result carries the created item"
EPIC=$(echo "$R" | jq -r '.links["/item"].id // empty' | sed 's/^of://')
if [ -n "$EPIC" ]; then ok "the result names its document: $EPIC"; else
  bad "no link for /item"
fi
# The receiver axis: call the verb ON the thing you were just handed. The
# children count below proves the writes landed; each call's exit code is
# checked too, because the readback runs after the write commits — a readback
# failure leaves the count intact, and only the exit code shows it.
$CF piece call --quiet --piece "$EPIC" $ARGS \
  addChild '{"title":"Session cookies"}' >/dev/null 2>&1 ||
  bad "addChild (Session cookies) exited nonzero"
$CF piece call --quiet --piece "$EPIC" $ARGS \
  addChild '{"title":"CSRF tokens"}' >/dev/null 2>&1 ||
  bad "addChild (CSRF tokens) exited nonzero"
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
# GAP: the very same read, run a second time. A (source cell, schema) pair
# serves exactly once — the second read reports success and returns null for
# every projected field, while the addresses survive (#5633; the fix is in
# review as #5764, so this is the assertion that will announce it landing).
# The check above is what makes this comparison mean anything: were the first
# read already empty, the two would agree and this would misreport the gap as
# closed. Matched against that SPECIFIC shape rather than against "differs at
# all": a server hiccup or a renamed field also differs, and a probe that reads
# any difference as "gap still open" is a probe that cannot fail.
AGAIN=$($CF piece get --quiet --piece "$EPIC" children $ARGS \
  --schema '{"type":"array","items":{"$link":true,"type":"object","properties":{"title":true}}}' \
  2>/dev/null)
SECOND_READ="a second read of one (source, schema) pair returning what the first did"
ADDR_IDS=$(echo "$ADDR" | jq -c '[.[]? | .["$link"].id]' 2>/dev/null)
AGAIN_IDS=$(echo "$AGAIN" | jq -c '[.[]? | .["$link"].id]' 2>/dev/null)
AGAIN_DROPPED=$(echo "$AGAIN" |
  jq -c '[.[]? | .title] | length > 0 and all(. == null)' 2>/dev/null)
if [ "$ADDR" = "$AGAIN" ]; then
  gap 0 "$SECOND_READ"
elif [ "$AGAIN_IDS" = "$ADDR_IDS" ] && [ "$AGAIN_DROPPED" = "true" ]; then
  gap 1 "$SECOND_READ (it keeps the addresses and drops every field)"
else
  bad "the second read differed in a way that is not the known drop: $AGAIN"
fi

step "6. Two routes hand back an address, and either one addresses the piece"
# MEASURED, and not what you would guess: the address a call hands back
# (--show-links) and the address a read projects ($link) are DIFFERENT entity
# ids for the same piece — one resolves the link chain, the other renders the
# link as stored. That is the read model working rather than a defect: an
# address is many-to-one over cells, so a holder of one cannot tell a canonical
# id from an alias and is never asked to. The property is stated in
# docs/plans/shaped-reads-and-verb-results.md; #5632 asks whether the two ids
# should agree and item 11 of docs/plans/verbs-implementation.md rules that
# they are aliases. So their difference is asserted nowhere here: no day exists
# on which it "closes", and a gap that can never fire is a gap that reports
# nothing. What a caller does depend on is asserted instead — either address,
# fed back to --piece, reads the same piece.
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
# Exit code checked for the same reason as step 4's creates.
$CF piece call --quiet --piece "$KID" $ARGS \
  addChild '{"title":"Rotate signing key"}' >/dev/null 2>&1 ||
  bad "addChild (Rotate signing key) exited nonzero"
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
# thing refusing this. docs/plans/references-as-arguments.md closes it — that
# work carries no step number in the verbs plan, which numbers only the read
# and result layers.
OTHER=$($CF piece get --quiet --piece board items $ARGS \
  --schema '{"type":"array","items":{"$link":true}}' 2>/dev/null |
  jq -r '.[0]["$link"].id // empty')
# Guarded, and matched against the SPECIFIC refusal: an empty address, a
# renamed verb, or a server hiccup would also exit nonzero, and a probe that
# reads any failure as "gap still open" is a probe that cannot fail.
if [ -z "$OTHER" ] || [ -z "${KID:-}" ]; then
  bad "no address to probe blockOn with (item=$OTHER target=${KID:-})"
else
  BLOCK_ERR=$($CF piece call --quiet --piece "$KID" $ARGS \
    blockOn "{\"on\":\"$OTHER\"}" 2>&1 >/dev/null)
  BLOCK_RC=$?
  if [ "$BLOCK_RC" = "0" ]; then
    gap 0 "blockOn with a bare address"
  elif printf '%s' "$BLOCK_ERR" | grep -q "does not match type object"; then
    gap 1 "blockOn with a bare address (the pre-dispatch gate refuses it)"
  else
    bad "blockOn failed for a reason that is not the known refusal: $BLOCK_ERR"
  fi
fi

step "11. a verb returning a child piece renders the circle as an address"
# The returned item carries `parent`, which points back at its container. The
# readback bounds the result with the verb's own declared result and renders
# the position where the declared type re-enters itself as an address, so the
# whole outcome is JSON and the write it reports stays legible.
BEFORE=$($CF piece get --quiet --piece "$EPIC" children $ARGS --step 2>/dev/null |
  jq -r 'length')
CALLED=$($CF piece call --quiet --piece "$EPIC" $ARGS \
  addChild '{"title":"Cycle probe"}' 2>/dev/null)
RC=$?
check "0" "$RC" "addChild readback on a doubly-linked tree"
BACKREF=$(printf '%s' "$CALLED" | jq -r '.result.item.parent["$link"].id // ""')
check "of:" "${BACKREF:0:3}" \
  "the position that closes the circle answers an address"
AFTER=$($CF piece get --quiet --piece "$EPIC" children $ARGS --step 2>/dev/null |
  jq -r 'length')
check "$((BEFORE + 1))" "$AFTER" "the write the result describes landed"

ELAPSED=$(($(date +%s) - START))
printf '\n== %d passed, %d failed, %d gaps open — %ds wall clock\n' \
  "$PASS" "$FAIL" "$GAPS" "$ELAPSED"
[ "$FAIL" -eq 0 ]
