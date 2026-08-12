#!/usr/bin/env bash
# The verb session as it is meant to read: a work tracker driven entirely
# through `cf`, with no tooling written for it.
#
# This is a demo, not a test. It narrates each command before running it, so
# the transcript is the artifact. Its companion `verb-session-gaps.sh` asserts
# the same surface as pass/fail and is what keeps this one honest.
#
# Two acts are marked PENDING. They print the command and the result they will
# produce, without running it, because the capability is sequenced and not yet
# built (verbs plan item 11 — docs/plans/references-as-arguments.md). They are
# deliberately visible: a demo that quietly omits what does not work teaches a
# surface that does not exist.
#
# Two more are marked BROKEN, for the same reason: they are commands a person
# driving this at a prompt runs and watches fail. Their errors are printed as
# they arrive rather than hidden behind a redirect.
#
# One constraint on anyone editing this file: while #5633 is open, no two reads
# may share a (source cell, schema) pair — the second one silently returns null
# for every projected field. Act 6 is that failure, on purpose. Every other read
# here uses a pair no other read uses, which is the only reason they pass.
#
#   API_URL=http://localhost:8000 packages/cli/integration/verb-session-demo.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
API_URL="${API_URL:-http://localhost:8000}"
FIXTURE="$SCRIPT_DIR/pattern/tracker.tsx"

if [ -n "${CF_BINARY:-}" ]; then CF="$CF_BINARY"; else
  CF="deno task --quiet --cwd $REPO_ROOT cf"
fi

B=$'\033[1m'; D=$'\033[2m'; C=$'\033[36m'; Y=$'\033[33m'; N=$'\033[0m'
act() { printf '\n%s━━ %s %s\n' "$B" "$1" "$N"; }
say() { printf '%s   %s%s\n' "$D" "$1" "$N"; }
# Show the command, then run it. The transcript is the point.
run() { printf '\n%s   $ %s%s\n' "$C" "$1" "$N"; shift; "$@" 2>/dev/null | sed 's/^/     /'; }
# Show what a command will do once the capability it needs is built.
pending() {
  printf '\n%s   $ %s%s\n' "$Y" "$1" "$N"
  printf '%s     PENDING — %s%s\n' "$Y" "$2" "$N"
  printf '%s     will print:%s\n' "$D" "$N"
  printf '%s\n' "$3" | sed 's/^/       /'
}
# Show a command that runs today and fails, with the error it really printed.
broken() {
  printf '\n%s   $ %s%s\n' "$Y" "$1" "$N"
  printf '%s     BROKEN — %s%s\n' "$Y" "$2" "$N"
  printf '%s\n' "$3" | sed 's/^/       /'
}

SPACE="${SPACE:-$(mktemp -u demoXXXXXXXX)}"
if [ -z "${CF_IDENTITY:-}" ]; then
  CF_IDENTITY=$(mktemp); $CF id new >"$CF_IDENTITY" 2>/dev/null
fi
ARGS="--api-url=$API_URL --identity=$CF_IDENTITY --space=$SPACE"

printf '%s\n' "${B}A work tracker, driven entirely through cf${N}"
say "space $SPACE · nothing here was written for this pattern"

act "1 · Arrive by name"
say "A slug is a name in the space. After this, no fid appears again."
# --quiet makes the piece id stdout's only line; stderr is dropped and the
# grep anchored so a compile warning carrying a fid1: token cannot be taken
# for the deploy's id.
BOARD=$($CF piece new --quiet "$FIXTURE" $ARGS 2>/dev/null |
  grep -oE '^fid1:[A-Za-z0-9_-]+' | head -1)
$CF piece set-slug board "$BOARD" $ARGS >/dev/null 2>&1
printf '\n%s   $ cf piece new tracker.tsx --slug board%s\n' "$C" "$N"
printf '     %s\n' "$BOARD"

act "2 · Ask what it can do"
say "The listing is derived from the deployed pattern, not from a manifest."
run "cf piece verbs --piece board" $CF piece verbs --piece board $ARGS --quiet

act "3 · Ask what a verb wants"
say "Flags, types and required-ness all come from the author's TypeScript."
printf '\n%s   $ cf piece call --piece board addItem -- --help%s\n' "$C" "$N"
$CF piece call --piece board $ARGS addItem -- --help 2>/dev/null |
  sed -n '/^Flags after/,/^$/p' | sed 's/^/     /'

act "4 · Create, and act on what you were handed"
say "The create returns the piece it made. Its address is the next command's target."
R=$($CF piece call --quiet --show-links --piece board $ARGS \
  addItem '{"title":"Login rewrite"}' 2>/dev/null)
