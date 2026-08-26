#!/usr/bin/env bash
# The bulk-operations drill: deploy a board whose members are created
# through its own verb, survey it, assert the plan — repair it: a fixer run
# dry with every plan row recording its precondition and fixer, applied from
# that plan, resumed as all-landed writing nothing, and a field-dropping
# fixer refused by name — and retarget it: the stamped plan applied to
# completion, a run killed midway and finished by re-invocation, an edited
# source refused with every unattempted piece named, a piece moved elsewhere
# stopping the run, and the after-survey diffed against the plan it verifies.
# Stages 1 through 3 of docs/plans/piece-bulk-operations.md, which finishes
# each stage with a CI drill so "does the migration tooling still work?"
# stays a CI result.
#
# It deploys pattern/bulk-board.tsx (members from pattern/bulk-member.tsx, a
# separate module so member and board identities differ, the way topic.tsx
# sits beside the topics board's main.tsx) and retargets them onto
# pattern/bulk-member-v2.tsx — the checked-in fixture pair the design calls
# for, a trimmed prior generation and a current one, so the drill reds when
# bulk operations break rather than when a real pattern changes. The fixtures
# belong to this drill alone.
#
# Every step names the property it asserts. A fresh space per run, no prior
# state, no store access — the survey is API-only.
#
# Run standalone against any host:
#   API_URL=http://localhost:8000 packages/cli/integration/bulk-survey-drill.sh
#
# CI runs it through integration.sh's `piece-call` section; the
# `bulk-survey-drill` section is the standalone selector.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
API_URL="${API_URL:-http://localhost:8000}"
BOARD_FIXTURE="$SCRIPT_DIR/pattern/bulk-board.tsx"
MEMBER_FIXTURE="$SCRIPT_DIR/pattern/bulk-member.tsx"
RETARGET_FIXTURE="$SCRIPT_DIR/pattern/bulk-member-v2.tsx"

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

# The board-sized bar the plan's stage-1 criterion sets; 113 matches the
# motivating Topics board.
MEMBERS_TOTAL=113

WORK="$(mktemp -d)"
SPACE="${SPACE:-$(mktemp -u bulkXXXXXXXX)}"
if [ -z "${CF_IDENTITY:-}" ]; then
  CF_IDENTITY=$(mktemp)
  $CF id new >"$CF_IDENTITY" 2>/dev/null
fi
ARGS="--api-url=$API_URL --identity=$CF_IDENTITY --space=$SPACE"
echo "API_URL=$API_URL"
echo "SPACE=$SPACE"

step "1. Deploy the board and file three members through its verb"
BOARD=$($CF piece new --quiet "$BOARD_FIXTURE" $ARGS 2>/dev/null |
  grep -oE '^fid1:[A-Za-z0-9_-]+' | head -1)
if [ -n "$BOARD" ]; then ok "deployed $BOARD"; else
  bad "deploy failed"
  exit 1
fi
FILED=0
for title in alpha beta gamma; do
  if $CF call -q --piece "$BOARD" $ARGS addMember "{\"title\":\"$title\"}" \
    >/dev/null 2>&1; then
    FILED=$((FILED + 1))
  else
    bad "addMember $title failed"
  fi
done
check "3" "$FILED" "filed alpha, beta, gamma"

step "2. One call seeds the rest of the board-sized set"
SEED_EXTRA=$((MEMBERS_TOTAL - 3))
SEEDED=$($CF call -q --piece "$BOARD" $ARGS seedMembers \
  "{\"count\":$SEED_EXTRA}" 2>/dev/null | jq -r '.result.filed // empty')
check "$SEED_EXTRA" "$SEEDED" "one call filed the remaining $SEED_EXTRA"

step "3. Survey the collection, stamping a retarget"
PLAN="$WORK/plan.jsonl"
if $CF piece survey -q --piece "$BOARD" --path items $ARGS \
  --retarget "items=$RETARGET_FIXTURE@drill" --main-export Member \
  --out "$PLAN" 2>"$WORK/survey.err"; then
  ok "survey exited 0 (complete)"
