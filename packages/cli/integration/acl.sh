#!/usr/bin/env bash
set -e
SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

# This sectionless script is one recorded test.
source "$SCRIPT_DIR/test-records.sh"
cf_test_record_script "acl.sh"

error () {
  >&2 echo "ERROR: $1"
  exit 1
}

success () {
  echo "✓ $1"
}

if [ -n "$CF_CLI_INTEGRATION_USE_LOCAL" ]; then
 cf() {
   deno task cli "$@"
 }
fi

if [ -z "$API_URL" ]; then
  error "API_URL must be defined."
fi

# Setup test environment
SPACE=$(mktemp -u XXXXXXXXXX) # generates a random space name
IDENTITY_OWNER=$(mktemp)
IDENTITY_USER1=$(mktemp)
IDENTITY_USER2=$(mktemp)
IDENTITY_USER3=$(mktemp)
PATTERN_SRC="$SCRIPT_DIR/pattern/main.tsx"
WORK_DIR=$(mktemp -d)

# Create identities
cf id new > $IDENTITY_OWNER
cf id new > $IDENTITY_USER1
cf id new > $IDENTITY_USER2
cf id new > $IDENTITY_USER3

DID_OWNER=$(cf id did $IDENTITY_OWNER)
DID_USER1=$(cf id did $IDENTITY_USER1)
DID_USER2=$(cf id did $IDENTITY_USER2)
DID_USER3=$(cf id did $IDENTITY_USER3)

# Helper to create space args for each identity
SPACE_ARGS_OWNER="--api-url=$API_URL --identity=$IDENTITY_OWNER --space=$SPACE"
SPACE_ARGS_USER1="--api-url=$API_URL --identity=$IDENTITY_USER1 --space=$SPACE"
SPACE_ARGS_USER2="--api-url=$API_URL --identity=$IDENTITY_USER2 --space=$SPACE"
SPACE_ARGS_USER3="--api-url=$API_URL --identity=$IDENTITY_USER3 --space=$SPACE"

echo "=========================================="
echo "ACL Integration Test Suite"
echo "=========================================="
echo "API_URL=$API_URL"
echo "SPACE=$SPACE"
echo "DID_OWNER=$DID_OWNER"
echo "DID_USER1=$DID_USER1"
echo "DID_USER2=$DID_USER2"
echo "DID_USER3=$DID_USER3"
echo "WORK_DIR=$WORK_DIR"
echo ""

# Test 1: Initial space creation - owner should have automatic access
echo "Test 1: Initial space creation and owner access"
PIECE_ID=$(cf piece new --main-export customPatternExport $SPACE_ARGS_OWNER $PATTERN_SRC)
echo "Created piece: $PIECE_ID"

if ! cf piece ls $SPACE_ARGS_OWNER | grep -q "$PIECE_ID"; then
  error "Owner should be able to list their own piece"
fi
success "Owner has automatic access to newly created space"

# Test 2: ACL initialization - owner should be in initial ACL
echo ""
echo "Test 2: ACL initialization"
ACL_OUTPUT=$(cf acl ls $SPACE_ARGS_OWNER)
if ! echo "$ACL_OUTPUT" | grep -q "$DID_OWNER"; then
  error "Owner DID should be in ACL after space creation"
fi
if ! echo "$ACL_OUTPUT" | grep -q "OWNER"; then
  error "Owner should have OWNER capability"
fi
success "ACL initialized with owner having OWNER capability"

# Test 3: Default access posture for an unlisted user
#
# This test used to assert that an unlisted user had NO access, because a named
# space was private by default. That stopped being true in 4eb3026d1 (#4670,
# 2026-07-10, "re-enable space ACL enforcement" / "default named spaces to
# public write"): genesis now writes `"*": "WRITE"` alongside the owner entry
# (see the bootstrapAcl in packages/runner/src/storage/v2.ts), so every
# authenticated principal legitimately has WRITE on a named space. The old
# assertion was not flaky, it was structurally unpassable — do not restore it.
#
# What still holds, and is what this test now pins, is that enforcement is ON
# rather than OFF: the wildcard grants WRITE, not OWNER. An unlisted user can
# read and write, but cannot touch the ACL. The private-by-default case is
# covered at the end of the script, after the wildcard has been removed.
echo ""
echo "Test 3: Default access posture (genesis wildcard)"

