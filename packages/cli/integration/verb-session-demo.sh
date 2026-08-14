#!/usr/bin/env bash
# The verb session as it is meant to read: a work tracker driven entirely
# through `cf`, with no tooling written for it.
#
# This is a demo, not a test. It narrates each command before running it, so
# the transcript is the artifact. Its companion `verb-session-gaps.sh` asserts
# the same surface as pass/fail and is what keeps this one honest.
#
# Every command in the transcript is one array of words, printed and then run.
# There is no second, prettier spelling of it anywhere in this file: `run` and
# `broken` display `"$@"` and execute `"$@"`, so a line that reads well and a
# line that ran cannot drift apart. What a reader sees is what they can retype,
# given the two environment variables the header names.
#
# Two acts are marked PENDING. They print the command and the result they will
# produce, without running it, because the capability is sequenced and not yet
# built (verbs plan item 11 — docs/plans/references-as-arguments.md). One is
# marked BROKEN: it runs, it fails, and its error is printed as it arrives.
# Both are deliberately visible — a demo that quietly omits what does not work
# teaches a surface that does not exist.
#
# One constraint on anyone editing this file: while #5633 is open, no two reads
# may share a (source cell, schema) pair — the second one silently drops every
# projected field. Act 6 is that failure, on purpose. Every other read here uses
# a pair no other read uses, which is the only reason they pass.
#
#   API_URL=http://localhost:8000 packages/cli/integration/verb-session-demo.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# Run from the repository root so the fixture path a reader sees is the one
# they would type.
cd "$REPO_ROOT" || exit 1
FIXTURE=packages/cli/integration/pattern/tracker.tsx

# `cf` is this checkout's CLI as a shell function. That is what lets a command
# be a plain array of words rather than a string assembled twice.
if [ -n "${CF_BINARY:-}" ]; then
  cf() { "$CF_BINARY" "$@"; }
else
  cf() { deno task --quiet --cwd "$REPO_ROOT" cf "$@"; }
fi

# The connection lives in the environment cf documents, so it stays off every
# command line. The space cannot: cf has no environment variable for it, so
# `-s` is on each command, exactly as a reader would have to type it.
export CF_API_URL="${API_URL:-http://localhost:8000}"
if [ -z "${CF_IDENTITY:-}" ]; then
  CF_IDENTITY=$(mktemp)
  cf id new >"$CF_IDENTITY" 2>/dev/null
fi
export CF_IDENTITY
SPACE="${SPACE:-$(mktemp -u demoXXXXXXXX)}"

B=$'\033[1m'; D=$'\033[2m'; C=$'\033[36m'; Y=$'\033[33m'; N=$'\033[0m'
act() { printf '\n%s━━ %s %s\n' "$B" "$1" "$N"; }
say() { printf '%s   %s%s\n' "$D" "$1" "$N"; }

# Render argv the way a person would have typed it, quoting only the words that
# need it. Display only — the same array is what runs.
shown() {
  local line="" word
  for word in "$@"; do
    case $word in
      *[[:space:]\'\"]*) line="$line '$word'" ;;
      *) line="$line $word" ;;
    esac
  done
  printf '%s' "${line# }"
}

# Print a command and run it. Its output is shown and also kept in $OUT, so an
# act that needs an address takes it out of the run the reader just watched.
# stderr is dropped: it carries cf's next-step hints, which are addressed to a
# person at a prompt rather than to a transcript.
run() {
  printf '\n%s   $ %s%s\n' "$C" "$(shown "$@")" "$N"
  OUT=$("$@" 2>/dev/null)
  printf '%s\n' "$OUT" | sed 's/^/     /'
}

# Same, for a command that fails today: stderr is kept, because the error is
# what the act exists to show. cf's two progress lines are dropped so it stands
# alone.
broken() {
  local why=$1
  shift
  printf '\n%s   $ %s%s\n' "$Y" "$(shown "$@")" "$N"
  printf '%s     BROKEN — %s%s\n' "$Y" "$why" "$N"
  "$@" 2>&1 | grep -v '^invocation:\|^session:' | sed 's/^/       /'
}

# Show what a command will do once the capability it needs is built.
pending() {
  printf '\n%s   $ %s%s\n' "$Y" "$1" "$N"
  printf '%s     PENDING — %s%s\n' "$Y" "$2" "$N"
  printf '%s     will print:%s\n' "$D" "$N"
  printf '%s\n' "$3" | sed 's/^/       /'
}