else
  bad "survey exited nonzero"
  sed 's/^/  | /' "$WORK/survey.err"
  exit 1
fi

step "4. The header accounts for the selection"
HEADER_FACTS=$(head -1 "$PLAN" | jq -r \
  '[.kind, (.v|tostring), .selector, (.enumerated.collection|tostring),
    (.enumerated.registry|tostring),
    (.enumerated.registeredOutside|tostring),
    ((has("problems") or has("outside"))|tostring)] | @tsv')
check "$(printf 'piece-plan\t1\tcollection\t%s\t1\t0\tfalse' \
  "$MEMBERS_TOTAL")" "$HEADER_FACTS" \
  "header: board-sized collection, the board alone registered, nothing outside"

step "5. Rows are members in order, then the holder"
MEMBER_PHASES=$(tail -n +2 "$PLAN" | jq -rs \
  "map(.phase) | .[0:$MEMBERS_TOTAL] | unique | join(\",\")")
check "items" "$MEMBER_PHASES" "every member row leads, phased items"
LAST_PHASE=$(tail -n +2 "$PLAN" | jq -rs 'map(.phase) | last')
check "holder" "$LAST_PHASE" "the holder row comes last"
DISTINCT_PIECES=$(tail -n +2 "$PLAN" | jq -rs 'map(.piece) | unique | length')
check "$((MEMBERS_TOTAL + 1))" "$DISTINCT_PIECES" \
  "one distinct piece per member, plus the holder"

step "6. Members share one identity; the holder has its own"
MEMBER_IDENTITIES=$(tail -n +2 "$PLAN" | jq -rs \
  'map(select(.phase == "items") | .expect.patternIdentity) | unique | length')
check "1" "$MEMBER_IDENTITIES" "one identity across the members"
CROSS=$(tail -n +2 "$PLAN" | jq -rs \
  'map(.expect.patternIdentity) | unique | length')
check "2" "$CROSS" "the holder's identity is not the members'"
RETAINED=$(tail -n +2 "$PLAN" | jq -rs \
  'map(.expect.retained) | unique | join(",")')
check "true" "$RETAINED" "every row's source is retained"