# The wildcard is an explicit part of the contract, so assert it is there
# rather than inferring it from the access checks below.
ACL_OUTPUT=$(cf acl ls $SPACE_ARGS_OWNER)
if ! echo "$ACL_OUTPUT" | grep '\*' | grep -q "WRITE"; then
  error "Genesis should grant the wildcard '*' WRITE on a named space"
fi
success "Genesis ACL contains the '*' => WRITE entry"

if ! cf piece ls $SPACE_ARGS_USER1 | grep -q "$PIECE_ID"; then
  error "USER1 should inherit read access from the '*' entry"
fi
success "Unlisted user can read via the wildcard"

PIECE_ID_WILDCARD=$(cf piece new --main-export customPatternExport $SPACE_ARGS_USER1 $PATTERN_SRC)
if [ -z "$PIECE_ID_WILDCARD" ]; then
  error "USER1 should inherit write access from the '*' entry"
fi
success "Unlisted user can write via the wildcard"

# The load-bearing assertion: WRITE is not OWNER, so the wildcard does not
# hand out ACL management. If this ever passes, enforcement is off entirely.
if cf acl set $DID_USER2 READ $SPACE_ARGS_USER1 2>/dev/null; then
  error "USER1 with only the wildcard WRITE should not be able to modify the ACL"
fi
success "Unlisted user cannot manage the ACL - enforcement is real"

# Test 4: Set READ capability
echo ""
echo "Test 4: Set READ capability"
cf acl set $DID_USER1 READ $SPACE_ARGS_OWNER
success "Added USER1 with READ capability"

# Verify USER1 appears in ACL
ACL_OUTPUT=$(cf acl ls $SPACE_ARGS_OWNER)
if ! echo "$ACL_OUTPUT" | grep -q "$DID_USER1"; then
  error "USER1 should appear in ACL after addition"
fi
if ! echo "$ACL_OUTPUT" | grep "$DID_USER1" | grep -q "READ"; then
  error "USER1 should have READ capability"
fi
success "USER1 correctly listed in ACL with READ capability"

# Verify USER1 can now read
if ! cf piece ls $SPACE_ARGS_USER1 | grep -q "$PIECE_ID"; then
  error "USER1 with READ capability should be able to list pieces"
fi
success "USER1 with READ capability can query/read data"

# Test 5: READ capability does not allow writes
echo ""
echo "Test 5: READ capability restrictions"
if cf piece new --main-export customPatternExport $SPACE_ARGS_USER1 $PATTERN_SRC 2>/dev/null; then
  error "USER1 with READ should not be able to create pieces"
fi
success "READ capability correctly prevents write operations"

# Test 6: Set WRITE capability
echo ""
echo "Test 6: Set WRITE capability"
cf acl set $DID_USER2 WRITE $SPACE_ARGS_OWNER
success "Added USER2 with WRITE capability"

# Verify USER2 can read
if ! cf piece ls $SPACE_ARGS_USER2 | grep -q "$PIECE_ID"; then
  error "USER2 with WRITE capability should be able to read"
fi
success "USER2 with WRITE capability can read data"

# Verify USER2 can write
PIECE_ID2=$(cf piece new --main-export customPatternExport $SPACE_ARGS_USER2 $PATTERN_SRC)
if [ -z "$PIECE_ID2" ]; then
  error "USER2 with WRITE capability should be able to create pieces"
fi
success "USER2 with WRITE capability can write data"

# Test 7: Upgrade capability from READ to WRITE
echo ""
echo "Test 7: Upgrade capability (READ -> WRITE)"
cf acl set $DID_USER1 WRITE $SPACE_ARGS_OWNER
success "Upgraded USER1 from READ to WRITE"

# Verify upgrade
ACL_OUTPUT=$(cf acl ls $SPACE_ARGS_OWNER)
if ! echo "$ACL_OUTPUT" | grep "$DID_USER1" | grep -q "WRITE"; then
  error "USER1 should now have WRITE capability"
