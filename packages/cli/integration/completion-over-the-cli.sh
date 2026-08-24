#!/usr/bin/env bash
# The completion chain against a live fabric: deploy a piece, then assert what
# a Tab offers at each slot of space -> piece -> verb -> verb fields -> cell
# path -> result shape.
#
# Every provider that reads real state is exercised here and nowhere else. The
# unit tests under packages/cli/test/completion-*.test.ts cover the pure half —
# line resolution, candidate shaping, and the degrade-to-empty path — and by
# construction cannot see a provider that reaches a fabric and comes back with
# the wrong set. Completion swallows every error on purpose, so a provider that
# throws and a provider that has nothing to say are one experience at the
# prompt: silence. This script is what tells them apart.
#
# Two rules follow from that silence, and both are held to below. A slot is
# judged only after the equivalent `cf` command has been run against the same
# target, so an empty candidate list is read as a defect rather than as an
# unreachable fabric. And a candidate is judged by whether the command accepts
# it, not by whether something came back.
#
# It drives `cf completion complete` directly, which is the one command the
# installed shell function calls. The shell functions themselves are a separate
# surface and are not exercised here.
#
# A step may assert a GAP rather than a capability, the way
# `verb-session-gaps.sh` does: such a step fails loudly the day its gap closes,
# so a slot that starts answering announces itself instead of aging into a
# stale plan. How many are open is tallied as they run and printed on the last
# line, so no prose here can fall out of step with the assertions below.
#
# Documented in docs/plans/cli-completion-coverage.md, whose item 18 this is.
#
# It deploys pattern/completion-target.tsx and nothing else. That fixture
# belongs to this walkthrough alone, so a change to a pattern the product ships
# can never break a demonstration of what a Tab offers.
#
# Run standalone against any host:
#   API_URL=http://localhost:8000 packages/cli/integration/completion-over-the-cli.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
API_URL="${API_URL:-http://localhost:8000}"
FIXTURE="$SCRIPT_DIR/pattern/completion-target.tsx"

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
# A gap we expect to be there. When it closes this fails loudly, which is how
# the script tells us the slot started answering rather than quietly passing.
gap() {
  if [ -n "$1" ]; then
    bad "GAP CLOSED — $2 now completes; update this script and the plan"
  else
    ok "gap still open: $2"
    GAPS=$((GAPS + 1))
  fi
}
# "1" when the command exits zero, "0" when it does not. What a slot offers is
# judged against what the command accepts, so the command is run rather than
# reasoned about.
succeeds() {
  if "$@" >/dev/null 2>&1; then printf '1\n'; else printf '0\n'; fi
}

SPACE="${SPACE:-$(mktemp -u compXXXXXXXX)}"
if [ -z "${CF_IDENTITY:-}" ]; then
  CF_IDENTITY=$(mktemp)
  $CF id new >"$CF_IDENTITY" 2>/dev/null
fi
ARGS="--api-url=$API_URL --identity=$CF_IDENTITY --space=$SPACE"
# The same three, written the way a caller types them on the line being
# completed. Every provider resolves its fabric from the half-typed line first,
# so a probe that carried them only in the environment would prove nothing
# about the precedence the providers actually apply.
LINE_ARGS="--api-url $API_URL --identity $CF_IDENTITY --space $SPACE"
echo "API_URL=$API_URL"
echo "SPACE=$SPACE"

# A handler call needs a session its invocation ids are chosen within.
export CF_INVOCATION_SESSION=$($CF invocation-session new 2>/dev/null)