printf '%s\n' "${B}A work tracker, driven entirely through cf${N}"
say "space $SPACE · nothing here was written for this pattern"
say "CF_API_URL=$CF_API_URL and CF_IDENTITY are exported; everything else you see"
say "is the whole command."

act "1 · Arrive by name"
say "A slug is a name in the space: the board is 'board' from here on, and the"
say "fid this command prints is never typed again."
run cf piece new "$FIXTURE" -s "$SPACE" --slug board

act "2 · Ask what it can do"
say "The listing is derived from the deployed pattern, not from a manifest."
run cf piece verbs -s "$SPACE" --piece board

act "3 · Ask what a verb wants"
say "Flags, types, required-ness and result all come from the author's TypeScript."
run cf piece call -s "$SPACE" --piece board addItem -- --help

act "4 · Create, and act on what you were handed"
say "The create returns the piece it made. Its address is the next command's target."
run cf piece call -s "$SPACE" --piece board --select item@ addItem -- --title "Login rewrite"
# The address the reader can see in the output above. Taken from that run, not
# from a second one: `run` leaves the output it displayed in $OUT.
EPIC=$(printf '%s' "$OUT" | jq -r '.result.item."$link".id' | sed 's/^of://')
say "That id is what --piece takes from here on."
run cf piece call -s "$SPACE" --piece "$EPIC" addChild -- --title "Session cookies"
say "The item it hands back can be reached from inside itself: its parent holds"
say "it, and it holds its parent. The position where the author's own type"
say "re-enters answers with an address, so the whole result is still one value."
run cf piece call -s "$SPACE" --piece "$EPIC" --select item.title addChild -- --title "CSRF tokens"
say "And a caller who names one field is given one field, circle or no circle."

act "5 · Read addresses instead of contents"
say "An unshaped read follows every link. A bare @ stops at the address."
run cf piece get -s "$SPACE" --piece "$EPIC" children --select @,title

act "6 · Ask the same question twice — BROKEN"
say "The first thing anyone watching says is 'show me that again'."
broken "a second read of one (source, schema) pair drops every projected field (#5633)" \
  cf piece get -s "$SPACE" --piece "$EPIC" children --select @,title
say "The addresses survive; the titles do not. The read reports success while"
say "returning less than it did a moment ago, which is the part worth knowing."

act "7 · A verb returns what only the pattern could compute"
say "The note's timestamp is the pattern's; the caller never supplied one."
run cf piece call -s "$SPACE" --piece "$EPIC" recordNote -- --body "blocked on the cookie spec"

act "8 · Finishing reports what the caller could not know"
say "openBelow walks the whole subtree — a caller would need N reads to learn it."
say "A grandchild is filed first, so there is a subtree to walk."
KID=$(cf piece get -s "$SPACE" --piece "$EPIC" children --select @ 2>/dev/null |
  jq -r '.[0]."$link".id' | sed 's/^of://')
run cf piece call -s "$SPACE" --piece "$KID" --select item.title addChild -- --title "Rotate signing key"
run cf piece call -s "$SPACE" --piece "$EPIC" finish -- --body "shipping behind a flag"

act "9 · Relate two items — PENDING"
say "The tracker is a graph, not just a tree: an item can wait on any other."
pending "cf piece call -s $SPACE --piece <cookies> blockOn -- --on <csrf-address>" \
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
pending "cf piece get -s $SPACE --piece board items --select title,children@,blockedOn@" \
  "needs the edge from act 9" \
  'the same of:fid1:… appears under one item'"'"'s children and another'"'"'s blockedOn'

printf '\n%s━━ %s %s\n' "$B" "What just happened" "$N"
say "No tool was written for this tracker. Every flag, type, listing and result"
say "field above was derived from the pattern's own TypeScript by cf."
say ""
say "One name was typed: 'board'. Everything under it was addressed by the id a"
say "call handed back — which is the composition the verb surface exists for,"
say "and the reason those lines are as long as they are."
say ""
say "Acts 9 and 10 are the graph half, and they are sequenced as verbs plan"
say "item 11. Act 6 is a defect, with #5633 open against it."
say "verb-session-gaps.sh asserts all three, and fails the day any one of them"
say "changes — so this demo cannot quietly go stale."
