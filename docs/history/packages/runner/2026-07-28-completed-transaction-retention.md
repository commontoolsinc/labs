---
status: historical
created: 2026-07-28
archived: 2026-07-28
reason: "Investigation record: a completed transaction's activity was retained, and what still grows after fixing it."
---

# Completed transactions kept the activity of everything they read

This continues
[the list-window child retention record](2026-07-28-list-window-child-retention.md),
which fixed the first of the retentions behind
[the session-paging heap exhaustion](../patterns/agent-sessions-debug/2026-07-27-session-paging-out-of-memory.md)
and listed a smaller one still to find. This is that one, plus the cause that
still exhausts a browser tab after both are fixed. It is a record of one
investigation, not a description of the current system.

## Finding it

The first fix took the per-page-change growth from 10.9 MB to 2.3 MB. What was
left had an unhelpful shape: it needed an element pattern that instantiates a
nested pattern, it did not scale with row size, it needed the window to move,
and no container in the scheduler, runner or storage layer grew.

Two instruments settled it. A census that tagged every transaction with a
serial and held a weak reference to it showed a single transaction surviving
each page change, sourced from the list coordinator's action — but a weak
reference is kept alive for the rest of the job that dereferences it, and a
heap snapshot renders those references as edges, so both the count and the
snapshot flattered the truth until the census was cleared before snapshotting.
An ephemeron-correct retainer walk over the snapshot — one that follows a
WeakMap value only once its key is reachable — then gave the shape: a
transaction reached through a chain of cells and per-reconcile records, each
link holding the transaction that created it.

The decisive measurement was to release a transaction's state once it
completed and re-run the harness. Growth fell from 2.3 MB to 0.25 MB per page
change immediately, which put the bytes in the transaction rather than in
whatever held it.

## The cause

A transaction accumulates what an open transaction needs: materialized
branches, the address of every read and attempted write, and a cached
reactivity log. All of it is consumed before the result is known. It was kept
afterwards, so anything still holding a completed transaction also held every
address that transaction had touched — and plenty holds one. A cell carries
the transaction it was created with for its whole life. A run's cleanup
closures capture the transaction they were registered in. The list builtin's
commit guard keys its per-reconcile record off one. Each of those holders is
bounded on its own; each pinned a whole transaction's activity, and the
transaction that projects a window over a list has read every element in it.

Completing a transaction now releases that state and keeps only the result.
The regression test states it directly: a completed transaction reports no
reads and no writes, whether it committed or failed.

## What still exhausts the tab

With both fixes, paging back and forth over the same rows settles: in a
browser with 716 published sessions the tab levelled off at 4.1 GB instead of
dying. Paging forward through all 36 pages still dies, at about page 20, and
the cause is different from either retention above.

The client watches and caches every document it has pulled or created, and
releases neither. Instrumenting the storage provider during a forward walk:

```
docs=5276 watched=5276
docs=5777 watched=5777
docs=6278 watched=5777
```

Five hundred documents per page change, about twenty-five per newly visited
row. Their shapes name them: the row projection's own state — vnodes, streams,
element input documents and strings — created because each row instantiates a
nested pattern for its raw-data link. On top of that, the first render alone
pulls all 716 session manifests and all 716 session rows, which is what the
pattern's README says it avoids.

`#watchedIds` in the storage provider shrinks only when the server reports a
document removed. There is no path that drops a subscription, or the cached
document behind it, when the run that wanted it stops. So the working set is
the union of everything the session ever touched, and a table with enough rows
walks that union past the heap limit.

Fixing it means bounding that working set: releasing a document's subscription
and cached value once no live run reads it, and separately not creating
twenty-five persistent documents per row merely to render a link. Neither is a
small change, and neither was attempted here.