# What the shell would be offered for a line whose cursor sits at its end.
# Directives (`:cf:…` lines) are dropped; `directives_at` is what reads those.
complete_at() {
  $CF completion complete --shell bash --line "$1" --point "${#1}" 2>/dev/null |
    grep -v '^:cf:'
}
# The same, sorted and joined, so a candidate set compares as one string.
candidates_at() {
  complete_at "$1" | LC_ALL=C sort | paste -sd, -
}
directives_at() {
  $CF completion complete --shell bash --line "$1" --point "${#1}" 2>/dev/null |
    grep '^:cf:' | paste -sd, -
}
# zsh pairs each candidate with the annotation the shell renders beside it,
# which is the only spelling that shows what a candidate is annotated WITH.
# A colon inside a value is escaped in that format — every piece id carries
# one — so the key is escaped the same way before it is matched.
annotation_at() {
  local key="${2//:/\\:}:"
  local line
  while IFS= read -r line; do
    case "$line" in
      "$key"*) printf '%s\n' "${line#"$key"}" ;;
    esac
  done < <($CF completion complete --shell zsh --line "$1" \
    --point "${#1}" 2>/dev/null)
}

START=$(date +%s)

step "1. Deploy the fixture and give it a child"
# --quiet makes the piece id stdout's only line; stderr is dropped and the
# grep anchored so a compile warning carrying a fid1: token cannot be taken
# for the deploy's id.
BOARD=$($CF piece new --quiet --slug board "$FIXTURE" $ARGS 2>/dev/null |
  grep -oE '^fid1:[A-Za-z0-9_-]+' | head -1)
if [ -n "$BOARD" ]; then ok "deployed $BOARD"; else
  bad "deploy failed"
  exit 1
fi
# The child is what a path crossing a link boundary crosses into, and what the
# shadowed-name step calls. --show-links names the document behind /item, which
# is the address form --piece takes back in.
ADDED=$($CF call --quiet --show-links --piece board $ARGS --invocation add-1 \
  addItem '{"title":"First item"}' 2>/dev/null)
ITEM=$(echo "$ADDED" | jq -r '.links["/item"] // empty')
if [ -n "$ITEM" ]; then ok "added a child item: $ITEM"; else
  bad "addItem returned no address for the item it created"
  exit 1
fi
# The space DID, read off a stored link rather than assumed: a space NAME
# derives its DID one way, so nothing on the line carries it. The canonical
# reference's space-qualified spelling needs it.
SPACE_DID=$($CF get --quiet --piece board $ARGS items 2>/dev/null |
  jq -r '.[0].record["/"]["link@1"].space // empty')
if [ -n "$SPACE_DID" ]; then ok "the space resolves to $SPACE_DID"; else
  bad "no space DID on the child's stored link"
fi

step "2. The piece slot offers ids the same command can then read"
# The chain's second link. An id that completes but which the dispatcher
# cannot reach would be worse than no candidate: it teaches a caller a target
# that does not exist. Every id offered is read back here rather than assumed.
PIECE_SLOT=$(complete_at "cf call $LINE_ARGS --piece ")
check "$BOARD" "$PIECE_SLOT" "the piece slot offers the deployed board"
READABLE=0
UNREADABLE=0
while IFS= read -r id; do
  [ -z "$id" ] && continue
  if [ "$(succeeds $CF get --quiet --piece "$id" $ARGS '$NAME')" = "1" ]; then
    READABLE=$((READABLE + 1))
  else
    UNREADABLE=$((UNREADABLE + 1))
  fi
done <<EOF
$PIECE_SLOT
EOF
check "0" "$UNREADABLE" "every completed piece id reads back ($READABLE checked)"
# The annotation column is what makes an opaque id legible.
check "Completion fixture" \
  "$(annotation_at "cf call $LINE_ARGS --piece " "$BOARD")" \
  "the id is annotated with the piece's name"

step "3. The slug the same slot accepts does not complete"
check "Completion fixture" \
  "$($CF get --quiet --piece board $ARGS '$NAME' 2>/dev/null | tr -d '"')" \
  "the slug is a --piece value the command accepts"
gap "$(complete_at "cf call $LINE_ARGS --piece bo")" "a slug in the --piece slot"

step "4. The inline spelling of an option drops every live candidate"
# `--piece=<TAB>` and `--piece <TAB>` are the same slot. Only the second works,
# and the first is the spelling `tokenizeLine` exists to serve.
check "$BOARD" "$(complete_at "cf call $LINE_ARGS --piece ")" \
  "the spaced spelling completes"
