#!/usr/bin/env bash
# The bulk survey as something to watch: a board of 113 members surveyed in
# one process, the plan it emits, the retarget stamp, and the containment
# refusal — the stage-1 surface of docs/plans/piece-bulk-operations.md, run
# live rather than asserted.
#
# This is a demo, not a test. It narrates each command before running it, so
# the transcript is the artifact. Its companion `bulk-survey-drill.sh` asserts
# the same surface as pass/fail in CI and is what keeps this one honest.
#
# Every command in the transcript is one array of words, printed and then run.
# There is no second, prettier spelling of it anywhere in this file: `run`
# displays `"$@"` and executes `"$@"`, so a line that reads well and a line
# that ran cannot drift apart. What a reader sees is what they can retype,
# given the environment variables the header names. Unlike the verb-session
# demo this one carries no `broken` or `pending` helper: nothing in the
# surveyed surface is defective or unbuilt, and the helpers arrive when an
# act needs their claim.
#
#   API_URL=http://localhost:8000 packages/cli/integration/bulk-survey-demo.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# Run from the repository root so the fixture path a reader sees is the one
# they would type.
cd "$REPO_ROOT" || exit 1
BOARD_FIXTURE=packages/cli/integration/pattern/bulk-board.tsx
MEMBER_FIXTURE=packages/cli/integration/pattern/bulk-member.tsx
RETARGET_FIXTURE=packages/cli/integration/pattern/bulk-member-v2.tsx

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
SPACE="${SPACE:-$(mktemp -u surveyXXXXXXXX)}"
WORK="$(mktemp -d)"

B=$'\033[1m'; D=$'\033[2m'; C=$'\033[36m'; N=$'\033[0m'; R=$'\033[31m'
# Every act makes a claim: an unmarked one says the command works, a REFUSED
# one says the surface turns this down. Both are counted, so a transcript that
# got either wrong cannot exit 0 and read as a clean session.
UNEXPECTED=0
UNREFUSED=0
# stderr is read back rather than shown as it arrives, so a failure can be
# printed under the act it belongs to. mktemp rather than a name built from
# the pid: this runs in a shared directory, and a predictable path is one an
# unrelated process can have already made a symlink at.
ERR=$(mktemp)
trap 'rm -f "$ERR"' EXIT
act() { printf '\n%s━━ %s %s\n' "$B" "$1" "$N"; }
say() { printf '%s   %s%s\n' "$D" "$1" "$N"; }

# Render argv the way a person would have typed it, quoting only the words
# that need it. Display only — the same array is what runs.
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
# next-step hints, but a failure here is the demo being wrong about the
# surface and has to be as visible as the transcript it would otherwise sit
# inside quietly.
run() {
  printf '\n%s   $ %s%s\n' "$C" "$(shown "$@")" "$N"
  OUT=$("$@" 2>"$ERR")
  local rc=$?
  printf '%s\n' "$OUT" | sed 's/^/     /'
  if [ "$rc" != "0" ]; then
    printf '%s     UNEXPECTED FAILURE (exit %s)%s\n' "$R" "$rc" "$N"
    sed 's/^/       /' "$ERR"
    UNEXPECTED=$((UNEXPECTED + 1))
  fi
}

# `run`, with the held-back stderr hints shown after the output. The survey
# addresses its tally and its validator findings to a person as hints, and
# for the survey acts those hints are part of what this demo exists to show —
# hiding them would demonstrate a quieter command than the one that ran.
run_loud() {
  run "$@"
  # The connection preamble and the interactive tip are dropped: the tally
  # and the write confirmation are the hints this transcript is showing.
  grep -v \
    '^invocation:\|^session:\|^(Use --quiet\|^Experimental flag\|^$' \
    "$ERR" | sed "s/^/     ${D}·${N} /"
}

# `run`, for a command that is SUPPOSED to fail: a refusal is a capability, so
# the error is the act's payoff and a nonzero exit is the success condition.
# The claim is matched against the refusal's own message, not the exit status
# alone: a parser slip or a server hiccup also exits nonzero, and an act that
# cannot tell those apart keeps its claim through failures that have nothing
# to do with it.
refused() {
  local why=$1 signature=$2
  shift 2
  printf '\n%s   $ %s%s\n' "$C" "$(shown "$@")" "$N"
  printf '%s     REFUSED — %s%s\n' "$D" "$why" "$N"
  CF_SKIP_VERSION_CHECK=1 "$@" >/dev/null 2>"$ERR"
  local rc=$?
  grep -v '^invocation:\|^session:\|^TIP:\|^(Use --quiet\|^NEXT STEPS:\|^  *→\|^Experimental flag' \
    "$ERR" | grep -v '^$' | sed 's/^/       /'
  if [ "$rc" = "0" ]; then
    printf '%s     NOT REFUSED — this act says the surface turns this down,%s\n' \
      "$R" "$N"
    printf '%s     and it was accepted%s\n' "$R" "$N"
    UNREFUSED=$((UNREFUSED + 1))
  elif ! grep -q "$signature" "$ERR"; then
    printf '%s     REFUSED FOR ANOTHER REASON — the failure above is not the%s\n' \
      "$R" "$N"
    printf '%s     refusal this act claims%s\n' "$R" "$N"
    UNREFUSED=$((UNREFUSED + 1))
  fi
}

