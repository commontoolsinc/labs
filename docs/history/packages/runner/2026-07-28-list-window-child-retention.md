---
status: historical
created: 2026-07-28
archived: 2026-07-28
reason: "Investigation record: why a moving list window retained memory, and what the fix covered."
---

# A moving list window retained every child run it ever started

This records the root cause behind
[the session-paging heap exhaustion](../patterns/agent-sessions-debug/2026-07-27-session-paging-out-of-memory.md),
the fix that landed, and the growth that remains. It is a record of one
investigation, not a description of the current system.

## How it was found

The browser reproduction was too coarse to bisect, so the first step was a
headless harness: publish synthetic sessions into an emulated storage manager,
deploy the real debug pattern through the same code path the host uses, drive
its pager by sending events to the rendered button, and report
`Deno.memoryUsage().heapUsed` after a forced collection. That reproduced the
growth at 10.9 MB per page change, in a process where a heap snapshot could be
taken. That harness drives the debug pattern, so it lives with the
agent-sessions work rather than in this tree;
`packages/runner/test/window-retention-probe.ts` is the reduced form of it,
which moves a window over a list through several projection shapes.

Two snapshots, eight page changes apart, were compared by strongly-reachable
population. The classes that grew were the closures a storage transaction
installs — one set per `Runtime.edit()` — which said transactions were being
retained. Tracing retainer paths, with weak edges and WeakMap ephemeron entries
excluded, gave the same chain for every sampled transaction:

```
NodeRegistry.all → a live parent node → children (Set<Action>)
  → a child action → action.lastFrame → frame.tx → the transaction's journal
```

## The cause

`NodeRegistry.remove` cleared the removed action from the active-effect,
active-computation and invalid sets, but not from its parent's child index.
That index holds actions strongly. An action holds `lastFrame`, the frame of
its last run; a frame holds that run's storage transaction; a transaction holds
the values it read. So a child that left the index only when its parent was
dropped kept a transaction and its journal alive for the parent's whole life —
and a list coordinator lives as long as the piece.

The session table projects a window of the current page and the pages on either
side, and each projected row instantiates a nested pattern. Every page change
therefore stopped twenty child runs and started twenty more, and each one left
a retained transaction behind. The scheduler's own accounting looked healthy
throughout, which is why the browser measurements had ruled so much out: the
live node count returned to exactly the same value each time a page came back,
because the nodes really were unregistered. Only the index kept the actions.

## The fix

`NodeRegistry.remove` now also drops the action from its parent's index. The
record keeps its `parentAction`, so the parent stays known across a
re-registration window, and re-subscribing re-enters the index through
`linkParent`. The index has a single consumer, the scheduler graph snapshot,
which now shows only children that are still registered.

The regression test, `packages/runner/test/scheduler-child-lifetime.test.ts`,
asserts the lifecycle rather than a memory figure: the registry drops an
unsubscribed child, a child subscribed during a parent's run is dropped when it
unsubscribes, and a sliding window over a list whose elements run a child
pattern returns to the same retained-child count each time the window returns
to a position it has already visited. Before the fix that last case gained
twenty retained children per move.

## What remains

Retained growth in the headless harness fell from 10.9 MB to 2.3 MB per page
change. The remainder is a distinct defect that was characterised but not
found:

- It appears whenever an element pattern instantiates a nested pattern, and
  disappears when the projection stops doing so. It does not depend on what
  that nested pattern contains: a version whose body returns constants leaks
  the same amount.
- It does not scale with row size. Padding each session with 100 KB leaves the
  per-change figure unchanged, so it tracks the number of element runs.
- It is specific to the window moving. Clicking the table's sort header forty
  times, which re-renders the same rows without starting or stopping any
  element run, is flat.
- Roughly twenty-three storage transactions become newly reachable per page
  change, along with the journals they hold, which is where the bytes are.
- No named container accounts for it. The scheduler's observation-identity
  index, trigger index and node registry, the runner's cancel map, cancel
  groups, prepared and stopped result maps, and the storage provider's document
  cache and per-document pending and materialized caches are all flat across
  page changes.

With real session data this remainder still exhausts the browser tab, so the
reported crash is not resolved by the fix above. Reproducing it needs only a
list with a moving window whose elements instantiate any nested pattern, which
the probe and the regression harness both already set up.
