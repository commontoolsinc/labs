#!/usr/bin/env bash
# The shuttle walkthrough: open `cf sh` on a real space, on a real terminal,
# and read back what it drew.
#
# Shuttle's unit suite drives every module with nothing behind it — no server,
# no piece, and no terminal. `packages/cli/test/shuttle-terminal.test.ts` says
# so of itself: "A handler that the runtime never runs, and a `setRaw` that the
# driver never honours, would both pass here." What no case there can see is
# the composition: whether a `cd` that a stub accepted lands on a cell the
# fabric holds, whether the reference a listing printed is the one the next
# line takes, and whether what a read serves is what storage holds. Each of
# those is a property of the seams together and of no module, so this is where
# they are asserted.
#
# The terminal is a real one. `cf sh` refuses to start unless both standard
# streams are terminals, because it reads keys in raw mode and draws lines back
# with escape sequences, so this drives it through a pseudo-terminal:
# `shuttle-terminal.py` holds the master, types the lines, and takes the
# drawing apart into one record per line — the line, what the shell wrote above
# the next prompt, and the prompt it then drew. Its own header says how the
# drawing is read apart and why no wait here is a poll.
#
# The prompt is half of every assertion below, because after a `cd` the prompt
# is the whole of what the verb did: a `cd` that was refused and a `cd` that
# moved differ in where the next line is typed, and nothing else.
#
# It deploys pattern/shuttle-place.tsx and nothing else. That fixture belongs
# to this walkthrough alone, so a change to a pattern the product actually
# ships can never break a demonstration of what a shell can reach.
#
# No step here asserts a GAP: the tally on the last line runs at zero. The
# machinery is kept, as `verb-session-gaps.sh` and `completion-over-the-cli.sh`
# keep theirs, because a step that finds a capability missing has to be able to
# say so and be counted rather than merely fail.
#
# Documented in packages/cli/README.md's "Interactive shell" section, which
# explains the shell this exercises. Keep the two in step: the doc is the
# explanation, this is the proof, and each names the other.
#
# Run standalone against any host:
#   API_URL=http://localhost:8000 packages/cli/integration/shuttle-over-a-terminal.sh
#
# CI runs it through integration.sh's `piece-call` section (the
# cli-integration matrix in .github/workflows/deno.yml); the `shuttle` section
# is the standalone selector for running just this script by hand.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
API_URL="${API_URL:-http://localhost:8000}"
FIXTURE="$SCRIPT_DIR/pattern/shuttle-place.tsx"
DRIVER="$SCRIPT_DIR/shuttle-terminal.py"

# Prefer a built binary when the harness supplies one; fall back to source.
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
contains() {
  case "$2" in
    *"$1"*) ok "$3" ;;
    *) bad "$3 (nothing matching [$1] in [$2])" ;;
  esac
}
lacks() {
  case "$2" in
    *"$1"*) bad "$3 (found [$1] in [$2])" ;;
    *) ok "$3" ;;
  esac
}

SPACE="${SPACE:-$(mktemp -u shuttleXXXXXXXX)}"
if [ -z "${CF_IDENTITY:-}" ]; then
  CF_IDENTITY=$(mktemp)
  $CF id new >"$CF_IDENTITY" 2>/dev/null
fi
ARGS="--api-url=$API_URL --identity=$CF_IDENTITY --space=$SPACE"

