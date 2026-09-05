#!/usr/bin/env bash
# The Topics content-safety drill: deploy a board, seed it, snapshot the
# store, export, clobber a topic the worst way a bad migration would, restore
# it, and prove the restore byte-exact — the loop
# docs/history/plans/topics-migration-rehearsal.md's "restore drill" section makes
# part of every clean rehearsal pass, runnable as one command.
#
# Unlike verbs-over-the-cli.sh, this deliberately exercises the REAL topics
# pattern (packages/patterns/topics/main.tsx): its subject is content safety
# for that pattern, so a topics change that breaks export or restore SHOULD
# break this script.
#
# Requirements beyond the usual: sqlite3 on PATH (for the VACUUM INTO
# snapshot — preinstalled on the CI runners and on macOS, so it is checked
# rather than installed), and CF_DRILL_STORE_DIR pointing at the serving
# toolshed's MEMORY_DIR (default <server cwd>/cache/memory), because a
# snapshot is taken from the store file, not over the API.
#
# An identity is minted when CF_IDENTITY names none, the way
# verbs-over-the-cli.sh does: CI sets no key, and every cf command here needs
# one.
#
#   API_URL=http://localhost:8000 CF_DRILL_STORE_DIR=cache/memory \
#     packages/cli/integration/topics-restore-drill.sh
#
# CI runs it through integration.sh's `piece-call` section, which supplies the
# store directory; `topics-drill` runs it alone.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
API_URL="${API_URL:-http://localhost:8000}"
STORE_DIR="${CF_DRILL_STORE_DIR:-cache/memory}"

if [ -n "${CF_BINARY:-}" ]; then
  CF="$CF_BINARY"
else
  CF="deno task --quiet --cwd $REPO_ROOT cf"
fi

PASS=0
FAIL=0
step() { printf '\n== %s\n' "$1"; }
ok() {
  PASS=$((PASS + 1))
  printf 'PASS: %s\n' "$1"
}
bad() {
  FAIL=$((FAIL + 1))
  printf 'FAIL: %s\n' "$1"
}

command -v sqlite3 > /dev/null || {
  echo "sqlite3 is required for the snapshot step" >&2
  exit 1
}
command -v jq > /dev/null || {
  echo "jq is required" >&2
  exit 1
}
# The inner directory holds the per-space files and is created with the first
# space, so a fresh server has only the outer one — which is what to check,
# since this script is about to create that first space itself.
ENGINE_DIR="$STORE_DIR/engine-v3/engine-v3"
[ -d "$STORE_DIR/engine-v3" ] || {
  echo "no store at $STORE_DIR/engine-v3 — point CF_DRILL_STORE_DIR at the" \
    "serving toolshed's MEMORY_DIR (its default is <server cwd>/cache/memory)" >&2
  exit 1
}

WORK="$(mktemp -d)"
SPACE="topics-drill-$(python3 -c 'import uuid; print(uuid.uuid4().hex[:12])')"

# Every cf command below reads CF_IDENTITY from the environment, and CI sets
# none. Mint one for this run rather than failing on the first deploy with
# nothing to say about why.
if [ -z "${CF_IDENTITY:-}" ]; then
  CF_IDENTITY="$WORK/identity.key"
  $CF id new > "$CF_IDENTITY" 2> /dev/null || {
    echo "could not mint an identity for the drill" >&2
    exit 1
  }
fi
export CF_IDENTITY

step "deploy the topics board into a fresh space ($SPACE)"
# `.sqlite` only: each store also carries -wal and -shm companions, and a
# snapshot is taken from the database file itself.
ls "$ENGINE_DIR" 2> /dev/null | grep '\.sqlite$' | sort > "$WORK/dbs-before" ||
  true
# `--root` is the repository root because the board imports the member-naming
# library from a sibling directory (`../collection-naming/`). Without it the
# program root is the entry's own directory, every such import is refused as
# escaping it, and no fid is printed. Any deploy of this board needs the same
# flag, which is why the failure is captured and shown rather than discarded:
# a deploy that refuses and a deploy that prints nothing look identical once
# stderr is dropped, and only one of them is this script's fault.
#
# The two streams stay apart, and the match is a WHOLE LINE. Under `-q` today
# stdout carries the new piece's id and nothing else, while every diagnostic,
# hint and log line goes to stderr. Merging them and taking the first `fid1:`
# token anywhere would accept a token out of a message — a source reference in
# a warning, an id inside a suggested command — and the drill would then run
# against a board that does not exist, failing several steps later with a
# message about something else.
#
# What the anchor buys is narrower than "stdout holds only the id", and the
# difference matters to whoever next asks whether this still holds. `grep -x`
# accepts a LINE that is a fid and nothing more, so a fid embedded in a longer
# line cannot match however the streams are arranged. It does NOT require
# stdout to hold that line alone: a future `cf` printing something beside the
# id would keep working, and silently. What breaks this is stdout ceasing to
# carry a bare fid line at all, and that failure is loud — nothing matches,
# `BOARD` is empty, and the step stops here naming what it did not find.
$CF piece new -q "$REPO_ROOT/packages/patterns/topics/main.tsx" \
  --root "$REPO_ROOT" --space "$SPACE" --api-url "$API_URL" \
  > "$WORK/deploy.out" 2> "$WORK/deploy.err"
