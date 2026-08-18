---
status: historical
created: 2026-08-16
archived: 2026-08-16
reason: "Executed Lot Watch trusted administrator mutation change."
---

# Lot Watch trusted administrator mutation

This work order records the remaining Lot Watch change required by strict CFC
enforcement. The numbered section is one commit. It follows the earlier rollout
and repair work orders without changing the two leading boundaries: the first
commit contains only switch changes, and the second contains only tests that
directly inspect those switches.

## 1. Route administrator changes through a trusted UI action

The admin registry requires role integrity and manager integrity, but Lot Watch
mutated that registry from ordinary actions. The old casts changed only the
TypeScript view of the values. Strict enforcement correctly refused the writes
because the transaction carried no trusted writer and UI labels.

Define one module-scope administrator handler and bind its writes to a named
trusted action and surface. Append its decisions to a protected per-space
change log, preserving the original registry as imported state. Resolve each
person's effective role from the latest trusted change, then fall back to the
stored registry. Use the handler for explicit admin toggles and for both
directions of the curator button. Label the screen and buttons so real UI
events carry the required provenance.

Keep the existing untrusted toggle stream for compatibility. Add a trusted
toggle stream for callers that can supply the trusted UI gesture. Update the
positive pattern tests to use that stream with explicit trusted surface and
action metadata. Negative tests continue to prove that ordinary curation
attempts do not bypass the admin gate.
