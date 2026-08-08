#!/usr/bin/env bash
# The verb-result walkthrough: deploy a pattern, introspect its verbs, call
# them, and read what they return.
#
# Documented in docs/common/verbs-over-the-cli.md, which explains the model
# this exercises. Keep the two in step: the doc is the explanation, this is the
# proof, and each names the other.
#
# It deploys pattern/verb-results.tsx and nothing else. That fixture belongs to
# this walkthrough alone, so a change to a pattern the product actually ships
# can never break a demonstration of how the CLI verb surface works.
#
# Every step names the property it asserts, so a failure says which one broke
# rather than just exiting nonzero. A fresh space per run, no prior state.
#
# Run standalone against any host:
#   API_URL=http://localhost:8000 packages/cli/integration/verbs-over-the-cli.sh
#
# Against a host that needs a particular key:
#   API_URL=https://<host> CF_IDENTITY=~/.config/commonfabric/identity.key \
#     packages/cli/integration/verbs-over-the-cli.sh
#
# CI runs it through integration.sh's `verbs` section.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
API_URL="${API_URL:-http://localhost:8000}"
FIXTURE="$SCRIPT_DIR/pattern/verb-results.tsx"

# Prefer a built binary when the harness supplies one; fall back to source.
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

SPACE="${SPACE:-$(mktemp -u verbsXXXXXXXX)}"
if [ -z "${CF_IDENTITY:-}" ]; then
  CF_IDENTITY=$(mktemp)
  $CF id new >"$CF_IDENTITY" 2>/dev/null
fi
ARGS="--api-url=$API_URL --identity=$CF_IDENTITY --space=$SPACE"
echo "API_URL=$API_URL"
echo "SPACE=$SPACE"

# A plain-JSON result rides the plainResultReceipts option, off by default
# today, so enable it for this process. A result carrying a piece does NOT
# need it — step 7 proves the difference.
export EXPERIMENTAL_PLAIN_RESULT_RECEIPTS=true

START=$(date +%s)

step "1. Deploy the fixture"
BOARD=$($CF piece new "$FIXTURE" $ARGS 2>&1 |
  grep -oE 'fid1:[A-Za-z0-9_-]+' | head -1)
if [ -n "$BOARD" ]; then ok "deployed $BOARD"; else
  bad "deploy failed"
  exit 1
fi

step "2. Ask what it can do"
VERBS=$($CF piece verbs --piece "$BOARD" $ARGS --json 2>/dev/null)
echo "$VERBS" | jq -r '.verbs[]? | "    " + .name' 2>/dev/null | head -10
echo "$VERBS" | jq -e '[.verbs[]?.name] | index("createNote")' >/dev/null 2>&1 &&
  ok "createNote is listed" || bad "createNote missing from the verb listing"

step "3. A create hands back the piece it created"
R=$($CF piece call --quiet --piece "$BOARD" $ARGS --invocation create-1 \
  createNote '{"title":"First note","body":"written at create"}' 2>/dev/null)
check "settled" "$(echo "$R" | jq -r '.status')" "createNote settled"
check "First note" "$(echo "$R" | jq -r '.result.note["$NAME"] // empty')" \
  "the result carries the created note piece"
check "written at create" "$(echo "$R" | jq -r '.result.note.body // empty')" \
  "the returned piece carries the body it was created with"

step "4. A verb returns what it wrote, including what only it could compute"
L=$($CF piece call --quiet --piece "$BOARD" $ARGS --invocation label-1 \
  setLabel '{"label":"  Field notes  "}' 2>/dev/null)
check "Field notes" "$(echo "$L" | jq -r '.result.label // empty')" \
  "setLabel returns the label AS PERSISTED, trimmed by the pattern"
check "1" "$(echo "$L" | jq -r '.result.revision // empty')" \
  "and the revision it produced, which the caller could not compute"