# The host's server-execution posture, which one step below turns on: with the
# serving loop running, the server may recompute a piece nobody asked to run,
# and a value read cold would then be warm through no doing of the shell's.
#
# It answers with three words and not two, because the third is a different
# fact. A host that says nothing is not a host that says it does not execute,
# and the step that reads this makes no claim at all on `unreadable` — where
# folding the two together would let a quiet server decide which assertions the
# walkthrough makes, and report as though it had established something it never
# asked about.
#
# For the same reason the request carries no deadline of its own, where the
# walkthroughs beside this one bound theirs. `docs/development/waiting-in-tests.md`
# names the shape under "Browser-hosted unit tests have a harness backstop": a
# bound at a call site caps what that call can observe, and here what it would
# cap is a verdict — a health endpoint answering a second after the bound would
# be read as a server that does not execute. By the time this runs the same host
# has answered two deploys, a write and a whole session, so a request that never
# comes back is a server that stopped, and the bound around the suite is what
# says so.
POSTURE=""
read_posture() {
  case "${EXPERIMENTAL_SERVER_EXECUTION:-}" in
    true) POSTURE="on"; return ;;
    false) POSTURE="off"; return ;;
  esac
  local stats status
  stats=$(curl -fsS "$API_URL/api/health/stats" 2>/dev/null)
  status=$?
  if [ "$status" -ne 0 ]; then
    POSTURE="unreadable: the health endpoint exited $status"
  elif ! printf '%s' "$stats" | jq -e 'type == "object"' >/dev/null 2>&1; then
    POSTURE="unreadable: the health endpoint answered no JSON object"
  elif printf '%s' "$stats" | jq -e '.servingLoop != null' >/dev/null 2>&1; then
    POSTURE="on"
  else
    POSTURE="off"
  fi
}

echo "API_URL=$API_URL"
echo "SPACE=$SPACE"
START=$(date +%s)

step "1. Deploy the fixture under two slugs"
# --quiet makes the piece id stdout's only line; stderr is dropped and the
# grep anchored so a compile warning carrying a fid1: token cannot be taken
# for the deploy's id.
FIRST=$($CF piece new --quiet --slug first "$FIXTURE" $ARGS 2>/dev/null |
  grep -oE '^fid1:[A-Za-z0-9_-]+' | head -1)
SECOND=$($CF piece new --quiet --slug second "$FIXTURE" $ARGS 2>/dev/null |
  grep -oE '^fid1:[A-Za-z0-9_-]+' | head -1)
if [ -n "$FIRST" ] && [ -n "$SECOND" ]; then
  ok "deployed $FIRST and $SECOND"
else
  bad "deploy failed"
  exit 1
fi

step "2. Write one item from outside, before any shell exists"
# The write goes to the arguments cell, which changes what storage holds
# without running the pattern. Doing it here rather than from inside a session
# is what makes the reads below say something: the shell connects afterwards,
# so what it serves is what it found, with no push to have raced.
if echo '["bread"]' | $CF cell set --quiet --input --cell first items $ARGS \
  >/dev/null 2>&1; then
  ok "wrote items to the arguments cell of first"
else
  bad "the external write failed"
fi
# What storage holds for the computed member, read here because here is the
# only place it can be read: reaching in warms, and a warm run commits what it
# computed, so once a session has stood on this piece nothing can read what
# storage held before it. Step 11 compares this with what the shell serves.
STORED=$($CF cell get --quiet --cell first summary $ARGS 2>/dev/null)

step "3. Drive a session over a pseudo-terminal"
SCRIPT=$(mktemp)
TRANSCRIPT=$(mktemp)
cat >"$SCRIPT" <<'LINES'
where
ls
cd slugs
ls
cd nosuchslug
cd first
ls
get label
get items
get summary
cd nosuchkey
cd settings
ls
cd ..
cd /
cd /slugs/first
pwd
get
help
get --help
LINES
python3 "$DRIVER" "$SCRIPT" "$TRANSCRIPT" -- \
  $CF sh $ARGS >/dev/null
DRIVE_STATUS=$?
check "0" "$DRIVE_STATUS" "the session ran and ended on ctrl-d with a zero status"
if [ "$DRIVE_STATUS" -ne 0 ]; then
  echo "  the shell did not complete the session; nothing below can be read"
  exit 1
fi