gap "$(complete_at "cf call $LINE_ARGS --piece=")" \
  "the inline --piece= spelling"
# The directive half of the same slot: the glob reaches the shell attached to a
# word that still carries `--identity=`, so nothing can match it.
check ":cf:files *.key" "$(directives_at "cf call $LINE_ARGS --identity ")" \
  "the spaced --identity spelling emits its files directive"

step "5. Three documented ways to name a target complete nothing"
CANONICAL="/of:$BOARD"
QUALIFIED="/@$SPACE_DID/of:$BOARD"
check "Completion fixture" \
  "$($CF get --quiet --piece "$CANONICAL" $ARGS '$NAME' 2>/dev/null | tr -d '"')" \
  "the canonical reference is a --piece value the command accepts"
gap "$(complete_at "cf call $LINE_ARGS --piece $CANONICAL ")" \
  "the verb slot behind a canonical --piece reference"
check "Completion fixture" \
  "$($CF get --quiet --piece "$QUALIFIED" $ARGS '$NAME' 2>/dev/null | tr -d '"')" \
  "and so is its space-qualified spelling"
gap "$(complete_at "cf call $LINE_ARGS --piece $QUALIFIED ")" \
  "the verb slot behind a space-qualified reference"

check "Completion fixture" \
  "$($CF get --quiet $ARGS "$CANONICAL" '$NAME' 2>/dev/null | tr -d '"')" \
  "a positional canonical address is a target the command accepts"
gap "$(complete_at "cf call $LINE_ARGS $CANONICAL ")" \
  "the verb slot behind a positional address"

check "1" "$(succeeds $CF get --quiet --piece "$CANONICAL#argument" $ARGS)" \
  "the #argument suffix is a --piece value the command accepts"
gap "$(complete_at "cf get $LINE_ARGS --piece $CANONICAL#argument ")" \
  "the cell path behind an #argument reference"
# The flag spelling of the same selection does complete, which is what makes
# the suffix read as random rather than as a missing capability.
check "1" "$(complete_at "cf get $LINE_ARGS --piece board --input " |
  grep -c '^settings$')" \
  "--input, which selects the same cell, completes it"

step "6. The verb slot"
check "addItem,legacyAdd,noteAll,renameItem,sweep" \
  "$(candidates_at "cf call $LINE_ARGS --piece board ")" \
  "every callable the piece exposes is offered"
# The default listing holds back the deprecated row and says how many it held.
check "addItem,noteAll,renameItem,sweep" \
  "$($CF piece verbs --piece board $ARGS --json 2>/dev/null |
    jq -r '[.verbs[] | select(.deprecated != true and .tier != "wrapper") |
      .name] | sort | join(",")')" \
  "the verbs listing shows four of them"
check "handler" "$(annotation_at "cf call $LINE_ARGS --piece board " legacyAdd)" \
  "the deprecated verb is offered annotated like every other"
# The annotation column carries the kind, while the listing row carries the
# prose the author wrote — the sentence the verb's help page opens with.
check "Add one item to the board, and report the new total." \
  "$($CF piece verbs --piece board $ARGS --json 2>/dev/null |
    jq -r '.verbs[] | select(.name == "addItem") | .description')" \
  "the listing carries addItem's prose"
check "handler" "$(annotation_at "cf call $LINE_ARGS --piece board " addItem)" \
  "and the candidate is annotated with its kind instead"

step "7. Past the callable name, cf's own flags are offered and refused"
# `piece call` is stopEarly(), so the first positional ends option parsing and
# every later word belongs to the callable's schema-derived parser.
check "1" "$(complete_at "cf call $LINE_ARGS --piece board addItem --" |
  grep -c '^--invocation$')" \
  "--invocation is offered after the callable name"
check "0" "$(succeeds $CF call --quiet --piece board $ARGS addItem \
  --invocation late)" "and the command refuses it there"

