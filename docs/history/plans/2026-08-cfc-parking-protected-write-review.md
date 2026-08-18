---
status: historical
created: 2026-08-16
archived: 2026-08-16
reason: "Executed protected-write review correction for the strict CFC rollout."
---

# CFC parking protected-write review correction

This work order records the remaining change required by the adversarial
review of the strict CFC default rollout. Each numbered section is one commit.
It follows the original rollout and its earlier review corrections without
changing the two leading boundaries: the first commit contains only switch
changes, and the second contains only tests that directly inspect those
switches.

## 1. Preserve parking grants through protected spot writes

Export the parking coordinator through a named pattern binding so a focused
pattern test can address imported streams directly. Expose the trusted
administrator toggle stream alongside the rollback-compatible legacy stream.

Grant administrator access with the same trusted event metadata supplied by
the renderer. Send a spot addition through the imported result stream, then
assert that the shared protected spot cell changed under strict enforcement.
Keep the browser grant-and-revocation scenario focused on the stored
endorsements and rollback behavior.
