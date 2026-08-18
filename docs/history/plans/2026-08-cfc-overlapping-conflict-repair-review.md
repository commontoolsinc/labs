---
status: historical
created: 2026-08-16
archived: 2026-08-16
reason: "Executed overlapping conflict repair review correction."
---

# Overlapping CFC conflict repair review correction

This work order records one further change required by adversarial review of
the strict CFC conflict selector repair. The numbered section is one commit.
It follows the earlier rollout and repair work orders without changing the two
leading boundaries: the first commit contains only switch changes, and the
second contains only tests that directly inspect those switches.

## 1. Coalesce overlapping rejection repairs

Two rejected optimistic writes can overlap the same document while their read
repairs wait on different catch-up points. Removing either failed layer can
expose the other failed layer. Do not notify subscribers or sinks about that
intermediate state.

Count active repairs per document. Each completed repair releases its claim.
Publish a document's repaired transition only from the repair that releases
the final claim. Preserve independent notifications for non-overlapping
documents in the same rejected transaction.

Cover the ordering with two independently released conflicts over one
document. The upper failed layer is removed first, and the test verifies that
the remaining failed layer is not announced. The final repair publishes one
transition from the last observable optimistic value to confirmed state.
