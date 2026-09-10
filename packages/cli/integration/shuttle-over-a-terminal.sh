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
# The writing verbs are read back twice, and neither reading covers what the
# other does. A `set` that printed its receipt and wrote nothing would satisfy
# any assertion made against the transcript, and so would a `call` that settled
# without running the handler — so the session's writes are read again from
# outside once it has ended, through the same `cf cell get` step 2 takes its
# stored reading with.
#
# That second reading is taken at the end, so what it establishes is the state
# at the end rather than that each write landed: a cell written more than once
# carries only its last value, and a value another line would have produced
# anyway reads the same as one this line produced. So each check says which
# write it speaks for, and a write the final reading cannot speak for rests on
# the shell's own read on the line after it — which catches a receipt with no
# write behind it, but cannot see whether the write committed.
#
# It deploys pattern/shuttle-place.tsx and nothing else. That fixture belongs
# to this walkthrough alone, so a change to a pattern the product actually
# ships can never break a demonstration of what a shell can reach.
#
# No gap is open here, and the two steps that would carry one read a refusal's
# words back instead: a value opening with `-` is told about the bare `--` that
# writes it (step 19), and a write onto a whole piece is refused in the sentence
# `set`'s own page carries (step 20). Both are wording a prompt can act on, so
# both are pinned. The counter and the summary line stay as
# `verb-session-gaps.sh` and `completion-over-the-cli.sh` carry theirs, for
# whatever the next reading of this shell turns up.
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
# `edit` opens `$EDITOR` on the value and writes back what was saved, so the
# person is the one part of that round trip a script has to stand in for.
# Everything else stays real: this is a program `edit` runs, over a file it
# made, on a value the fabric served, and what it saves goes back through the
# same write `set` uses. Standing in for the person is not standing in for the
# system — no seam below `openEditor` is replaced, which is what would make
# this a stub rather than a walkthrough.
#
# It has no state and takes no turn: what it saves is decided by what it was
# given, so each of the three lines below reaches it with a different value and
# gets a different one of `edit`'s three endings. That is what lets one editor
# drive all three from a script the driver types in one go.
EDITOR_SCRIPT=$(mktemp)
cat >"$EDITOR_SCRIPT" <<'EDITS'
#!/usr/bin/env bash
case "$(cat "$1")" in
  '"garble me"') printf 'not json at all' >"$1" ;;
  '"edited in the editor"') : ;;
  *) printf '"edited in the editor"' >"$1" ;;
esac
EDITS
chmod +x "$EDITOR_SCRIPT"

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
more
help
get --help
set label '"a written place"'
get label
set label -- -Infinity
get label
set label -5
set . '{"label":"x"}'
set '' '"x"'
get label
verbs
call . addItem '{"text":"milk"}'
get items
call %2 '{}'
get items
call %1 '{"text":"jam"}'
get items
get summary
call . --help
edit label
get label
edit label
set label '"garble me"'
edit label
get label
link /slugs/first/label /slugs/second/label
link /slugs/first/label#argument /slugs/second/label
set label '"pointed at"'
set settings/note '"written once and never again"'
link /slugs/first/label /slugs/second/label#argument
edit
cd /pieces
ls
cd %1
pwd
LINES
EDITOR="$EDITOR_SCRIPT" python3 "$DRIVER" "$SCRIPT" "$TRANSCRIPT" -- \
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
%4 clearItems
%5 items
%6 label
%7 settings
%8 summary" "$(said 7 "ls")" "the piece lists every key the fixture declares"

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

step "15. get at a piece stands in for its picture of itself, and more writes the rest"
WHOLE=$(said 18 "get")
contains '"$UI": "<elided' "$WHOLE" "the UI node is stood in for"
# `children` is the key every vnode carries and the first one the tree would
# write, so it is the part of the node that reaches the page rather than a part
# a bound would have cut off anyway.
lacks '"children"' "$WHOLE" "no part of the vnode tree reaches the screen"
# The piece is larger than a screen, so what a page bounds is read here rather
# than assumed: the first page says it was cut, and `more` writes what it cut
# under the same reading. `label` is the member that lands on the continuation,
# which is what makes the pair an assertion about the bound rather than about
# the value — a `get` that had written the whole piece would put it on the
# first page, and a `more` with nothing held back would say so.
contains "more continues" "$WHOLE" "the first page says the rendering was cut"
contains '"label": "a place"' "$(said 19 "more")" \
  "more writes the part of the piece the page bound held back"

step "16. The shell has help, and a verb's --help is a page rather than a path"
HELP=$(said 20 "help")
contains "cd <ref>" "$HELP" "help lists the verb that moves"
contains "get [<ref>]" "$HELP" "help lists the verb that reads"
GET_HELP=$(said 21 "get --help")
contains "Usage: get [<ref>]" "$GET_HELP" "--help writes the verb's page"
lacks "names no facet" "$GET_HELP" "--help is not read as a path"

