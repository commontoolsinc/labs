---
status: historical
created: 2026-08-16
archived: 2026-08-16
reason: "Executed final review corrections for the strict CFC default rollout."
---

# CFC enforcement default rollout final review corrections

This work order records the changes required by the final adversarial review
of the strict CFC default rollout. Each numbered section is one commit. These
commits follow the original rollout and its first review corrections without
changing the two leading boundaries: the first commit contains only switch
changes, and the second contains only tests that directly inspect those
switches.

## 1. Clarify the atomic parking grant contract boundary

The trusted parking change log must declare both the administrator-manager
endorsement and the parking-administrator endorsement when the new contract is
introduced. Recording a manager-only change-log contract and adding the
parking endorsement in the next commit is not backward compatible, so the
schema and its first compatibility baseline must remain atomic.

The next commit independently preserves the stored policy-bearing change
object during role lookup. Describe that commit as an identity-preservation
change rather than claiming that it introduces the two endorsements. This
keeps the implementation safe and makes every commit description match its
actual diff.

## 2. Prove that a trusted grant carries both runtime endorsements

The focused browser test currently proves that a trusted administrator grant
is recognized by the user interface. It does not inspect the CFC label stored
with that grant. A change object without the parking-administrator endorsement
could still satisfy the visible checks while failing protected parking writes.

Subscribe to the resolved administrator change-log cell with CFC labels
included. After the trusted browser grant, synchronize the controller and
assert that the persisted change carries both the parking-administrator and
administrator-manager endorsements. Keep the existing administrator-mode and
revocation assertions around that runtime contract check.

## 3. Prove that person mutation waits for administrator revocation

The parking pattern rejects person editing and removal while that person is an
administrator. No test currently pins that boundary or proves that the same
operation becomes available after the administrator role is removed.

Invoke the remove-person action while the trusted grant is active and assert
that the person remains. Revoke the role through the trusted browser surface,
invoke the same action again, and assert that the person is removed. The demo
actor revokes her own role, which immediately closes administrator mode, so
the action-level assertion tests the policy without depending on controls that
are no longer available after revocation.

## 4. Describe the strict harness default accurately

The harness README still describes the old permissive-if-absent default even
though the runtime switch now selects strict enforcement. Update the statement
to name `enforce-strict`. Keep the surrounding explanation that callers can
override the mode explicitly.

## Verification note

The rooted parking pattern test resolves its imports but remains pending under
both strict and observe modes. The observe control means the stall cannot be
attributed to the strict-default rollout. The focused strict browser test
covers the persisted grant endorsements and the person-mutation guard while
that pre-existing pattern test problem remains separate.
