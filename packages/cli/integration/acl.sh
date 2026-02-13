#!/usr/bin/env bash
set -e
SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )
error () {
  >&2 echo "ERROR: $1"
  exit 1
}

success () {
  echo "✓ $1"
}

if [ -n "$CT_CLI_INTEGRATION_USE_LOCAL" ]; then
 ct() {
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
ct id new > $IDENTITY_OWNER
ct id new > $IDENTITY_USER1
ct id new > $IDENTITY_USER2
ct id new > $IDENTITY_USER3

DID_OWNER=$(ct id did $IDENTITY_OWNER)
DID_USER1=$(ct id did $IDENTITY_USER1)
DID_USER2=$(ct id did $IDENTITY_USER2)
DID_USER3=$(ct id did $IDENTITY_USER3)

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
CHARM_ID=$(ct charm new --main-export customPatternExport $SPACE_ARGS_OWNER $PATTERN_SRC)
echo "Created charm: $CHARM_ID"

if ! ct charm ls $SPACE_ARGS_OWNER | grep -q "$CHARM_ID"; then
  error "Owner should be able to list their own charm"
fi
success "Owner has automatic access to newly created space"

# Test 2: ACL initialization - owner should be in initial ACL
echo ""
echo "Test 2: ACL initialization"
ACL_OUTPUT=$(ct acl ls $SPACE_ARGS_OWNER)
if ! echo "$ACL_OUTPUT" | grep -q "$DID_OWNER"; then
  error "Owner DID should be in ACL after space creation"
fi
if ! echo "$ACL_OUTPUT" | grep -q "OWNER"; then
  error "Owner should have OWNER capability"
fi
success "ACL initialized with owner having OWNER capability"

# Test 3: Non-authorized users cannot access space
echo ""
echo "Test 3: Access control - unauthorized users"
if ct charm ls $SPACE_ARGS_USER1 2>/dev/null | grep -q "$CHARM_ID"; then
  error "USER1 should not have access without ACL entry"
fi
success "Unauthorized user cannot access space"

if ct charm ls $SPACE_ARGS_USER2 2>/dev/null | grep -q "$CHARM_ID"; then
  error "USER2 should not have access without ACL entry"
fi
success "Multiple unauthorized users correctly denied access"

# Test 4: Set READ capability
echo ""
echo "Test 4: Set READ capability"
ct acl set $DID_USER1 READ $SPACE_ARGS_OWNER
success "Added USER1 with READ capability"

# Verify USER1 appears in ACL
ACL_OUTPUT=$(ct acl ls $SPACE_ARGS_OWNER)
if ! echo "$ACL_OUTPUT" | grep -q "$DID_USER1"; then
  error "USER1 should appear in ACL after addition"
fi
if ! echo "$ACL_OUTPUT" | grep "$DID_USER1" | grep -q "READ"; then
  error "USER1 should have READ capability"
fi
success "USER1 correctly listed in ACL with READ capability"

# Verify USER1 can now read
if ! ct charm ls $SPACE_ARGS_USER1 | grep -q "$CHARM_ID"; then
  error "USER1 with READ capability should be able to list charms"
fi
success "USER1 with READ capability can query/read data"

# Test 5: READ capability does not allow writes
echo ""
echo "Test 5: READ capability restrictions"
if ct charm new --main-export customPatternExport $SPACE_ARGS_USER1 $PATTERN_SRC 2>/dev/null; then
  error "USER1 with READ should not be able to create charms"
fi
success "READ capability correctly prevents write operations"

# Test 6: Set WRITE capability
echo ""
echo "Test 6: Set WRITE capability"
ct acl set $DID_USER2 WRITE $SPACE_ARGS_OWNER
success "Added USER2 with WRITE capability"

# Verify USER2 can read
if ! ct charm ls $SPACE_ARGS_USER2 | grep -q "$CHARM_ID"; then
  error "USER2 with WRITE capability should be able to read"
fi
success "USER2 with WRITE capability can read data"

# Verify USER2 can write
CHARM_ID2=$(ct charm new --main-export customPatternExport $SPACE_ARGS_USER2 $PATTERN_SRC)
if [ -z "$CHARM_ID2" ]; then
  error "USER2 with WRITE capability should be able to create charms"
fi
success "USER2 with WRITE capability can write data"

# Test 7: Upgrade capability from READ to WRITE
echo ""
echo "Test 7: Upgrade capability (READ -> WRITE)"
ct acl set $DID_USER1 WRITE $SPACE_ARGS_OWNER
success "Upgraded USER1 from READ to WRITE"

# Verify upgrade
ACL_OUTPUT=$(ct acl ls $SPACE_ARGS_OWNER)
if ! echo "$ACL_OUTPUT" | grep "$DID_USER1" | grep -q "WRITE"; then
  error "USER1 should now have WRITE capability"
fi
success "USER1 capability correctly upgraded to WRITE"

# Verify USER1 can now write
CHARM_ID3=$(ct charm new --main-export customPatternExport $SPACE_ARGS_USER1 $PATTERN_SRC)
if [ -z "$CHARM_ID3" ]; then
  error "USER1 with upgraded WRITE capability should be able to create charms"
fi
success "USER1 with upgraded WRITE capability can now write"

# Test 8: Add OWNER capability
echo ""
echo "Test 8: Set OWNER capability"
ct acl set $DID_USER3 OWNER $SPACE_ARGS_OWNER
success "Added USER3 with OWNER capability"

# Verify USER3 can manage ACL (owner capability)
ct acl set $DID_USER2 OWNER $SPACE_ARGS_USER3
success "USER3 with OWNER capability can modify ACL"

# Verify the change
ACL_OUTPUT=$(ct acl ls $SPACE_ARGS_OWNER)
if ! echo "$ACL_OUTPUT" | grep "$DID_USER2" | grep -q "OWNER"; then
  error "USER2 should now have OWNER capability"
fi
success "USER3 successfully modified ACL with OWNER capability"

# Test 9: Remove ACL entry
echo ""
echo "Test 9: Remove ACL entry"
ct acl remove $DID_USER1 $SPACE_ARGS_OWNER
success "Removed USER1 from ACL"

# Verify removal
ACL_OUTPUT=$(ct acl ls $SPACE_ARGS_OWNER)
if echo "$ACL_OUTPUT" | grep -q "$DID_USER1"; then
  error "USER1 should not appear in ACL after removal"
fi
success "USER1 successfully removed from ACL"

# Verify USER1 no longer has access
if ct charm ls $SPACE_ARGS_USER1 2>/dev/null | grep -q "$CHARM_ID"; then
  error "USER1 should not have access after removal from ACL"
fi
success "USER1 access revoked after ACL removal"

# Test 10: Multiple ACL entries
echo ""
echo "Test 10: List multiple ACL entries"
ACL_OUTPUT=$(ct acl ls $SPACE_ARGS_OWNER)
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
ct acl remove $DID_USER3 $SPACE_ARGS_USER2
success "USER2 (OWNER) successfully removed USER3"

# Verify removal
ACL_OUTPUT=$(ct acl ls $SPACE_ARGS_OWNER)
if echo "$ACL_OUTPUT" | grep -q "$DID_USER3"; then
  error "USER3 should not appear in ACL after removal by USER2"
fi
success "USER3 successfully removed by non-original owner with OWNER capability"

# Test 12: Downgrade capability (OWNER -> READ)
echo ""
echo "Test 12: Downgrade capability (OWNER -> READ)"
ct acl set $DID_USER2 READ $SPACE_ARGS_OWNER
success "Downgraded USER2 from OWNER to READ"

# Verify downgrade
ACL_OUTPUT=$(ct acl ls $SPACE_ARGS_OWNER)
if ! echo "$ACL_OUTPUT" | grep "$DID_USER2" | grep -q "READ"; then
  error "USER2 should now have READ capability"
fi
success "USER2 capability correctly downgraded to READ"

# Verify USER2 can no longer write
if ct charm new --main-export customPatternExport $SPACE_ARGS_USER2 $PATTERN_SRC 2>/dev/null; then
  error "USER2 with downgraded READ should not be able to create charms"
fi
success "Downgraded USER2 correctly restricted to READ operations"

# Verify USER2 can no longer manage ACL
if ct acl set $DID_USER1 READ $SPACE_ARGS_USER2 2>/dev/null; then
  error "USER2 with READ should not be able to modify ACL"
fi
success "Downgraded USER2 cannot manage ACL"

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