# What the shell said in answer to the Nth line, and the prompt it then drew.
#
# Each takes the line it expects as well as its number, because an edit to the
# script above shifts every number after it and a walkthrough that silently
# asserted against the neighbouring line would be worse than one that stopped.
# A disagreement comes back as a sentence no assertion can match, so the check
# that asked for it fails and says which record it wanted — the count cannot be
# raised from here, every caller reading these through a command substitution
# that runs them in a subshell of its own.
misread() {
  printf '<<transcript step %s is [%s], not [%s]>>\n' "$1" "$2" "$3"
}
said() {
  local at="$1" want="$2" got
  got=$(jq -r ".[$at].line // \"\"" "$TRANSCRIPT")
  if [ "$got" != "$want" ]; then misread "$at" "$got" "$want"; return; fi
  jq -r ".[$at].said" "$TRANSCRIPT"
}
prompt() {
  local at="$1" want="$2" got
  got=$(jq -r ".[$at].line // \"\"" "$TRANSCRIPT")
  if [ "$got" != "$want" ]; then misread "$at" "$got" "$want"; return; fi
  jq -r ".[$at].prompt" "$TRANSCRIPT"
}

step "4. The shell opens on the space root"
check "shuttle / @space> " "$(jq -r '.[0].prompt' "$TRANSCRIPT")" \
  "the first prompt stands at the space root"

step "5. where names the connection the flags asked for"
WHERE=$(said 1 "where")
contains "api       $API_URL" "$WHERE" "where names the host it connected to"
contains "space     $SPACE" "$WHERE" "where names the space it connected to"
contains "identity  $CF_IDENTITY" "$WHERE" "where names the identity it opened"

step "6. ls at the root lists the facets, and cd takes one of them"
check "%1 slugs
%2 pieces" "$(said 2 "ls")" "the root lists exactly the two facets"
check "shuttle /slugs/ @space> " "$(prompt 3 "cd slugs")" \
  "cd into the slug facet moves the prompt onto it"

step "7. The slug index names both deployed slugs"
SLUGS=$(said 4 "ls")
contains "%1 first" "$SLUGS" "the listing numbers the first slug"
contains "%2 second" "$SLUGS" "the listing numbers the second slug"

step "8. A slug the index does not record is refused, and nothing moves"
REFUSED_SLUG=$(said 5 "cd nosuchslug")
contains "nosuchslug\` reaches no piece" "$REFUSED_SLUG" \
  "cd names the slug it could not reach"
check "shuttle /slugs/ @space> " "$(prompt 5 "cd nosuchslug")" \
  "a refused cd leaves the prompt where it stood"

step "9. A slug the index does record lands on the piece it names"
check "shuttle first @space> " "$(prompt 6 "cd first")" \
  "the prompt carries the name the index confirmed"
check "%1 \$NAME
%2 \$UI
%3 addItem
%4 items
%5 label
%6 settings
%7 summary" "$(said 7 "ls")" "the piece lists every key the fixture declares"

step "10. get reads a stored value, and reads it as storage holds it"
check '"a place"' "$(said 8 "get label")" "get reads a stored scalar"
check '[
  "bread"
]' "$(said 9 "get items")" "get serves the item the external write left"

step "11. Reaching into a piece warms it, so a computed value reads live"
# Decision 10 of docs/plans/shuttle/README.md rules that reaching in warms, so
# that every read the shell serves is live. `summary` is computed from `items`,
# and the write in step 2 changed `items` without running the pattern: storage
# therefore holds what the deploy left, and a shell standing on the piece
# serves what the pattern computes from what is there now. Both readings are
# asserted, because either alone is equally consistent with the other value
# never having existed — a warm reading with no stale one beside it says only
# that the fixture computes something.
#
# The claim is only readable with the serving loop off. With it on, the server
# may run the piece for reasons of its own, and a warm `summary` would then say
# nothing about whether the shell warmed anything — and with the posture
# unreadable, neither does anything else, so the step says that rather than
# picking the arm that happens to pass.
WARM=$(said 10 "get summary")
read_posture
case "$POSTURE" in
  on)
    ok "skipped: the server executes, so a warm value would not be the shell's doing"
    ;;
  off)
    check '""' "$STORED" \
      "storage holds what the deploy left, the write having run nothing"
    check '"bread"' "$WARM" \
      "the shell serves what the pattern computes from the written item"
    ;;
  *)
    bad "the server-execution posture is $POSTURE, so this step can read nothing"
    ;;
