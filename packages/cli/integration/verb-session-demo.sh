#!/usr/bin/env bash
# The verb session as it is meant to read: a work tracker driven entirely
# through `cf`, with no tooling written for it.
#
# This is a demo, not a test. It narrates each command before running it, so
# the transcript is the artifact. Its companion `verb-session-gaps.sh` asserts
# the same surface as pass/fail and is what keeps this one honest.
#
# docs/common/verb-session-walkthrough.md is the prose half: why the fixture
# declares the verbs it does, and which shape of the surface each act is here
# to show. An act added here without a row there is an act nobody can place.
#
# Every command in the transcript is one array of words, printed and then run.
# There is no second, prettier spelling of it anywhere in this file: `run` and
# `broken` display `"$@"` and execute `"$@"`, so a line that reads well and a
# line that ran cannot drift apart. What a reader sees is what they can retype,
# given the two environment variables the header names.
#
# Two acts are marked PENDING. They print the command and the result they will
# produce, without running it, because the capability is sequenced and not yet
# built (docs/plans/references-as-arguments.md). They are deliberately visible —
# a demo that quietly omits what does not work teaches a surface that does not
# exist.
#
# No act is marked BROKEN today. `broken` stays for the next one that is: it
# checks that the defect an act claims still answers to its own signature, so
# an act cannot go on asserting a defect that has been fixed. Deriving that
# again from scratch is how it acquires the same hole twice.
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
export CF_API_URL="${CF_API_URL:-${API_URL:-http://localhost:8000}}"
if [ -z "${CF_IDENTITY:-}" ]; then
  CF_IDENTITY=$(mktemp)
  cf id new >"$CF_IDENTITY" 2>/dev/null
fi
export CF_IDENTITY
SPACE="${SPACE:-$(mktemp -u demoXXXXXXXX)}"

B=$'\033[1m'; D=$'\033[2m'; C=$'\033[36m'; Y=$'\033[33m'; N=$'\033[0m'
R=$'\033[31m'
# Every act makes a claim: one not marked BROKEN says the command works, one
# marked BROKEN says a named defect is still there. Both are counted, so a
# transcript that got either wrong cannot exit 0 and read as a clean session.
UNEXPECTED=0
CLOSED=0
# stderr is read back rather than shown as it arrives, so a failure can be
# printed under the act it belongs to. mktemp rather than a name built from the
# pid: this runs in a shared directory, and a predictable path is one an
# unrelated process can have already made a symlink at.
ERR=$(mktemp)
trap 'rm -f "$ERR"' EXIT
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
# stderr is held back rather than dropped: on success it carries only cf's
# next-step hints, which are addressed to a person at a prompt rather than to a
# transcript, but a failure here is the demo being wrong about the surface —
# the thing this script exists to stop — and has to be as visible as the
# transcript it would otherwise sit inside quietly.
run() {
  printf '\n%s   $ %s%s\n' "$C" "$(shown "$@")" "$N"
  OUT=$("$@" 2>"$ERR")
  local rc=$?
  printf '%s\n' "$OUT" | sed 's/^/     /'
  if [ "$rc" != "0" ]; then
    printf '%s     UNEXPECTED FAILURE (exit %s) — this act is not marked BROKEN%s\n' \
      "$R" "$rc" "$N"
    sed 's/^/       /' "$ERR"
    UNEXPECTED=$((UNEXPECTED + 1))
  fi
}