BOARD="$(grep -xE 'fid1:[A-Za-z0-9_-]+' "$WORK/deploy.out" | head -1)"
[ -n "$BOARD" ] && ok "board deployed: $BOARD" || {
  bad "board deploy produced no bare fid line on stdout"
  echo "--- deploy stdout ---" >&2
  cat "$WORK/deploy.out" >&2
  echo "--- deploy stderr ---" >&2
  cat "$WORK/deploy.err" >&2
  exit 1
}

step "seed: one topic with markdown body, two comments, one link"
BODY='# Drill\n\n    indented code block\n    second line\n\ntrailing prose'
$CF piece call -q --piece "$BOARD" --space "$SPACE" --api-url "$API_URL" \
  addTopic "{\"title\":\"Drill: alpha\",\"body\":\"$BODY\",\"agentName\":\"drill\"}" \
  > "$WORK/create.json" 2> /dev/null
TOPIC_ALIAS="$(jq -r '.result.topic["$link"] // empty' "$WORK/create.json")"
# The create may or may not render an address depending on selection; the
# canonical fid comes from the export below either way. Seed through the
# board-published topic address when present, else re-read it.
if [ -z "$TOPIC_ALIAS" ]; then
  TOPIC_ALIAS="$(
    $CF cell get -q --piece "$BOARD" --space "$SPACE" --api-url "$API_URL" \
      topics --input --select '@' 2> /dev/null | jq -r '.[0]["$link"]'
  )"
fi
[ -n "$TOPIC_ALIAS" ] && ok "topic address in hand" || {
  bad "no topic address"
  exit 1
}
# The name the create allocated, beside the topic it created. A caller reads
# this rather than waiting for the topic's own `shortName` derivation, and a
# pattern test cannot see it — a verb's result reaches its caller through the
# handling's receipt. This is the first topic on a fresh board, so `1`.
CREATED_NAME="$(jq -r '.result.name // empty' "$WORK/create.json")"
[ "$CREATED_NAME" = "1" ] && ok "create returned the allocated name: 1" ||
  bad "create returned name '$CREATED_NAME', expected 1"
$CF piece call -q --piece "$TOPIC_ALIAS" --space "$SPACE" \
  --api-url "$API_URL" addComment \
  '{"body":"first drill comment","agentName":"drill"}' > /dev/null 2>&1
$CF piece call -q --piece "$TOPIC_ALIAS" --space "$SPACE" \
  --api-url "$API_URL" addComment \
  '{"body":"second drill comment","agentName":"drill"}' > /dev/null 2>&1
$CF piece call -q --piece "$TOPIC_ALIAS" --space "$SPACE" \
  --api-url "$API_URL" addLink \
  '{"kind":"pr","url":"https://example.com/pr/1","label":"PR 1","agentName":"drill"}' \
  > /dev/null 2>&1
ok "seeded"

step "snapshot the space store (VACUUM INTO) and export from it"
ls "$ENGINE_DIR" 2> /dev/null | grep '\.sqlite$' | sort > "$WORK/dbs-after"
NEW_DBS="$(comm -13 "$WORK/dbs-before" "$WORK/dbs-after")"
[ -n "$NEW_DBS" ] || {
  bad "no new space DB under $ENGINE_DIR — is API_URL served from this store?"
  exit 1
}
# More than one store can be new: a run that minted its own identity also
# created that identity's home space. Rather than guess between them —
# whichever sorts first is a coin flip, and picking wrong fails later in the
# export where the cause is invisible — snapshot each and let the export say
# which holds the topics. "The store the export can read" IS the criterion.
NEW_DB=""
while read -r candidate; do
  [ -n "$candidate" ] || continue
  sqlite3 "$ENGINE_DIR/$candidate" "VACUUM INTO '$WORK/$candidate'" \
    2> /dev/null || continue
  if deno run --allow-read --allow-write --allow-env --allow-ffi \
    --allow-net=github.com,release-assets.githubusercontent.com \
    "$REPO_ROOT/scripts/topics-export.ts" "$WORK/$candidate" \
    --out "$WORK/export.json" > "$WORK/export.log" 2>&1; then
    NEW_DB="$candidate"
    break
  fi
done <<< "$NEW_DBS"
[ -n "$NEW_DB" ] && ok "snapshot and export: $NEW_DB" || {
  bad "no new store exported as a topics space; last attempt said:
$(cat "$WORK/export.log" 2> /dev/null)"
  exit 1
}
TOPIC="$(jq -r '.topics[0].fid' "$WORK/export.json")"
COUNTS="$(jq -r '[(.topics | length), (.topics[0].content.comments | length)] | @tsv' "$WORK/export.json")"
[ "$COUNTS" = "$(printf '1\t2')" ] &&
  ok "export carries 1 topic with 2 comments" ||
  bad "unexpected export counts: $COUNTS"