step "8. The verb's own fields do not complete"
# The position where a caller has least to go on: these names are the pattern
# author's vocabulary, not the CLI's.
check "pinned,title" "$($CF piece verbs --piece board $ARGS --json 2>/dev/null |
  jq -r '.verbs[] | select(.name == "addItem") | .inputSchema.properties |
    keys | sort | join(",")')" \
  "addItem declares the fields its flags are named for"
check "1" "$(succeeds $CF call --quiet --piece board $ARGS --invocation flags-1 \
  addItem -- --title 'Flagged item')" "and the parser accepts them as flags"
gap "$(complete_at "cf call $LINE_ARGS --piece board addItem -- --")" \
  "a verb's fields after the marker"

step "9. A cell path completes one segment at a time"
check ":cf:nospace" "$(directives_at "cf get $LINE_ARGS --piece board ")" \
  "the cursor is held for the next separator"
check "1" "$(complete_at "cf get $LINE_ARGS --piece board " |
  grep -c '^settings$')" "a root key is offered"
check "settings/density,settings/theme" \
  "$(candidates_at "cf get $LINE_ARGS --piece board settings/")" \
  "a nested object offers its keys, each carrying the path already typed"
check "cozy" "$($CF get --quiet --piece board $ARGS settings/density \
  2>/dev/null | tr -d '"')" "and the completed path is one cf get reads"

step "10. A cell path follows a \$link boundary rather than stopping at it"
# `items/0` is a link to another document. The path walk reads through it, so
# the child's own keys are what the slot offers.
check "1" "$(complete_at "cf get $LINE_ARGS --piece board items/0/" |
  grep -c '^items/0/label$')" \
  "the keys past the boundary are the child's own"
check "First item" "$($CF get --quiet --piece board $ARGS items/0/label \
  2>/dev/null | tr -d '"')" \
  "and the path crossing the boundary is one cf get reads"
# The same slot also offers names cf get refuses: a callable is not a value,
# and reading one is redirected to cf call.
check "0" "$(succeeds $CF get --quiet --piece board $ARGS addItem)" \
  "reading a callable's name is refused"
check "1" "$(complete_at "cf get $LINE_ARGS --piece board " |
  grep -c '^addItem$')" \
  "and the cell-path slot offers it anyway"

step "11. Result field paths do not complete"
# --step because the board carries a computed value and a projection reads
# through the whole result: the same reason the verb walkthrough steps before
# it projects.
check "dark" "$($CF get --quiet --piece board $ARGS --step \
  --select settings.theme 2>/dev/null | jq -r '.settings.theme')" \
  "a --select field path is a projection the command reads"
gap "$(complete_at "cf get $LINE_ARGS --piece board --select ")" \
  "--select field paths"
gap "$(complete_at "cf get $LINE_ARGS --piece board --schema ")" \
  "--schema field paths"

step "12. A name on two cells completes against the one the dispatcher reaches"
# The child is handed a callable named `record` in its arguments AND declares
# one on its result. The listing states that the result shadows the input; a
# candidate set that offered both, or the wrong one, would name a call that
# does something else.
check "record" "$(candidates_at "cf call $LINE_ARGS --piece ${ITEM#/of:} ")" \
  "the shadowed name is offered exactly once"
BOARD_REVISION=$($CF get --quiet --piece board $ARGS revision 2>/dev/null)
check "1" "$($CF call --quiet --piece "${ITEM#/of:}" $ARGS --invocation rec-1 \
  record '{"text":"first"}' 2>/dev/null | jq -r '.result.recorded')" \
  "calling it reaches the result cell's callable"
check "$BOARD_REVISION" "$($CF get --quiet --piece board $ARGS revision \
  2>/dev/null)" \
  "and not the one the arguments cell carries, which writes elsewhere"

ELAPSED=$(($(date +%s) - START))
printf '\n== %d passed, %d failed, %d gaps open — %ds wall clock\n' \
  "$PASS" "$FAIL" "$GAPS" "$ELAPSED"
[ "$FAIL" -eq 0 ]
