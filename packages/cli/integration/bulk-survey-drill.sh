#!/usr/bin/env bash
# The bulk-survey drill: deploy a board whose members are created through its
# own verb, survey it, and assert the plan — the stage-1 drill of
# docs/plans/piece-bulk-operations.md, which finishes each stage with a CI
# drill so "does the migration tooling still work?" stays a CI result.
#
# It deploys pattern/bulk-board.tsx (members from pattern/bulk-member.tsx, a
# separate module so member and board identities differ, the way topic.tsx
# sits beside the topics board's main.tsx) and stamps a retarget from
# pattern/bulk-member-v2.tsx, which is never deployed: the survey computes the
# identity the source produces without writing anything. The fixtures belong
# to this drill alone.
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
APPLY_FACTS=$($CF piece repair -q --piece "$BOARD" --path items $ARGS \
  --fixer "$WORK/fix-titles.ts" --plan "$WORK/repair.jsonl" --apply --json \
  2>"$WORK/repair-apply.err" | jq -r '[(.applied|tostring),
    (.complete|tostring), (.rows | map(.verdict) | unique | join(","))]
    | @tsv')
MEMBERS_NOW=$((MEMBERS_TOTAL + 1))
check "$(printf '%s\ttrue\trepaired' "$MEMBERS_NOW")" "$APPLY_FACTS" \
  "the plan-driven apply repaired every member row"
RESUME=$($CF piece repair -q --piece "$BOARD" --path items $ARGS \
  --fixer "$WORK/fix-titles.ts" --plan "$WORK/repair.jsonl" --apply --json \
  2>/dev/null | jq -r '[(.applied|tostring), (.complete|tostring),
    (.rows | map(.verdict) | unique | join(","))] | @tsv')
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

step "11. A registered in-scope orphan makes the survey refuse"
ORPHAN=$($CF piece new --quiet --main-export Member \
  "$SCRIPT_DIR/pattern/bulk-member.tsx" $ARGS 2>/dev/null |
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

step "12. A list survey claims no containment"
LIST_FACTS=$($CF piece survey -q --list "$BOARD" $ARGS 2>/dev/null |
  head -1 | jq -r '[.selector, (.enumerated.collection|tostring),
    (.enumerated.registeredOutside|tostring)] | @tsv')
check "$(printf 'list\t1\t0')" "$LIST_FACTS" \
  "list of one row, complete despite the orphan"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
