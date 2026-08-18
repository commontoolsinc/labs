---
status: historical
created: 2026-08-16
archived: 2026-08-16
reason: "Executed conflict-repair correction for the strict CFC rollout."
---

# CFC conflict selector repair

This work order records the change required after strict flow-label persistence
exposed a conflict-recovery gap in a two-client shared pattern. Each numbered
section is one commit. It follows the earlier rollout and review corrections
without changing the two leading boundaries: the first commit contains only
switch changes, and the second contains only tests that directly inspect those
switches.

## 1. Refresh every conflicting selector before retrying

A watch subscription can cover the value that drives a computation without
covering the sibling CFC metadata that its transaction reads for enforcement.
The provider's conflict catch-up then advances the subscribed value and the
local sequence marker, but leaves the CFC read at its stale confirmed sequence.
The retry repeats the same conflict.

After the provider reaches its catch-up marker, remove the rejected optimistic
layer and reject transactions that depended on it. Add the exact selectors from
the conflicting document's confirmed and pending read sets to the watch. Apply
that refresh without an intermediate notification while the rejection is being
assembled. Include the conflicting reads in the rejection snapshot so the one
revert notification reports the repaired confirmed state as well as the removed
optimistic writes.

Hold ordinary catch-up notifications for documents that currently have a
rejected layer under repair. Publish changes for unrelated documents in the
same sync normally. Keep refresh batches with different notification behavior
separate so a conflict repair cannot hide an unrelated pull notification that
happened to enter the queue in the same turn.

The existing two-browser lunch-poll vote scenario is the regression test. With
strict CFC persistence, both clients write scoped rendered output while voting
on the same shared option. The scenario must converge with both votes retained
instead of repeatedly retrying a transaction whose CFC selector stayed stale.