EPIC=$(echo "$R" | jq -r '.links["/item"].id' | sed 's/^of://')
printf '\n%s   $ cf piece call --piece board addItem --show-links -- --title "Login rewrite"%s\n' "$C" "$N"
echo "$R" | jq -c '{status, result: {item: {"$NAME": .result.item["$NAME"]}}}' | sed 's/^/     /'
printf '     %saddress: %s%s\n' "$D" "$EPIC" "$N"
CHILD_ERR=""
for t in "Session cookies" "CSRF tokens"; do
  OUT=$($CF piece call --quiet --piece "$EPIC" $ARGS \
    addChild "{\"title\":\"$t\"}" 2>&1)
  if [ -z "$CHILD_ERR" ]; then
    CHILD_ERR=$(printf '%s\n' "$OUT" | grep -v '^invocation:' | grep -v '^session:')
  fi
done
broken 'cf piece call --piece <that address> addChild -- --title "Session cookies"' \
  "the item it hands back points at its parent, and rendering a cycle fails (#5577)" \
  "$CHILD_ERR"
say "The write landed regardless — the failure is the readback, not the mutation."
LANDED=$($CF piece get --quiet --piece "$EPIC" $ARGS children 2>/dev/null |
  jq -r 'length')
printf '\n%s   $ cf piece get --piece <epic> children | jq length%s\n' "$C" "$N"
printf '     %s\n' "$LANDED"

act "5 · Read addresses instead of contents"
say "An unshaped read follows every link. A \$link marker stops at the address."
SHAPED='{"type":"array","items":{"$link":true,"type":"object","properties":{"title":true}}}'
run "cf piece get --piece <epic> children --schema '{...\"\$link\":true...}'" \
  $CF piece get --quiet --piece "$EPIC" children $ARGS --schema "$SHAPED"

act "6 · Ask the same question twice — BROKEN"
say "The first thing anyone watching says is 'show me that again'."
AGAIN=$($CF piece get --quiet --piece "$EPIC" children $ARGS --schema "$SHAPED" 2>&1)
broken "cf piece get --piece <epic> children --schema '{...}'   (the same command again)" \
  "a second read of one (source, schema) pair drops every projected field (#5633)" \
  "$AGAIN"
say "The addresses survive; the titles do not. The read reports success while"
say "returning less than it did a moment ago, which is the part worth knowing."

act "7 · A verb returns what only the pattern could compute"
say "The note's timestamp is the pattern's; the caller never supplied one."
run "cf piece call --piece <epic> recordNote -- --body 'blocked on the cookie spec'" \
  $CF piece call --quiet --piece "$EPIC" $ARGS \
  recordNote '{"body":"blocked on the cookie spec"}'

act "8 · Finishing reports what the caller could not know"
say "openBelow walks the whole subtree — a caller would need N reads to learn it."
say "A grandchild is filed first, by the same addChild that failed its readback"
say "in act 4 and wrote anyway."
KID=$($CF piece get --quiet --piece "$EPIC" children $ARGS \
  --schema '{"type":"array","items":{"$link":true}}' 2>/dev/null | jq -r '.[0]["$link"].id' | sed 's/^of://')
$CF piece call --quiet --piece "$KID" $ARGS addChild '{"title":"Rotate signing key"}' >/dev/null 2>&1
run "cf piece call --piece <epic> finish -- --body 'shipping behind a flag'" \
  $CF piece call --quiet --piece "$EPIC" $ARGS finish '{"body":"shipping behind a flag"}'

act "9 · Relate two items — PENDING"
say "The tracker is a graph, not just a tree: an item can wait on any other."
pending "cf piece call --piece <cookies> blockOn -- --on <csrf-address>" \
  "an address cannot yet be a verb argument (verbs plan item 11)" \
  '{
  "status": "settled",
  "result": {
    "blocked":         { "$link": { "id": "of:fid1:…" }, "title": "Session cookies" },
    "on":              { "$link": { "id": "of:fid1:…" }, "title": "CSRF tokens" },
    "blockedOnCount":  1
  }
}'

act "10 · One item, two paths, one address — PENDING"
say "This is what addresses are for: the same item under a parent AND as a blocker,"
say "and a caller can tell it is one item rather than two copies."
pending "cf piece get --piece board items --select 'title,children@,blockedOn@'" \
  "needs the edge from act 9" \
  'the same of:fid1:… appears under one item'"'"'s children and another'"'"'s blockedOn'

printf '\n%s━━ %s %s\n' "$B" "What just happened" "$N"
say "No tool was written for this tracker. Every flag, type and listing above"
say "was derived from the pattern's own TypeScript by cf."
say ""
say "Acts 9 and 10 are the graph half, and they are sequenced as verbs plan"
say "item 11. Acts 4 and 6 are defects, with issues open against them: #5577"
say "and #5633. verb-session-gaps.sh asserts each of the three, and fails the"
say "day any one changes — so this demo cannot quietly go stale."