step "clobber the topic the way a bad migration would"
echo '{"title":"CLOBBERED","body":"gone","comments":[]}' |
  $CF piece apply -q --piece "$TOPIC" --space "$SPACE" \
    --api-url "$API_URL" > /dev/null 2>&1
CLOBBERED_TITLE="$(
  $CF cell get -q --piece "$TOPIC" --space "$SPACE" --api-url "$API_URL" \
    title --input 2> /dev/null
)"
[ "$CLOBBERED_TITLE" = '"CLOBBERED"' ] && ok "clobber landed" ||
  bad "clobber did not land: $CLOBBERED_TITLE"

step "restore from the export"
deno run --allow-run --allow-read --allow-env \
  "$REPO_ROOT/scripts/topics-restore.ts" "$WORK/export.json" \
  --piece "$TOPIC" --api-url "$API_URL" > "$WORK/restore.log" 2>&1 &&
  ok "restore exited zero" || {
  bad "restore failed: $(cat "$WORK/restore.log")"
  exit 1
}

step "verify: byte-exact content, live board link, idempotent rerun"
$CF cell get -q --piece "$TOPIC" --space "$SPACE" --api-url "$API_URL" \
  body --input > "$WORK/live-body.json" 2> /dev/null
jq -e --slurpfile live "$WORK/live-body.json" \
  '.topics[0].content.body == $live[0]' "$WORK/export.json" > /dev/null &&
  ok "body byte-exact, markdown intact" || bad "body differs from export"
LIVE_COMMENTS="$(
  $CF cell get -q --piece "$TOPIC" --space "$SPACE" --api-url "$API_URL" \
    comments --input 2> /dev/null | jq 'length'
)"
[ "$LIVE_COMMENTS" = "2" ] && ok "both comments back" ||
  bad "comments: $LIVE_COMMENTS"
MENTION_TITLES="$(
  $CF cell get -q --piece "$TOPIC" --space "$SPACE" --api-url "$API_URL" \
    --input mentionable --select title 2> /dev/null | jq 'length'
)"
[ "$MENTION_TITLES" = "1" ] && ok "mentionable resolves through the board" ||
  bad "mentionable did not resolve: $MENTION_TITLES"
deno run --allow-run --allow-read --allow-env \
  "$REPO_ROOT/scripts/topics-restore.ts" "$WORK/export.json" \
  --piece "$TOPIC" --api-url "$API_URL" 2> /dev/null |
  grep -q "nothing to restore" &&
  ok "second restore is a no-op" || bad "second restore was not a no-op"

step "the namespace verbs' own results"
# `backfillNames` returns the names it wrote. Asserted here rather than in a
# pattern test for the reason the create's `name` is: a verb's result reaches
# its caller through the handling's receipt, and `send()` hands a pattern test
# nothing.
#
# The board's one topic was named by its create, so a backfill over it as it
# stands writes nothing — and an implementation that never wrote anything would
# pass that just as well. So the namespace is emptied first, which is the state
# a board filed before it numbered anything is actually in: members in the
# list, no names for them. Now the run has something to write, and `assigned`
# has to carry it. Last step in the drill, since it leaves the namespace
# rebuilt rather than as the restore left it.
printf '{}' | $CF cell set -q --piece "$BOARD" --space "$SPACE" \
  --api-url "$API_URL" names > /dev/null 2>&1
CLEARED="$(
  $CF cell get -q --piece "$BOARD" --space "$SPACE" --api-url "$API_URL" \
    names 2> /dev/null | jq -c 'keys'
)"
[ "$CLEARED" = "[]" ] && ok "namespace emptied for the backfill" ||
  bad "namespace did not empty: $CLEARED"
BACKFILL="$(
  $CF piece call -q --piece "$BOARD" --space "$SPACE" --api-url "$API_URL" \
    backfillNames \
    '{"agentName":"drill"}' 2> /dev/null
)"
ASSIGNED="$(printf '%s\n' "$BACKFILL" | jq -c '.result.assigned // empty')"
[ "$ASSIGNED" = '["1"]' ] &&
  ok "backfill reported the name it wrote: [\"1\"]" ||
  bad "backfill reported '$ASSIGNED', expected [\"1\"]"
# And it wrote what it reported, rather than reporting a name it never stored.
REFILLED="$(
  $CF cell get -q --piece "$BOARD" --space "$SPACE" --api-url "$API_URL" \
    names 2> /dev/null | jq -c 'keys'
)"
[ "$REFILLED" = '["1"]' ] && ok "the namespace carries the name it reported" ||
  bad "namespace holds $REFILLED after the backfill"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