fi
success "USER1 capability correctly upgraded to WRITE"

# Verify USER1 can now write
PIECE_ID3=$(cf piece new --main-export customPatternExport $SPACE_ARGS_USER1 $PATTERN_SRC)
if [ -z "$PIECE_ID3" ]; then
  error "USER1 with upgraded WRITE capability should be able to create pieces"
fi
success "USER1 with upgraded WRITE capability can now write"

# Test 8: Add OWNER capability
echo ""
echo "Test 8: Set OWNER capability"
cf acl set $DID_USER3 OWNER $SPACE_ARGS_OWNER
success "Added USER3 with OWNER capability"

# Verify USER3 can manage ACL (owner capability)
cf acl set $DID_USER2 OWNER $SPACE_ARGS_USER3
success "USER3 with OWNER capability can modify ACL"

# Verify the change
ACL_OUTPUT=$(cf acl ls $SPACE_ARGS_OWNER)
if ! echo "$ACL_OUTPUT" | grep "$DID_USER2" | grep -q "OWNER"; then
  error "USER2 should now have OWNER capability"
fi
success "USER3 successfully modified ACL with OWNER capability"

# Test 9: Remove ACL entry
echo ""
echo "Test 9: Remove ACL entry"
cf acl remove $DID_USER1 $SPACE_ARGS_OWNER
success "Removed USER1 from ACL"

# Verify removal
ACL_OUTPUT=$(cf acl ls $SPACE_ARGS_OWNER)
if echo "$ACL_OUTPUT" | grep -q "$DID_USER1"; then
  error "USER1 should not appear in ACL after removal"
fi
success "USER1 successfully removed from ACL"

# Removing an entry revokes that entry, not all access: USER1 falls back to the
# genesis `"*": "WRITE"` wildcard (see the note on Test 3). This assertion used
# to read "USER1 should not have access after removal" and became unpassable in
# #4670 for the same reason Test 3 did. Test 14 is where removal actually
# reduces access to nothing, once the wildcard itself has been removed.
if ! cf piece ls $SPACE_ARGS_USER1 | grep -q "$PIECE_ID"; then
  error "USER1 should fall back to the wildcard after removal, not lose all access"
fi
success "USER1 falls back to the wildcard default after ACL removal"

# Test 10: Multiple ACL entries
echo ""
echo "Test 10: List multiple ACL entries"
ACL_OUTPUT=$(cf acl ls $SPACE_ARGS_OWNER)
ACL_COUNT=$(echo "$ACL_OUTPUT" | grep -c "did:key:" || true)

# Should have at least: OWNER (original), USER2 (OWNER), USER3 (OWNER)
if [ "$ACL_COUNT" -lt 3 ]; then
  error "ACL should contain at least 3 entries"
fi
success "ACL correctly lists multiple entries"

# Verify specific capabilities are correct
if ! echo "$ACL_OUTPUT" | grep "$DID_OWNER" | grep -q "OWNER"; then
  error "Original owner should still have OWNER capability"
fi
if ! echo "$ACL_OUTPUT" | grep "$DID_USER2" | grep -q "OWNER"; then
  error "USER2 should have OWNER capability"
fi
if ! echo "$ACL_OUTPUT" | grep "$DID_USER3" | grep -q "OWNER"; then
  error "USER3 should have OWNER capability"
fi
success "All ACL entries have correct capabilities"

# Test 11: Non-owner with OWNER capability can remove others
echo ""
echo "Test 11: OWNER capability allows removing other users"
cf acl remove $DID_USER3 $SPACE_ARGS_USER2
success "USER2 (OWNER) successfully removed USER3"

# Verify removal
ACL_OUTPUT=$(cf acl ls $SPACE_ARGS_OWNER)
if echo "$ACL_OUTPUT" | grep -q "$DID_USER3"; then
  error "USER3 should not appear in ACL after removal by USER2"
fi
success "USER3 successfully removed by non-original owner with OWNER capability"