step "5. Address the piece you were handed, and call it"
# --show-links annotates the Invocation JSON with the document behind each
# path, which is what turns a returned piece from a value into an address.
LINKED=$($CF piece call --quiet --show-links --piece "$BOARD" $ARGS \
  --invocation create-linked \
  createNote '{"title":"Addressable note","body":"first line"}' 2>/dev/null)
NOTE_ID=$(echo "$LINKED" | jq -r '.links["/note"].id // empty' | sed 's/^of://')
if [ -n "$NOTE_ID" ]; then ok "the result names the note's document: $NOTE_ID"; else
  bad "no link for /note in the annotated result"
fi
A=$($CF piece call --quiet --piece "$NOTE_ID" $ARGS --invocation append-1 \
  append '{"text":"second line"}' 2>/dev/null)
check "first line
second line" "$(echo "$A" | jq -r '.result.body // empty')" \
  "calling a verb ON the returned piece works, and returns what it wrote"

step "6. Read an address instead of what is behind it"
# A read follows a link onward unless the selection says where to stop, so a
# created note arrives as a copy of its contents with no address in it. A
# "$link" marker at a position asks for that position's address instead.
ADDR=$($CF piece get --quiet --piece "$BOARD" $ARGS notes \
  --schema '{"type":"array","items":{"$link":true}}' 2>/dev/null)
check "true" "$(echo "$ADDR" | jq -c '[.[] | has("$link")] | all')" \
  "every element carries an address"
check "false" "$(echo "$ADDR" | jq -c '[.[] | has("title")] | any')" \
  "and none of them carries the note's contents"
check '["id","path","scope","space"]' \
  "$(echo "$ADDR" | jq -c '[.[0]["$link"] | keys] | first')" \
  "the address is id, space, scope, and path — no inlined schema"
# A marker beside a projection asks for both, because both were asked for.
BOTH=$($CF piece get --quiet --piece "$BOARD" $ARGS notes --schema \
  '{"type":"array","items":{"$link":true,"type":"object","properties":{"title":true}}}' \
  2>/dev/null)
check "true" "$(echo "$BOTH" | jq -c \
  '[.[] | has("$link") and (.title | length > 0)] | all')" \
  "a marker beside a projection returns the address AND the fields"
# The point of an address: act on the child, rather than read a copy of it.
FIRST=$(echo "$BOTH" | jq -r \
  '.[] | select(.title == "First note") | .["$link"].id' | sed 's/^of://')
if [ -n "$FIRST" ]; then ok "the read names the first note: $FIRST"; else
  bad "no address for the first note in the projected read"
fi
B=$($CF piece call --quiet --piece "$FIRST" $ARGS --invocation append-read \
  append '{"text":"appended through the read"}' 2>/dev/null)
check "written at create
appended through the read" "$(echo "$B" | jq -r '.result.body // empty')" \
  "the address a read returned is one a caller can call"
# A field list spells the same marker with a trailing @, so one read asks for
# an address at one position and projects at another. The list is element-wise
# across an array, so the marked collection answers with one address per note.
AT=$($CF piece get --quiet --piece "$BOARD" $ARGS \
  --select 'notes@,noteCount' 2>/dev/null)
check "true" "$(echo "$AT" | jq -c \
  '(.notes | length > 0) and ([.notes[] | has("$link")] | all)')" \
  "a trailing @ on an array returns an address per element"
check "true" "$(echo "$AT" | jq -c '.noteCount >= 1')" \
  "and a sibling path projects beside it in the one result"
# The bare suffix names the position the read is already at.
ROOT=$($CF piece get --quiet --piece "$BOARD" $ARGS --select '@' 2>/dev/null)
check "true" "$(echo "$ROOT" | jq -c 'has("$link")')" \
  "a bare @ returns the read source's own address"

step "7. A replayed invocation id returns the ORIGINAL result"
# Captured rather than hard-coded: the property is that the replay changes
# nothing, which stays true however many notes earlier steps created.
BEFORE=$($CF piece get --quiet --piece "$BOARD" $ARGS noteCount --step 2>/dev/null)
D=$($CF piece call --quiet --piece "$BOARD" $ARGS --invocation create-1 \
  createNote '{"title":"IMPOSTER"}' 2>/dev/null)