# Same, for a command that fails today: stderr is kept, because the error is
# what the act exists to show. cf's two progress lines are dropped so it stands
# alone.
#
# The BROKEN claim is checked, against the defect's own signature rather than
# against the exit status — #5633 answers 0 and hands back nulls, so a status
# check would call this act healthy today. `$2` is a jq test over stdout that
# holds only while the defect does, and it is the same discriminator
# verb-session-gaps.sh matches on, so the two cannot disagree about whether the
# gap is open. An act asserting a defect that has been fixed is wrong in the
# same way as one hiding a defect that has not.
#
# A future act that breaks by failing outright wants its signature written
# against the exit status, and wants the branch for that written then rather
# than guessed at now.
broken() {
  local why=$1 signature=$2
  shift 2
  printf '\n%s   $ %s%s\n' "$Y" "$(shown "$@")" "$N"
  printf '%s     BROKEN — %s%s\n' "$Y" "$why" "$N"
  local out
  out=$("$@" 2>"$ERR")
  [ -n "$out" ] && printf '%s\n' "$out" | sed 's/^/       /'
  grep -v '^invocation:\|^session:' "$ERR" | sed 's/^/       /'
  if ! printf '%s' "$out" | jq -e "$signature" >/dev/null 2>&1; then
    printf '%s     GAP CLOSED — the defect this act names no longer answers to%s\n' \
      "$R" "$N"
    printf '%s     its own signature%s\n' "$R" "$N"
    CLOSED=$((CLOSED + 1))
  fi
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
# The address the reader can see in the output above, carried whole. `--piece`
# takes the `of:` form a read prints, on `get`, `call` and `verbs` alike, so
# nothing here strips the scheme: the string passed below is the string act 4
# displayed, which is the round-trip property this session exists to show. The
# bare hash is a different spelling that resolves by defaulting to `of:`, not
# the same address — the scheme is part of the identity.
EPIC=$(printf '%s' "$OUT" | jq -r '.result.item."$link".id')
say "That id is what --piece takes from here on. Ask it the same question act 2"
say "asked the board, before assuming anything about what it can do."
run cf piece verbs -s "$SPACE" --piece "$EPIC"
say "Every verb an item has, and not the board's one: the listing is derived"
say "from the piece in front of you, so an address is enough to discover a"
say "surface you were never told about."
run cf piece call -s "$SPACE" --piece "$EPIC" addChild -- --title "Session cookies"
say "The item it hands back can be reached from inside itself: its parent holds"
say "it, and it holds its parent. The position where the author's own type"
say "re-enters answers with an address, so the whole result is still one value."
run cf piece call -s "$SPACE" --piece "$EPIC" --select item.title addChild -- --title "CSRF tokens"
say "And a caller who names one field is given one field, circle or no circle."

act "5 · Read addresses instead of contents"
say "An unshaped read follows every link. A bare @ stops at the address."
run cf piece get -s "$SPACE" --piece "$EPIC" children --select @,title

act "6 · Ask the same question twice"
say "The first thing anyone watching says is 'show me that again'."
run cf piece get -s "$SPACE" --piece "$EPIC" children --select @,title
say "The same answer. A projection is a question you may ask twice, which is"
say "what makes any of the reads above safe to put in a script."

act "7 · A verb returns what only the pattern could compute"
say "The note's timestamp is the pattern's; the caller never supplied one."
run cf piece call -s "$SPACE" --piece "$EPIC" recordNote -- --body "blocked on the cookie spec"

act "8 · Finishing reports what the caller could not know"
say "openBelow walks the whole subtree — a caller would need N reads to learn it."
say "A grandchild is filed first, so there is a subtree to walk."
KID=$(cf piece get -s "$SPACE" --piece "$EPIC" children --select @ 2>/dev/null |
  jq -r '.[0]."$link".id')
run cf piece call -s "$SPACE" --piece "$KID" --select item.title addChild -- --title "Rotate signing key"
run cf piece call -s "$SPACE" --piece "$EPIC" finish -- --body "shipping behind a flag"

act "9 · A verb that declares no result"
say "archive is Stream<void>: there is nothing for it to hand back, and the"
say "invocation says so by settling with no result at all."
run cf piece call -s "$SPACE" --piece "$KID" archive -- invoke
say "What it changed is a read away, on the one field the caller never sets."
run cf piece get -s "$SPACE" --piece "$KID" status

act "10 · Relate two items — PENDING"
say "The tracker is a graph, not just a tree: an item can wait on any other."
pending "cf piece call -s $SPACE --piece <cookies> blockOn -- --on <csrf-address>" \
  "an address cannot yet be a verb argument (references-as-arguments.md)" \
  '{
  "status": "settled",
  "result": {
    "blocked":         { "$link": { "id": "of:fid1:…" }, "title": "Session cookies" },
    "on":              { "$link": { "id": "of:fid1:…" }, "title": "CSRF tokens" },
    "blockedOnCount":  1
  }
}'

act "11 · One item, two paths, one address — PENDING"
say "This is what addresses are for: the same item under a parent AND as a blocker,"
say "and a caller can tell it is one item rather than two copies."
pending "cf piece get -s $SPACE --piece board items --select title,children@,blockedOn@" \
  "needs the edge from act 10" \
  'the same of:fid1:… appears under one item'"'"'s children and another'"'"'s blockedOn'

printf '\n%s━━ %s %s\n' "$B" "What just happened" "$N"
say "No tool was written for this tracker. Every flag, type, listing and result"
say "field above was derived from the pattern's own TypeScript by cf."
say ""
say "One name was typed: 'board'. Everything under it was addressed by the id a"
say "call handed back — which is the composition the verb surface exists for,"
say "and the reason those lines are as long as they are."
say ""
say "Acts 10 and 11 are the graph half, sequenced as references-as-arguments."
say "verb-session-gaps.sh asserts both, and fails the day either one starts"
say "working — so this demo cannot quietly go stale."

if [ "$UNEXPECTED" != "0" ]; then
  printf '\n%s━━ %d act(s) failed that this demo says work%s\n' \
    "$R" "$UNEXPECTED" "$N"
  say "Every act above that is not marked BROKEN is a claim about the surface."
  say "One of them did not hold, so this transcript does not describe cf."
fi

if [ "$CLOSED" != "0" ]; then
  printf '\n%s━━ %d act(s) marked BROKEN no longer match their signature%s\n' \
    "$R" "$CLOSED" "$N"
  say "Either the capability arrived, or the signature needs rewriting. Both"
  say "want this demo and verb-session-gaps.sh changed together — they match on"
  say "the same evidence so that neither can go stale alone."
fi

[ "$UNEXPECTED" = "0" ] && [ "$CLOSED" = "0" ]
