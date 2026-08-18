---
status: historical
created: 2026-08-16
archived: 2026-08-16
reason: "Executed review correction for CFC conflict selector repair."
---

# CFC conflict selector repair review correction

This work order records the remaining change required by adversarial review of
the strict CFC conflict selector repair. Each numbered section is one commit.
It follows the earlier rollout and repair work orders without changing the two
leading boundaries: the first commit contains only switch changes, and the
second contains only tests that directly inspect those switches.

## 1. Notify read-only conflict repairs

A conflict can carry confirmed reads without carrying a semantic document
operation. Such a transaction has no optimistic document write to remove and
therefore produces no revert notification. Do not mark its documents for
notification suppression. Refresh its exact conflicting selectors as an
ordinary pull so subscribers observe the repaired confirmed state.

Continue to use silent selector repair for conflicts with semantic operations.
Those conflicts remove an optimistic layer and publish the coherent repaired
state through their revert notification.