# Every step from here writes. `AFTER` takes a reading from outside the way
# step 2 took its stored one — over a connection this session never had, so a
# write that reached only the running piece and never committed fails there. It
# reads each cell once, at the end, so which write a reading is evidence for is
# a question per cell: step 27 names that write beside each of its checks, and
# the writes it cannot speak for rest on the shell's own read on the line after
# each.
AFTER() { $CF cell get --quiet --cell "$1" "$2" $ARGS 2>/dev/null; }

step "17. A set lands, and the fabric holds it after the session has gone"
check "Wrote \`label\` on \`$FIRST\`." "$(said 22 "set label '\"a written place\"'")" \
  "set receipts the path it wrote and the piece it wrote on"
check '"a written place"' "$(said 23 "get label")" \
  "the shell serves the value it just wrote"
# `label` is written five times below, so a reading of it at the end says the
# last write landed and nothing about the four before it. This one goes to a
# path nothing else in the session touches, which is what lets step 27 speak
# about a particular write rather than about whichever write reached a cell
# last.
check "Wrote \`settings/note\` on \`$FIRST\`." \
  "$(said 48 "set settings/note '\"written once and never again\"'")" \
  "a set reaches a path below the piece root, and receipts that path"

step "18. A value JSON cannot carry is refused, and the cell keeps what it had"
# `set` reads its value as JSON and a bare word as the string it spells, so the
# values it turns down are the ones that open the way JSON opens a value and
# then do not parse. `-Infinity` is one of them, and it is the same value
# `edit` refuses on the way out for the same reason: JSON has no spelling that
# writes it back. The refusal carries the parser's own words, and the reading
# after it is the half that matters — a refusal that had written anything
# would be worse than one that had not been made.
REFUSED_VALUE=$(said 24 "set label -- -Infinity")
contains "\`-Infinity\` is not JSON" "$REFUSED_VALUE" \
  "set names the value it would not write"
contains "is read as JSON; anything else is the string it spells" \
  "$REFUSED_VALUE" "the refusal says which values are read as JSON"
check '"a written place"' "$(said 25 "get label")" \
  "the refused write left the cell holding what it held"

step "19. A value opening with a dash is refused, and the refusal names the escape"
# The grammar is ruled and both halves of it are read back here: a token
# opening with `-` is an option wherever one may be written, so `-5` is refused
# as an option nobody declared, and the bare `--` the line above spells its
# value after is what writes one as an operand. A negative number has no
# spelling that does not open with `-`, so the escape is the whole of what the
# refusal owes the person, and the parser's own sentence — which points at
# `-h` — cannot know to offer it.
DASH_VALUE=$(said 26 "set label -5")
contains 'Unknown option "-5"' "$DASH_VALUE" \
  "a token opening with a dash is read as an option, which is the ruled grammar"
contains 'a bare `--` writes every token after it as an operand' "$DASH_VALUE" \
  'the refusal names the `--` that writes the value'

step "20. A write onto a whole piece is refused, in the words the page uses"
# The safety property first, because it is the one that matters and it holds: a
# line naming the piece rather than a path inside it writes nothing, shuttle
# refusing it and `refuseRootWrite` behind that for the paths only resolution
# can judge.
ROOT_WRITE=$(said 27 "set . '{\"label\":\"x\"}'")
# Read after both of this step's lines rather than between them, so it says
# neither of them wrote. Two things stop the first: the refusal below, and the
# pattern's own schema, which turns down a result cell missing members the
# fixture declares. Removing either leaves the other, which is what a safety
# check should be able to say.
check '"a written place"' "$(said 29 "get label")" \
  "the refused root write left the piece as it was"
# And what it says is the sentence `set --help` carries, word for word, which
# is the whole of what a person reads whether they take the page first or the
# refusal after: the address to embed a path in and the positional to pass one
# as are `cf`'s command line, and a shuttle line has neither — the path IS the
# operand the person wrote.
check 'A write onto a whole piece is refused. `link` is what writes a reference.' \
  "$ROOT_WRITE" "the root-write refusal is the sentence the verb's page carries"
# The empty operand is a line of its own, and it is refused in the name of the
# verb that wrote it. `movePlace` (`lib/shuttle/place.ts`) is the operand
# reading every verb aims through, so a sentence of its own about `cd` would
# reach a person who wrote no `cd`.
EMPTY_OPERAND=$(said 28 "set '' '\"x\"'")
check '`set` was given an empty operand, which names no place.' \
  "$EMPTY_OPERAND" "the empty operand a set line writes is refused in set's name"