printf '%s\n' "${B}A board-sized survey, watched end to end${N}"
say "A board holds a collection of member pieces it created through its own"
say "verb — which is exactly why the piece registry does not know them. The"
say "survey reads the collection the registry cannot see, one cheap identity"
say "read per member, and emits a plan: the artifact every later bulk stage"
say "consumes (docs/plans/piece-bulk-operations.md)."
say ""
say "space $SPACE · CF_API_URL=$CF_API_URL · CF_IDENTITY exported;"
say "everything else you see is the whole command."

act "1 · A board, and members filed through its verb"
say "The board arrives with a name, so no fid is ever typed again."
run cf piece new "$BOARD_FIXTURE" -s "$SPACE" --slug board
say "Three members through the verb, one by one —"
run cf call -q -s "$SPACE" --piece board addMember '{"title":"alpha"}'
run cf call -q -s "$SPACE" --piece board addMember '{"title":"beta"}'
run cf call -q -s "$SPACE" --piece board addMember '{"title":"gamma"}'

act "2 · Board-sized in one call"
say "113 matches the motivating Topics board. The remaining 110 arrive as one"
say "dispatch, because a demo should spend its time surveying, not seeding."
run cf call -q -s "$SPACE" --piece board seedMembers '{"count":110}'

act "3 · The survey"
say "One process, the whole collection: a plan row per member, the holder"
say "last, and a tally answering 'do these pieces all agree?' without reading"
say "every row."
run_loud cf piece survey -s "$SPACE" --piece board --path items --out "$WORK/plan.jsonl"
say "The plan is line-oriented JSON: a header that accounts for the"
say "selection, then one row per piece. The header —"
run sh -c "head -1 '$WORK/plan.jsonl' | jq -c '{selector, enumerated}'"
say "— and the first member row and the holder row. Every row records the"
say "identity the piece runs today and whether that source is still retained:"
say "the rollback question, answered before any write is planned."
run sh -c "sed -n 2p '$WORK/plan.jsonl' | jq ."
run sh -c "tail -1 '$WORK/plan.jsonl' | jq ."
run sh -c "wc -l < '$WORK/plan.jsonl'"

act "4 · One piece's pin, without running it"
say "The same identity fact the survey reads per member, as a single lookup:"
say "no piece started, no input or result pulled."
run cf piece inspect -s "$SPACE" --piece board --pattern-identity

act "5 · A survey that carries the operation"
say "The plan can carry the work as well as the record: a retarget stamped"
say "onto every row whose phase matches, pinned to the identity the on-disk"
say "source produces — not to a path that could drift before the apply."
run_loud cf piece survey -s "$SPACE" --piece board --path items \
  --retarget "items=$RETARGET_FIXTURE@v2" --main-export Member \
  --out "$WORK/retarget.jsonl"
say "One member row now: expect is where the piece stands, op is where this"
say "plan will take it."
run sh -c "sed -n 2p '$WORK/retarget.jsonl' | jq '{piece, expect, op}'"

act "6 · The survey is a live read"
say "File one more member, survey again: the count moves. No cache to"
say "invalidate, nothing to refresh."
run cf call -q -s "$SPACE" --piece board addMember '{"title":"delta"}'
run_loud cf piece survey -s "$SPACE" --piece board --path items --out "$WORK/after.jsonl"
run sh -c "head -1 '$WORK/after.jsonl' | jq -c .enumerated"

act "7 · The refusal the survey exists to make"
say "Deploy a member directly, so the registry knows a piece the board's"
say "collection does not hold. A silent subset is the failure bulk operations"
say "die of, so the survey stops and names it rather than emitting a plan"
say "that quietly misses a piece."
run cf piece new -q --main-export Member "$MEMBER_FIXTURE" -s "$SPACE"
refused "a registered in-scope piece the collection lacks stops the survey" \
  "registered outside the selection" \
  cf piece survey -s "$SPACE" --piece board --path items
say "The plan the later stages consume is therefore complete by construction:"
say "an incomplete survey refuses to produce one, and a serialized plan"
say "carries the incompleteness so no write stage can consume it either."

act "8 · A list survey claims only what it read"
say "Naming pieces directly skips the containment check — and says so: the"
say "header records the selector, so a reader of the plan knows no"
say "containment claim was made. The orphan is still out there; this survey"
say "just never claimed otherwise."
run_loud cf piece survey -s "$SPACE" --list board --out "$WORK/list.jsonl"
run sh -c "head -1 '$WORK/list.jsonl' | jq -c '{selector, enumerated}'"

printf '\n%s━━ The shape of it %s\n' "$B" "$N"
say "One process surveyed a board-sized collection and emitted the plan the"
say "later stages consume; the same command carried a retarget when asked;"
say "and the one refusal shown is the survey's reason to exist: no plan that"
say "silently misses a piece."

if [ "$UNEXPECTED" != "0" ]; then
  printf '\n%s━━ %d act(s) failed that this demo says work%s\n' \
    "$R" "$UNEXPECTED" "$N"
  say "Every act above that is not marked REFUSED is a claim about the"
  say "surface. One of them did not hold, so this transcript does not"
  say "describe cf."
fi

if [ "$UNREFUSED" != "0" ]; then
  printf '\n%s━━ %d act(s) marked REFUSED did not get their refusal%s\n' \
    "$R" "$UNREFUSED" "$N"
  say "A refusal this demo shows as a capability is no longer being made as"
  say "claimed: the call was accepted, or it failed for some other reason —"
  say "either way the act's claim about the surface did not hold."
fi

[ "$UNEXPECTED" = "0" ] && [ "$UNREFUSED" = "0" ]