check "First note" "$(echo "$D" | jq -r '.result.note["$NAME"] // empty')" \
  "the replay returns the first result, not the imposter's"
check "true" "$(echo "$D" | jq -r '.deduplicated // false')" \
  "the call reports itself deduplicated"
check "$BEFORE" "$($CF piece get --quiet --piece "$BOARD" $ARGS noteCount --step 2>/dev/null)" \
  "the replay created no note (count unchanged at $BEFORE)"

step "8. A piece result needs no option; a plain record does"
P=$(EXPERIMENTAL_PLAIN_RESULT_RECEIPTS=false $CF piece call --quiet \
  --piece "$BOARD" $ARGS --invocation create-flagoff \
  createNote '{"title":"Flag-off note"}' 2>/dev/null)
check "Flag-off note" "$(echo "$P" | jq -r '.result.note["$NAME"] // empty')" \
  "the piece result arrives with plainResultReceipts OFF"
Q=$(EXPERIMENTAL_PLAIN_RESULT_RECEIPTS=false $CF piece call --quiet \
  --piece "$BOARD" $ARGS --invocation label-flagoff \
  setLabel '{"label":"Written anyway"}' 2>/dev/null)
check "null" "$(echo "$Q" | jq -r '.result // "null"')" \
  "the plain record is absent with the option OFF"
check "Written anyway" \
  "$($CF piece get --quiet --piece "$BOARD" $ARGS label --input 2>/dev/null | jq -r '.')" \
  "but the write landed regardless — an absent result is not a failed mutation"

step "9. A value-less verb settles with no result"
V=$($CF piece call --quiet --piece "$BOARD" $ARGS --invocation touch-1 \
  touch '{}' 2>/dev/null)
check "settled" "$(echo "$V" | jq -r '.status')" "the value-less verb settled"
check "{}" "$(echo "$V" | jq -c '.result // {}')" "its result is the empty witness"

step "10. A refused call does not spend its invocation id"
$CF piece call --quiet --piece "$BOARD" $ARGS --invocation reuse-1 \
  createNote '{"title":""}' >/dev/null 2>&1
rc=$?
check "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)" "an empty title exits nonzero"
C=$($CF piece call --quiet --piece "$BOARD" $ARGS --invocation reuse-1 \
  createNote '{"title":"Corrected"}' 2>/dev/null)
check "Corrected" "$(echo "$C" | jq -r '.result.note["$NAME"] // empty')" \
  "the SAME id then executes, because the refusal never consumed it"

step "11. Reading a verb redirects to cf piece call"
OUT=$($CF piece get --piece "$BOARD" $ARGS createNote 2>&1)
rc=$?
check "1" "$([ "$rc" -ne 0 ] && echo 1 || echo 0)" "a verb read exits nonzero"
echo "$OUT" | grep -qi "piece call" &&
  ok "the refusal names cf piece call" ||
  bad "the refusal does not name the right command"

step "12. --verbose times the phases on stderr; stdout stays JSON"
ERR=$(mktemp)
OUT=$($CF piece call --quiet --verbose --piece "$BOARD" $ARGS \
  --invocation timed-1 createNote '{"title":"Timed note"}' 2>"$ERR")
echo "$OUT" | jq -e '.status' >/dev/null 2>&1 &&
  ok "stdout is still Invocation JSON" || bad "stdout was polluted"
grep -qE "[0-9]+ *ms" "$ERR" && ok "per-phase timings on stderr" ||
  bad "no timings on stderr"
sed 's/^/    /' "$ERR" | grep timing | head -5

ELAPSED=$(($(date +%s) - START))
printf '\n== %d passed, %d failed — %ds wall clock\n' "$PASS" "$FAIL" "$ELAPSED"
[ "$FAIL" -eq 0 ]