step "21. verbs lists what the piece can be asked to do, and numbers each row"
check "%1 addItem <handler on result> <Appends one line to \`items\`.>
%2 clearItems <handler on result> <Empties \`items\`, which is the opposite of what \`addItem\` does.>" \
  "$(said 30 "verbs")" "verbs numbers both callables with what each is"

step "22. call runs the callable, and what it did is there afterwards"
# The receipt is the seam's Invocation JSON, so what is asserted of it is that
# the call settled rather than that it was accepted — a call the fabric took
# and never ran would say the second and not the first. What the handler did
# is a separate reading, and this is the only one that takes it: step 23 empties
# `items` and refills it, so the array step 27 reads ends at `["jam"]` whether
# or not this call's `milk` ever committed.
CALLED=$(said 31 "call . addItem '{\"text\":\"milk\"}'")
contains '"status": "settled"' "$CALLED" "the call settled"
# Appended rather than written: `items` already holds what step 2 wrote from
# outside, so a call that had replaced the array would be caught here as well
# as one that had done nothing.
check '[
  "bread",
  "milk"
]' "$(said 32 "get items")" "the item the call appended is there, after the one that was"

step "23. call %n invokes the row the listing numbered, and not another"
# Two callables with opposite effects is what makes this an assertion. With one
# row, `call %1` passes whether the handle named that row or was thrown away;
# with two, each number is only right if it reached its own row — a `%2` that
# had run `addItem` would leave two items, and a `%1` that had run `clearItems`
# would leave none.
contains '"status": "settled"' "$(said 33 "call %2 '{}'")" \
  "the callable handle off verbs settles a call"
check "[]" "$(said 34 "get items")" \
  "%2 ran clearItems, which emptied what %1 had filled"
check '[
  "jam"
]' "$(said 36 "get items")" "%1 ran addItem, which appended to what %2 emptied"
check '"jam"' "$(said 37 "get summary")" \
  "the computed member follows what the calls did"
# A callable's page is not reached by writing an option where its name goes,
# and the refusal points at the verb that does list them.
contains "\`verbs\` lists what this piece can be asked to do" \
  "$(said 38 "call . --help")" "an option in the name position names verbs"

step "24. edit writes back what the editor saved, stopping three ways after the editor and one before it"
check "Wrote \`label\` on \`$FIRST\`." "$(said 39 "edit label")" \
  "edit writes back what came out of the editor"
check '"edited in the editor"' "$(said 40 "get label")" \
  "the cell holds what was saved rather than what was opened"
check "Nothing changed, so nothing was written." "$(said 41 "edit label")" \
  "text that came back unchanged is nothing to write"
# Text that will not parse is the one ending that leaves work on disk, and the
# file it names is the only copy of it. So the refusal names a file, and the
# file is there — which is a claim about the filesystem rather than about the
# sentence, and the only one of the three that a transcript alone cannot make.
UNPARSED=$(said 43 "edit label")
contains "What the editor saved is not JSON" "$UNPARSED" \
  "edit refuses text that will not parse"
KEPT=$(printf '%s' "$UNPARSED" | sed -n 's/.*the text is in `\([^`]*\)`.*/\1/p')
if [ -n "$KEPT" ] && [ -f "$KEPT" ]; then
  ok "the file the refusal names is still on disk, holding the unwritten text"
  rm -f "$KEPT"
else
  bad "the refusal named no file that is there (named [$KEPT])"
fi
check '"garble me"' "$(said 44 "get label")" \
  "the refused edit left the cell holding what it held"
# The stop that comes before the editor rather than after it. The operand
# names the whole piece — here by naming nothing, shuttle standing on one —
# and no write onto a whole piece can land, so the line is turned down while
# there is nothing typed to lose. The editor never runs: had it run, this
# fixture would have saved `"edited in the editor"` over the piece and the
# line would have come back as a receipt or as the seam's refusal, neither of
# which is this sentence. Every line before it that moves leaves shuttle
# standing on the piece, which is what makes its absent operand name one.
check 'A write onto a whole piece is refused. `link` is what writes a reference.' \
  "$(said 50 "edit")" "edit turns down a whole piece in the sentence set gives it"

step "25. link writes a reference, so the second cell reads the first"
check "Wrote a reference at \`/slugs/second/label\` naming \`/slugs/first/label\`." \
  "$(said 45 "link /slugs/first/label /slugs/second/label")" \
  "link receipts both ends, in the order it was given them"
# There are two endpoints, so the claim about both is made of two readings.
# Each refusal quotes the operand it was written on, which is also what says
# the refusal is about the endpoint the line spelled rather than about
# whichever of the two happens to be resolved first.
contains "\`/slugs/first/label#argument\` selects a piece's arguments cell" \
  "$(said 46 "link /slugs/first/label#argument /slugs/second/label")" \
  "the source endpoint does not take the argument-cell suffix"
contains "\`/slugs/second/label#argument\` selects a piece's arguments cell" \
  "$(said 49 "link /slugs/first/label /slugs/second/label#argument")" \
  "the target endpoint does not take the argument-cell suffix"

step "26. The pieces facet numbers rows cd takes, and shows what each piece is called"
# The composition no unit case reaches, because each half of it is stubbed out
# where the other is under test: a listing mints a row, `%n` expands to what
# that row printed, and `cd` moves onto the piece the row named. The spelling
# is the piece's own id, which carries no `of:` scheme — so what is asserted
# here is that the facet and the mover read one spelling between them.
check "shuttle /pieces/ @space> " "$(prompt 51 "cd /pieces")" \
  "cd into the piece facet moves the prompt onto it"
LISTED=$(said 52 "ls")
contains "$FIRST" "$LISTED" "the facet lists the first deployed piece"
contains "$SECOND" "$LISTED" "the facet lists the second deployed piece"
# The fixture names itself, so a facet that showed no name would show none
# here either. What the row is called is beside the handle rather than in
# place of it, the handle being what the next line hands back.
contains "<Shuttle place>" "$LISTED" "a listed piece shows the name it carries"
# The row `%1` named, read off the listing rather than assumed: whichever
# piece the registry lists first is the one the next line has to land on, and
# reading it here is what makes the check about the two agreeing.
ROW=$(printf '%s' "$LISTED" | sed -n '1s/^ *%1 \([^ ]*\).*/\1/p')
if [ -z "$ROW" ]; then
  bad "the listing's first row printed no operand for the next line to reach"
else
  check "" "$(said 53 "cd %1")" "cd %1 is not refused on the row ls printed"
  check "shuttle $ROW @space> " "$(prompt 53 "cd %1")" \
    "cd %1 lands on the piece the first row named"
  contains "$ROW" "$(said 54 "pwd")" "pwd names the piece the row named"
fi

step "27. What the fabric holds, read from outside the session that wrote it"
# The half no transcript can make: every reading is taken over a connection
# this session never had, after the shell has gone, so a write that reached
# only the running piece and never committed fails here and nowhere above.
#
# What a reading taken at the end establishes is the state at the end, which
# is a narrower thing than every write having landed. A cell written more than
# once carries only its last value, and a value some other line would have
# produced anyway reads the same as one this line produced. So each check
# below says which write it speaks for, and the writes it cannot speak for are
# named rather than left to look covered: those rest on the shell's own read
# on the line after each, which catches a receipt with no write behind it but
# cannot see whether the write committed.
#
# `label` is written five times, so this reading is of the fifth.
check '"pointed at"' "$(AFTER first label)" \
  "the last set of the five that wrote this cell is what the fabric holds"
# Written on one line and never touched again, so this reading is of that line
# and of no other — the one set here established end to end.
check '"written once and never again"' "$(AFTER first settings/note)" \
  "the set that went to its own path landed, and committed there"
# `["jam"]` is reachable only if the last two calls both ran: without the
# `clearItems` the array would still carry `bread` and `milk`, and without the
# `addItem` after it the array would be empty. The first call is not
# established here — an `items` that never received `milk` ends at `["jam"]`
# too — and the reading in step 22 is what speaks for that one.
check '["jam"]' "$(AFTER first items | tr -d ' \n')" \
  "both calls whose absence would change the final array committed"
check '"jam"' "$(AFTER first summary)" \
  "the computed member was committed as the warm run left it"
# The one reading that tells a reference from a copy. `second` was never
# written by name after the link, and `first/label` was — so a `second` holding
# the new value read it through the reference, and a `link` that had copied
# would hold the value `first` had when the link was made.
check '"pointed at"' "$(AFTER second label)" \
  "the linked cell reads the value written at the cell it names"

# What step 11 does not reach: a piece that changes under a shell already
# standing on it. Step 11 reads storage before the session and the shell's own
# answer during it, which is what tells a warm read from a stored one; what it
# cannot ask is whether a read taken after an external write mid-session serves
# the new value, because the driver types a script of lines and has nowhere to
# run a command between two of them. It reads a settled prompt already, so that
# is a small addition to it, and the check belongs here once it is made.

rm -f "$SCRIPT" "$TRANSCRIPT" "$EDITOR_SCRIPT"
ELAPSED=$(($(date +%s) - START))
printf '\n== %d passed, %d failed, %d gaps open — %ds wall clock\n' \
  "$PASS" "$FAIL" "$GAPS" "$ELAPSED"
[ "$FAIL" -eq 0 ]
