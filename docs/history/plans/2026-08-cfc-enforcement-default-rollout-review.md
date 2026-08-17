---
status: historical
created: 2026-08-16
archived: 2026-08-16
reason: "Executed review corrections for the strict CFC default rollout."
---

# CFC enforcement default rollout review corrections

This work order records the changes required after adversarial review of the
strict CFC default rollout. Each numbered section is one commit. These commits
follow the original work order without changing its first two boundaries: the
first original commit still contains only the switch changes, and the second
still contains only the tests that directly inspect those switches.

## 1. Wait for the held dependency before the second test edit

The held-window runner scenario used `editWithRetry` around the input edit.
That helper concealed the first strict-enforcement result: the transaction is
expected to conflict because a dependency is deliberately held. It also
violated the repository rule against retry loops.

Commit the first edit once and assert the exact `ConflictError` and pending
dependency message. Read the conflict's readiness edge and await it. Create one
fresh transaction after that edge resolves, apply the same value once, and
assert that the second commit succeeds. This keeps the test deterministic and
tests the intended scheduling boundary directly.

## 2. Preserve the parking registry and append trusted policy changes

The first parking correction replaced the caller-provided administrator
registry with a new internal cell. It also changed the durable fallback cell
identity. Both behaviors discard existing state and break callers that provide
a shared registry.

Keep the existing `adminRegistry` input and its stable per-space fallback.
Treat that registry as the legacy role source. Add a separate per-space change
registry whose only protected field is an append-only sequence of trusted
administrator changes. The trusted handler writes the complete sequence back
through its precisely typed boundary. Read the newest change for a person
before falling back to the legacy registry. A removal change hides an earlier
grant without rewriting or relabeling the caller's data.

Expose the change registry as an optional input and as an output. A parent can
therefore preserve it across pattern composition, while a standalone piece
gets a stable per-space fallback. Keep the ordinary action that existed before
the strict rollout. It writes the same protected field, so observe mode can
still demonstrate the rollback posture and strict mode can reject it.

## 3. Carry both parking endorsements through a grant

An administrator grant authorizes two different operations. The manager
endorsement authorizes changes to the administrator policy. The parking
administrator endorsement authorizes protected parking-spot edits. Wrapping an
existing role in a second `AddIntegrity` left only the outer endorsement in the
compiled policy.

Define each trusted change with both endorsements in one integrity declaration.
Return the stored change object directly when resolving the active role. Do not
rebuild the active role array with filters and spreads, because that separates
the policy-bearing object from the protected operation. Route every protected
spot action through the role resolver that reads both the legacy registry and
the trusted change registry.

## 4. Keep person mutations off protected administrator state

Editing or removing a person previously rewrote the administrator list as part
of the same transaction. Under strict enforcement those streams do not own the
trusted administrator-write identity, so the list write rejects the entire
transaction.

Require a person to lose administrator status through the trusted toggle before
the person can be edited or removed. Enforce that rule in both the exposed
actions and the internal UI-opening actions. Disable the matching UI controls
for an administrator. Remove the administrator-list rewrites from the person
edit and removal transactions. This leaves each stream responsible only for
the state its policy authorizes.

## 5. Exercise administrator grant and rollback in the browser

Extend the focused parking administrator integration test past the initial
grant. Enable administrator mode to prove that the granted role is active.
Then invoke the same trusted surface in the other direction. Assert that the
person returns to member status and that the control again offers to grant
administrator status. This covers the strict trusted-write path while
preserving the option to reverse the policy change.
