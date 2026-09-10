---
status: historical
created: 2026-08-04
archived: 2026-08-04
reason: "Investigation of what a settled storage transaction keeps reachable, and which of those retention paths are observable without per-element list child release."
---

# What a settled transaction keeps alive, August 2026

## Why this was looked at

Paging forward through a long list grew the heap by megabytes per page until
the browser tab died, and kept doing so after the July work — dropping
unsubscribed children from the scheduler's child index (#5136) and bounding
the runtime caches that grow with everything a session touches (#5200). The
remaining growth was linear in pages visited and never came back.

## Method

A probe reproduced the shape headlessly: an index document whose rows live in
their own linked documents, a computed window over the row list,
`mapWithPattern` projecting each windowed row through a pattern that
instantiates a nested pattern, and a window stepping forward one page per
move. V8 heap snapshots taken at two points in the walk were diffed by
constructor and walked for retainer paths, with weak and ephemeron pair edges
excluded so the paths shown are genuine strong retention.

## What was found

Every retainer path for the growing object populations ran through a settled
storage transaction. Three distinct things keep such a transaction reachable,
or keep it expensive once reachable:

1. **A settled transaction kept its commit callbacks.**
   `ExtendedStorageTransaction.commitCallbacks` dispatches exactly once and
   was never cleared afterwards. Callbacks are closures over whatever
   registered them — a result cell, a child registry, an action's captured
   frame — so any reference to a settled transaction kept all of that
   reachable. There are fourteen registration sites across the runner, so
   this is a general retention path rather than a list-specific one.

2. **Cells stored in long-lived registries stayed bound to their creating
   transaction.** `CellImpl` holds its creating transaction for its lifetime.
   The list builtins store their result container and every per-element
   result cell — in `elementRuns` and in the per-element `addCancel` closure,
   both of which live as long as the coordinator — still bound to the
   reconcile transaction that created them. Each such cell therefore pins a
   settled transaction and its journal, which holds the values of every read
   that transaction made.

3. **Every live action pins its most recent run's transaction.** This is
   scheduler-level retention and is bounded by the number of live actions,
   but the constant is large: a thirty-element window held roughly ninety
   live per-child actions.

## What this change does, and what it does not

This change fixes (1) and (2): the callback set is cleared after its single
dispatch, and the list builtins store their container and per-element result
cells detached from the creating transaction, rebinding per use. The
transaction-bound sibling is still used for the writes that must ride the
reconcile transaction (`setResultCell`, `setPatternCell`, `sendResult`).

Only (1) is observable today, and only (1) has a test.
`commit-callback-release.test.ts` registers a callback closing over a
sentinel, commits, and requires the sentinel to be collectable while the
settled transaction is still referenced. Before the fix the sentinel
survived; after it, it does not.

Fix (2) is correct on its own terms — a registry that lives for the
coordinator's lifetime should not pin a settled transaction — but it changes
no measurement on the current list builtins, and the probe confirms that in
both directions. The reason is (3) combined with what the builtins do with
children: `map`, `filter`, and `flatMap` never release an *individual*
element run when its element leaves the list. They keep every element run for
reuse, releasing them only all at once when the input list becomes undefined.
So no child is ever left behind, every child stays live, and each live
child's action pins its own transaction regardless of whether the stored cell
also does. Detaching the cell removes one of two redundant pins.

Fix (2) becomes load-bearing once the list builtins release element runs
individually, which is what makes a projection window that slides over a long
list stop retaining the pages it has left. With per-element release in place
and both fixes applied, a five-move walk of a sliding three-page window
leaves zero transactions from departed moves reachable; with per-element
release but without these fixes, two survive, and each drags its journal and
the element registries of the reconcile it carried.

## What remains after all of this

Even with per-element release and both fixes, the same walk still grows
in-process, because of retention that is architecture rather than a broken
release path:

- **The client replica retains every document it has ever seen.**
  `SpaceReplica.#docs` only grows during a session; it is cleared on close.
  Paging in a page of rows permanently adds those row documents, values
  included, to the client heap. Nothing signals lost interest — reads take no
  per-document pin, so there is nothing to count down to zero and evict on.
- **The watch set never narrows.** `SelectorTracker` accumulates every
  (document, selector) pair ever pulled, so the server keeps streaming
  updates for rows the window has left behind.

Bounding the client under paging needs an interest signal the storage layer
does not have today — per-document pins derived from the scheduler's
dependency graph and cell sinks, an unwatch in the client/server watch
protocol, and eviction of clean unpinned records — or a list runner that can
retain inactive element results cheaply instead of keeping whole projected
pages active.

## Reproduction assets

- `packages/runner/test/window-retention-probe.ts` — the heap-growth probe
  (shapes `inline`, `child`, `cells`, `opaque`, `index`; toggle and walk
  movement). `index walk` is the paging shape.
- `packages/runner/test/commit-callback-release-helper.ts` and
  `commit-callback-release.test.ts` — the callback-release property, in CI.