# Test 12: Downgrade capability (OWNER -> READ)
echo ""
echo "Test 12: Downgrade capability (OWNER -> READ)"
cf acl set $DID_USER2 READ $SPACE_ARGS_OWNER
success "Downgraded USER2 from OWNER to READ"

# Verify downgrade
ACL_OUTPUT=$(cf acl ls $SPACE_ARGS_OWNER)
if ! echo "$ACL_OUTPUT" | grep "$DID_USER2" | grep -q "READ"; then
  error "USER2 should now have READ capability"
fi
success "USER2 capability correctly downgraded to READ"

# Verify USER2 can no longer write
if cf piece new --main-export customPatternExport $SPACE_ARGS_USER2 $PATTERN_SRC 2>/dev/null; then
  error "USER2 with downgraded READ should not be able to create pieces"
fi
success "Downgraded USER2 correctly restricted to READ operations"

# Verify USER2 can no longer manage ACL
if cf acl set $DID_USER1 READ $SPACE_ARGS_USER2 2>/dev/null; then
  error "USER2 with READ should not be able to modify ACL"
fi
success "Downgraded USER2 cannot manage ACL"

# Test 13: The last concrete owner cannot be removed
echo ""
echo "Test 13: Last-owner protection"
if cf acl remove $DID_OWNER $SPACE_ARGS_OWNER 2>/dev/null; then
  error "Removing the last concrete OWNER should be rejected"
fi
ACL_OUTPUT=$(cf acl ls $SPACE_ARGS_OWNER)
if ! echo "$ACL_OUTPUT" | grep "$DID_OWNER" | grep -q "OWNER"; then
  error "Rejected last-owner removal must preserve the ACL"
fi
success "Last concrete OWNER is preserved"

# Test 14: Lockdown - removing the wildcard makes the space private
#
# This is where the original Test 3 intent now lives. A named space is created
# world-writable by the genesis `"*": "WRITE"` entry (#4670); removing that
# entry is the only way to make it private, and it is a post-genesis ACL
# mutation like any other. Keep this last: every test above depends on the
# wildcard being present.
echo ""
echo "Test 14: Lockdown - remove the wildcard"
# "ANYONE" is the CLI spelling of "*", so the shell does not glob it.
cf acl remove ANYONE $SPACE_ARGS_OWNER
success "Removed the '*' entry from the ACL"

ACL_OUTPUT=$(cf acl ls $SPACE_ARGS_OWNER)
if echo "$ACL_OUTPUT" | grep -q '\*'; then
  error "Wildcard should not appear in ACL after removal"
fi
success "Wildcard no longer listed in ACL"

# USER1 was removed from the ACL in Test 9 and has no entry of its own, so with
# the wildcard gone it now has no capability at all.
if cf piece ls $SPACE_ARGS_USER1 2>/dev/null | grep -q "$PIECE_ID"; then
  error "USER1 should not be able to read a space with no wildcard and no entry"
fi
success "Unlisted user cannot read after lockdown"

if cf piece new --main-export customPatternExport $SPACE_ARGS_USER1 $PATTERN_SRC 2>/dev/null; then
  error "USER1 should not be able to write a space with no wildcard and no entry"
fi
success "Unlisted user cannot write after lockdown"

# Lockdown must not lock the owner out, nor drop the surviving explicit grants.
if ! cf piece ls $SPACE_ARGS_OWNER | grep -q "$PIECE_ID"; then
  error "Owner must retain access after lockdown"
fi
success "Owner retains access after lockdown"

if ! cf piece ls $SPACE_ARGS_USER2 | grep -q "$PIECE_ID"; then
  error "USER2's explicit READ grant must survive removal of the wildcard"
fi
success "Explicit grants survive lockdown"

# Cleanup
echo ""
echo "=========================================="
echo "Cleaning up test artifacts..."
rm -f $IDENTITY_OWNER $IDENTITY_USER1 $IDENTITY_USER2 $IDENTITY_USER3
rm -rf $WORK_DIR
echo "Cleanup complete"

echo ""
echo "=========================================="
echo "✓ All ACL tests passed!"
echo "=========================================="