esac

step "12. A path the cell does not hold is refused, with the keys that are"
# The review this walkthrough answers found `cd` adopting a key that was not
# there, and every later line failing with the runtime's own words one command
# further on. Both halves are asserted: the refusal is shuttle's and names what
# would have worked, and the place is where it was.
REFUSED_KEY=$(said 11 "cd nosuchkey")
contains "nosuchkey\` reaches no cell" "$REFUSED_KEY" \
  "cd refuses a key the cell does not hold"
contains "whose keys are \`\$NAME\`" "$REFUSED_KEY" \
  "the refusal names the keys that would have worked"
check "shuttle first @space> " "$(prompt 11 "cd nosuchkey")" \
  "a refused cd leaves the place where it stood"

step "13. cd walks into a nested value and back out of it"
check "shuttle first/settings @space> " "$(prompt 12 "cd settings")" \
  "cd stands two segments inside the piece"
check "%1 depth
%2 note" "$(said 13 "ls")" "the nested object lists its own keys"
check "shuttle first @space> " "$(prompt 14 "cd ..")" \
  "cd .. climbs back to the piece root"

step "14. A rooted reference opening with a facet walks from the root"
# The other half of the review's finding: `/slugs/first` read as a piece
# slugged `slugs` would have been a trap one level down from the spelling the
# root teaches. It reaches the same piece the relative spelling did, and `pwd`
# names the handle the deploy printed.
#
# The `cd /` in front of it is what makes the claim about the reference rather
# than about where the line before it left off: with the shell already standing
# at the piece, a `/slugs/first` that was refused would leave the prompt
# reading exactly what a `/slugs/first` that landed leaves it reading, and the
# check could not tell the two apart. So the shell is sent to the root first,
# and both halves are read — that the line said nothing, and that the prompt
# moved.
check "shuttle / @space> " "$(prompt 15 "cd /")" \
  "the shell is standing at the root before the rooted reference is read"
check "" "$(said 16 "cd /slugs/first")" \
  "a rooted facet reference is not refused"
check "shuttle first @space> " "$(prompt 16 "cd /slugs/first")" \
  "a rooted facet reference reaches the piece the slug names"
contains "$FIRST" "$(said 17 "pwd")" "pwd names the handle the deploy printed"

step "15. get at a piece stands in for its picture of itself"
WHOLE=$(said 18 "get")
contains '"$UI": "<elided' "$WHOLE" "the UI node is stood in for"
# `children` is the key every vnode carries and the first one the tree would
# write, so it is the part of the node that reaches the page rather than a part
# a bound would have cut off anyway.
lacks '"children"' "$WHOLE" "no part of the vnode tree reaches the screen"
contains '"label": "a place"' "$WHOLE" "the rest of the piece is written out"

step "16. The shell has help, and a verb's --help is a page rather than a path"
HELP=$(said 19 "help")
contains "cd <ref>" "$HELP" "help lists the verb that moves"
contains "get [<ref>]" "$HELP" "help lists the verb that reads"
GET_HELP=$(said 20 "get --help")
contains "Usage: get [<ref>]" "$GET_HELP" "--help writes the verb's page"
lacks "names no facet" "$GET_HELP" "--help is not read as a path"

# What step 11 does not reach: a piece that changes under a shell already
# standing on it. Step 11 reads storage before the session and the shell's own
# answer during it, which is what tells a warm read from a stored one; what it
# cannot ask is whether a read taken after an external write mid-session serves
# the new value, because the driver types a script of lines and has nowhere to
# run a command between two of them. It reads a settled prompt already, so that
# is a small addition to it, and the check belongs here once it is made.

rm -f "$SCRIPT" "$TRANSCRIPT"
ELAPSED=$(($(date +%s) - START))
printf '\n== %d passed, %d failed, %d gaps open — %ds wall clock\n' \
  "$PASS" "$FAIL" "$GAPS" "$ELAPSED"
[ "$FAIL" -eq 0 ]