step "7. The retarget stamp pins the target identity, on member rows only"
STAMPS=$(tail -n +2 "$PLAN" | jq -rs \
  'map(select(.phase == "items") | .op)
   | [(map(.kind) | unique | join(",")), (map(.rev) | unique | join(",")),
      (map(.symbol) | unique | join(",")),
      (map(.patternIdentity) | unique | length | tostring)] | @tsv')
check "$(printf 'retarget\tdrill\tMember\t1')" "$STAMPS" \
  "member rows carry one retarget target, rev 'drill', export Member"
TARGET_DIFFERS=$(tail -n +2 "$PLAN" | jq -rs \
  'map(select(.phase == "items"))
   | map((.op.patternIdentity != null) and
       (.op.patternIdentity != .expect.patternIdentity))
   | unique | join(",")')
check "true" "$TARGET_DIFFERS" \
  "every member row is stamped, and with a different reference"
HOLDER_OP=$(tail -n +2 "$PLAN" | jq -rs \
  'map(select(.phase == "holder") | has("op")) | join(",")')
check "false" "$HOLDER_OP" "the holder row carries no op"

step "8. The single-piece pin agrees with the holder row"
PIN_FACTS=$($CF piece inspect --pattern-identity --json \
  --piece "$BOARD" $ARGS 2>/dev/null |
  jq -r '[.patternIdentity, .symbol, (.retained|tostring)] | @tsv')
HOLDER_FACTS=$(tail -n +2 "$PLAN" | jq -rs \
  'map(select(.phase == "holder") | .expect)
   | first | [.patternIdentity, .symbol, (.retained|tostring)] | @tsv')
if [ -z "$PIN_FACTS" ] || [ -z "$HOLDER_FACTS" ]; then
  bad "pin extraction came back empty"
fi
check "$HOLDER_FACTS" "$PIN_FACTS" \
  "inspect's source pin matches the survey's holder row, symbol included"

step "9. A change shows on the next survey (live read)"
$CF call -q --piece "$BOARD" $ARGS addMember '{"title":"delta"}' \
  >/dev/null 2>&1 || bad "addMember delta failed"
AFTER=$($CF piece survey -q --piece "$BOARD" --path items $ARGS \
  2>/dev/null | head -1 | jq -r '.enumerated.collection')
check "$((MEMBERS_TOTAL + 1))" "$AFTER" \
  "the after-survey counts the member added since"

step "10. A repair runs dry, applies from its plan, and resumes as landed"
cat > "$WORK/fix-titles.ts" <<'FIXER'
export default (document: Readonly<Record<string, unknown>>) => ({
  ...document,
  ...(typeof document.title === "string"
    ? { title: (document.title as string).toUpperCase() }
    : {}),
});
FIXER
if $CF piece repair -q --piece "$BOARD" --path items $ARGS \
  --fixer "$WORK/fix-titles.ts" --out "$WORK/repair.jsonl" \
  2>"$WORK/repair-dry.err"; then
  ok "dry repair exited 0"
else
  bad "dry repair exited nonzero"
  sed 's/^/  | /' "$WORK/repair-dry.err"
fi
DRY_OPS=$(tail -n +2 "$WORK/repair.jsonl" | jq -rs \
  'map(.op.fixer) | unique | join(",")')
check "$WORK/fix-titles.ts" "$DRY_OPS" \
  "every plan row records the fixer it was evaluated for"
# The reviewed plan pins the fixer implementation: an edited module is a
# different closure identity, and the apply refuses it by name.
cp "$WORK/fix-titles.ts" "$WORK/fix-titles.reviewed.ts"
printf '\n// edited after review\n' >> "$WORK/fix-titles.ts"
if $CF piece repair -q --piece "$BOARD" --path items $ARGS \
  --fixer "$WORK/fix-titles.ts" --plan "$WORK/repair.jsonl" --apply \
  >/dev/null 2>"$WORK/repair-pin.err"; then
  bad "an edited fixer ran under the reviewed plan"
else
  ok "an edited fixer exited nonzero under the reviewed plan"
fi
if grep -q "different fixer implementation" "$WORK/repair-pin.err"; then
  ok "the refusal names the implementation pin"
else
  bad "the refusal does not name the implementation pin"
  sed 's/^/  | /' "$WORK/repair-pin.err"
fi
mv "$WORK/fix-titles.reviewed.ts" "$WORK/fix-titles.ts"
APPLY_FACTS=$($CF piece repair -q --piece "$BOARD" --path items $ARGS \
  --fixer "$WORK/fix-titles.ts" --plan "$WORK/repair.jsonl" --apply --json \
  2>"$WORK/repair-apply.err" | sed 's/^fvj1://' | jq -r '[(.applied|tostring),
    (.complete|tostring), (.rows | map(.verdict) | unique | join(","))]
    | @tsv')
MEMBERS_NOW=$((MEMBERS_TOTAL + 1))
check "$(printf '%s\ttrue\trepaired' "$MEMBERS_NOW")" "$APPLY_FACTS" \
  "the plan-driven apply repaired every member row"
RESUME=$($CF piece repair -q --piece "$BOARD" --path items $ARGS \
  --fixer "$WORK/fix-titles.ts" --plan "$WORK/repair.jsonl" --apply --json \
  2>/dev/null | sed 's/^fvj1://' | jq -r '[(.applied|tostring),
    (.complete|tostring), (.rows | map(.verdict) | unique | join(","))]
    | @tsv')
check "$(printf '0\ttrue\tconforms')" "$RESUME" \
  "re-running the completed plan writes nothing and reads all-landed"
cat > "$WORK/drop-everything.ts" <<'FIXER'
export default () => ({});
FIXER
if $CF piece repair -q --piece "$BOARD" --path items $ARGS \
  --fixer "$WORK/drop-everything.ts" \
  >/dev/null 2>"$WORK/repair-refuse.err"; then
  bad "a field-dropping fixer was accepted"
else
  ok "a field-dropping fixer exited nonzero"
fi
if grep -q "incomplete document" "$WORK/repair-refuse.err"; then
  ok "the refusal names the incomplete document"
else
  bad "the refusal does not name the incomplete document"
  sed 's/^/  | /' "$WORK/repair-refuse.err"
fi

step "11. A run stopped midway completes by re-invocation"
# A fixer that appends a mark, but whose answer for the third-planned piece
# breaks the schema: rows before it land, the run stops there with the
# remainder named, and re-invoking skips what landed — the property the
# design says rots silently unless a drill holds it.
cat > "$WORK/mark-titles.ts" <<'FIXER'
export default (document: Readonly<Record<string, unknown>>) => {
  const title = String(document.title ?? "");
  if (title === "GAMMA") return { ...document, title: 7 as never };
  return {
    ...document,
    ...(title !== "" && !title.endsWith("!")
      ? { title: `${title}!` }
      : {}),
  };
};
FIXER
RUN1=$($CF piece repair -q --piece "$BOARD" --path items $ARGS \
  --fixer "$WORK/mark-titles.ts" --apply --json 2>/dev/null |
  sed 's/^fvj1://' | jq -r '[(.applied|tostring),
    (.rows | map(.verdict) | .[0:3] | join(",")),
    ((.rows | map(.verdict) | map(select(. == "unattempted")) | length > 0)
      | tostring)] | @tsv')
check "$(printf '2\trepaired,repaired,failed\ttrue')" "$RUN1" \
  "the run landed two rows, stopped at the third, and named the rest"
RUN2=$($CF piece repair -q --piece "$BOARD" --path items $ARGS \
  --fixer "$WORK/mark-titles.ts" --apply --json 2>/dev/null |
  sed 's/^fvj1://' | jq -r '[(.applied|tostring),
    (.rows | map(.verdict) | .[0:3] | join(","))] | @tsv')
check "$(printf '0\tconforms,conforms,failed')" "$RUN2" \
  "re-invoking skips the landed rows and writes nothing for them"
cat > "$WORK/mark-titles-v2.ts" <<'FIXER'
export default (document: Readonly<Record<string, unknown>>) => {
  const title = String(document.title ?? "");
  return {
    ...document,
    ...(title !== "" && !title.endsWith("!")
      ? { title: `${title}!` }
      : {}),
  };
};
FIXER
RUN3=$($CF piece repair -q --piece "$BOARD" --path items $ARGS \
  --fixer "$WORK/mark-titles-v2.ts" --apply --json 2>/dev/null |
  sed 's/^fvj1://' | jq -r '[(.applied|tostring), (.complete|tostring)]
    | @tsv')
check "$(printf '%s\ttrue' "$((MEMBERS_NOW - 2))")" "$RUN3" \
  "the amended fixer completes the remainder by re-invocation"

step "12. A retarget plan over the whole board, from the fixture pair"
# The source is a copy, so a later step can edit it and prove the apply
# refuses a source that no longer produces the reference the plan recorded.
NEXT_SOURCE="$WORK/member-next.tsx"
cp "$RETARGET_FIXTURE" "$NEXT_SOURCE"
RETARGET_PLAN="$WORK/retarget.jsonl"
if $CF piece survey -q --piece "$BOARD" --path items $ARGS \
  --retarget "items=$NEXT_SOURCE" --main-export Member \
  --out "$RETARGET_PLAN" 2>"$WORK/retarget-survey.err"; then
  ok "the survey stamped the retarget onto every member row"
else
  bad "the retarget survey exited nonzero"
  sed 's/^/  | /' "$WORK/retarget-survey.err"
  exit 1
fi
PLAN_OPS=$(tail -n +2 "$RETARGET_PLAN" | jq -rs \
  'map(select(has("op"))) | length')
check "$MEMBERS_NOW" "$PLAN_OPS" "one retarget row per member, the holder none"

step "13. The dry run classifies every row and writes nothing"
DRY=$($CF piece retarget -q $ARGS --plan "$RETARGET_PLAN" --json \
  2>"$WORK/retarget-dry.err" | sed 's/^fvj1://' |
  jq -r '[(.applied|tostring), (.complete|tostring),
    (.rows | map(.verdict) | unique | join(",")),
    (.rows | length | tostring)] | @tsv')
check "$(printf '0\ttrue\toutstanding\t%s' "$MEMBERS_NOW")" "$DRY" \
  "every row reads outstanding against its own reference pair"

step "14. An edited source is refused, and the stop names the remainder"
# The reviewed plan pins the identity the source produced when it was
# reviewed. An edited source is a different identity, so the apply refuses
# the first row rather than landing something the plan's reader never saw.
printf '\n// edited after the plan was reviewed\n' >> "$NEXT_SOURCE"
if $CF piece retarget -q $ARGS --plan "$RETARGET_PLAN" --apply \
  --out "$WORK/stop.json" 2>"$WORK/retarget-stop.err"; then
  bad "an edited source ran under the reviewed plan"
else
  ok "an edited source exited nonzero under the reviewed plan"
fi
STOP_FACTS=$(sed 's/^fvj1://' "$WORK/stop.json" | jq -r '[(.applied|tostring),
  (.complete|tostring), (.rows[0].verdict),
  (.rows | map(select(.verdict == "unattempted") | .piece) | unique | length
    | tostring)] | @tsv')
check "$(printf '0\tfalse\trefused\t%s' "$((MEMBERS_NOW - 1))")" "$STOP_FACTS" \
  "the first row was refused, and every other piece is named unattempted"
if grep -q "resolves to" "$WORK/retarget-stop.err"; then
  ok "the refusal names the identity the source resolves to now"
else
  bad "the refusal does not name the resolved identity"
  sed 's/^/  | /' "$WORK/retarget-stop.err"
fi
cp "$RETARGET_FIXTURE" "$NEXT_SOURCE"

step "15. A run killed midway is completed by re-invoking the same command"
# The report streams a row at a time to stdout, so the drill reads rows as
# they land and kills the run on the sixth — inside the second group, past
# one group boundary. Nothing is waited on but the rows themselves.
#
# The interruption is proved rather than assumed, because a run that finished
# on its own would satisfy every assertion about the second invocation while
# exercising none of what this step exists for. Two independent proofs, both
# required: the first invocation's exit status must be a signal death, and a
# read-only pass between the two invocations must find real work on both
# sides of the cut.
mkfifo "$WORK/progress"
$CF piece retarget -q $ARGS --plan "$RETARGET_PLAN" --apply --group-size 5 \
  >"$WORK/progress" 2>"$WORK/retarget-killed.err" &
KILLED_PID=$!
# The read end stays open past the loop, on its own descriptor: closing it at
# the break would deliver a broken pipe and end the run before the signal
# does, which is a different interruption from the one this step claims.
exec 3<"$WORK/progress"
WATCHED=0
while IFS= read -r _row <&3; do
  WATCHED=$((WATCHED + 1))
  [ "$WATCHED" -ge 6 ] && break
done
if [ "$WATCHED" -ge 6 ]; then
  ok "watched $WATCHED rows land"
else
  bad "the run ended before six rows landed (saw $WATCHED)"
  sed 's/^/  | /' "$WORK/retarget-killed.err"
fi
if kill "$KILLED_PID" 2>/dev/null; then
  ok "signalled the run partway through its second group"
else
  bad "the run was already gone when the drill signalled it, so nothing was \
interrupted and this step proves nothing"
fi
wait "$KILLED_PID"
KILLED_STATUS=$?
exec 3<&-
# 128 plus the signal number: 143 for the SIGTERM sent above, 137 if it
# escalated. Any other status is a run that reached its own exit — the race
# this step must go red on rather than pass through.
if [ "$KILLED_STATUS" = "143" ] || [ "$KILLED_STATUS" = "137" ]; then
  ok "the first invocation died on the signal (exit $KILLED_STATUS)"
else
  bad "the first invocation exited $KILLED_STATUS rather than on the signal: \
it ran to its own end before the drill could stop it"
fi
# What the cut left behind, read without writing: rows on both sides of it.
# Zero on either side is a run that was never stopped midway, whatever the
# exit status said.
MIDWAY=$($CF piece retarget -q $ARGS --plan "$RETARGET_PLAN" --json \
  2>"$WORK/retarget-midway.err" | sed 's/^fvj1://' |
  jq -r '[(.rows | map(select(.verdict == "landed")) | length | tostring),
    (.rows | map(select(.verdict == "outstanding")) | length | tostring)]
    | @tsv')
MIDWAY_LANDED=$(printf '%s' "$MIDWAY" | cut -f1)
MIDWAY_OUTSTANDING=$(printf '%s' "$MIDWAY" | cut -f2)
if [ "${MIDWAY_LANDED:-0}" -ge "$WATCHED" ] &&
  [ "${MIDWAY_OUTSTANDING:-0}" -gt 0 ]; then
  ok "the cut left $MIDWAY_LANDED landed and $MIDWAY_OUTSTANDING outstanding"
else
  bad "the cut left $MIDWAY_LANDED landed and $MIDWAY_OUTSTANDING \
outstanding, of $WATCHED rows watched: the run was not stopped midway"
fi
check "$MEMBERS_NOW" \
  "$((${MIDWAY_LANDED:-0} + ${MIDWAY_OUTSTANDING:-0}))" \
  "between the invocations every row is landed or outstanding, nothing else"
RESUME=$($CF piece retarget -q $ARGS --plan "$RETARGET_PLAN" --apply --json \
  2>"$WORK/retarget-resume.err" | sed 's/^fvj1://' |
  jq -r '[(.complete|tostring),
    (.rows | map(select(.verdict == "landed")) | length | tostring),
    (.rows | map(select(.verdict == "applied")) | length | tostring)] | @tsv')
RESUME_COMPLETE=$(printf '%s' "$RESUME" | cut -f1)
RESUME_LANDED=$(printf '%s' "$RESUME" | cut -f2)
RESUME_APPLIED=$(printf '%s' "$RESUME" | cut -f3)
check "true" "$RESUME_COMPLETE" "the re-invocation completed the run"
check "$MIDWAY_LANDED" "$RESUME_LANDED" \
  "the rows the killed run landed were read as landed, not rewritten"
check "$MIDWAY_OUTSTANDING" "$RESUME_APPLIED" \
  "the re-invocation wrote the remainder, and only the remainder"
check "$MEMBERS_NOW" "$((${RESUME_LANDED:-0} + ${RESUME_APPLIED:-0}))" \
  "every member row is accounted for across the two invocations"

step "16. Re-running the completed plan writes nothing"
SETTLED=$($CF piece retarget -q $ARGS --plan "$RETARGET_PLAN" --apply --json \
  2>/dev/null | sed 's/^fvj1://' | jq -r '[(.applied|tostring),
    (.complete|tostring), (.rows | map(.verdict) | unique | join(","))]
    | @tsv')
check "$(printf '0\ttrue\tlanded')" "$SETTLED" \
  "a settled plan re-runs as all-landed and writes nothing"

step "17. A piece on neither of its row's references stops the run by name"
FIRST_MEMBER=$(tail -n +2 "$RETARGET_PLAN" |
  jq -r 'select(has("op")) | .piece' | head -1)
SECOND_MEMBER=$(tail -n +2 "$RETARGET_PLAN" |
  jq -r 'select(has("op")) | .piece' | sed -n 2p)
# MemberAlias is the same module under a second symbol, so this piece now
# carries the target row's identity and not its symbol: a check comparing the
# identity alone would call it landed.
if $CF piece setsrc -q --piece "$FIRST_MEMBER" --main-export MemberAlias \
  "$RETARGET_FIXTURE" $ARGS >/dev/null 2>"$WORK/alias.err"; then
  ok "moved a member to the target identity under another symbol"
else
  bad "moving a member to the alias export failed"
  sed 's/^/  | /' "$WORK/alias.err"
fi
if $CF piece retarget -q $ARGS --plan "$RETARGET_PLAN" --apply \
  --out "$WORK/moved.json" 2>"$WORK/moved.err"; then
  bad "a piece on neither reference did not stop the run"
else
  ok "a piece on neither reference exited nonzero"
fi
MOVED_FACTS=$(sed 's/^fvj1://' "$WORK/moved.json" | jq -r '[(.applied|tostring),
  (.complete|tostring),
  (.rows | map(select(.verdict == "moved-elsewhere") | .piece) | join(",")),
  (.rows | map(select(.verdict == "landed")) | length | tostring)] | @tsv')
check "$(printf '0\tfalse\t%s\t%s' "$FIRST_MEMBER" "$((MEMBERS_NOW - 1))")" \
  "$MOVED_FACTS" \
  "the moved piece is named, and nothing was written for any row"
if grep -q "$FIRST_MEMBER" "$WORK/moved.err"; then
  ok "the stop names the piece rather than counting it"
else
  bad "the stop does not name the moved piece"
  sed 's/^/  | /' "$WORK/moved.err"
fi

step "18. The after-survey tells the three outcomes apart"
# One member back on the prior generation, so the diff has an outstanding row
# to distinguish from the one that moved somewhere the plan never named.
$CF piece setsrc -q --piece "$SECOND_MEMBER" --main-export Member \
  "$MEMBER_FIXTURE" $ARGS >/dev/null 2>"$WORK/revert.err" ||
  bad "moving a member back to the prior generation failed"
if $CF piece survey -q --piece "$BOARD" --path items $ARGS \
  --diff "$RETARGET_PLAN" --json >"$WORK/diff.json" 2>"$WORK/diff.err"; then
  bad "the diff exited 0 with rows outstanding and moved elsewhere"
else
  ok "the diff exited nonzero with rows outstanding and moved elsewhere"
fi
DIFF_FACTS=$(jq -r '[(.counts.landed|tostring), (.counts.outstanding|tostring),
  (.counts["moved-elsewhere"]|tostring), (.counts.unchanged|tostring),
  (.unplanned | length | tostring)] | @tsv' "$WORK/diff.json")
check "$(printf '%s\t1\t1\t1\t0' "$((MEMBERS_NOW - 2))")" "$DIFF_FACTS" \
  "moved as planned, still outstanding, and moved to something unplanned"

step "19. A registered in-scope orphan makes the survey refuse"
ORPHAN=$($CF piece new --quiet --main-export Member \
  "$MEMBER_FIXTURE" $ARGS 2>/dev/null |
  grep -oE '^fid1:[A-Za-z0-9_-]+' | head -1)
if [ -n "$ORPHAN" ]; then ok "registered orphan $ORPHAN"; else
  bad "orphan deploy failed"
fi
if $CF piece survey -q --piece "$BOARD" --path items $ARGS \
  >/dev/null 2>"$WORK/incomplete.err"; then
  bad "survey exited 0 despite a registered in-scope orphan"
else
  ok "survey exited nonzero with an orphan registered"
fi
if grep -q "registered outside the selection" "$WORK/incomplete.err"; then
  ok "the refusal names the orphan's standing"
else
  bad "the refusal does not name the orphan"
fi

step "20. A list survey claims no containment"
LIST_FACTS=$($CF piece survey -q --list "$BOARD" $ARGS 2>/dev/null |
  head -1 | jq -r '[.selector, (.enumerated.collection|tostring),
    (.enumerated.registeredOutside|tostring)] | @tsv')
check "$(printf 'list\t1\t0')" "$LIST_FACTS" \
  "list of one row, complete despite the orphan"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
