# Multi-Push Action Timeout Bug

## Summary

Pushing 2+ sub-pattern instances into a `Writable<T[]>` within a single
`action()` causes the action to timeout (5000ms+). Pushing a single instance
works fine.

## Reproduction

```typescript
// This works:
const action_add_one = action(() => {
  const note = Note({ title: "A", content: "", noteId: generateId() });
  allPieces.push(note);
});

// This times out:
const action_add_two = action(() => {
  const note = Note({ title: "A", content: "", noteId: generateId() });
  allPieces.push(note);

  const nb = Notebook({ title: "B", notes: [] });
  allPieces.push(nb);
});

// Also times out (two Notes, no Notebooks):
const action_add_two_notes = action(() => {
  const n1 = Note({ title: "A", content: "", noteId: generateId() });
  allPieces.push(n1);

  const n2 = Note({ title: "B", content: "", noteId: generateId() });
  allPieces.push(n2);
});

// Also times out (batch set instead of push):
const action_set_both = action(() => {
  const note = Note({ title: "A", content: "", noteId: generateId() });
  const nb = Notebook({ title: "B", notes: [] });
  allPieces.set([...allPieces.get(), note, nb]);
});
```

The timeout is NOT caused by:
- `Note()` or `Notebook()` instantiation alone (these return immediately)
- Single `.push()` calls
- Single `.set()` calls adding one item
- The specific combination of Note + Notebook (two Notes also fail)

## Test Reproduction

On branch `patterns/notes-modernization-v2`:
```bash
deno task ct test packages/patterns/gideon-tests/multi-push-repro.test.tsx --verbose --timeout 60000 --root packages/patterns
# Also reproduces via notebook.test.tsx with bulk createNotes test uncommented:
deno task ct test packages/patterns/notes/notebook.test.tsx --verbose --timeout 30000
```

## Behavior

- The action starts executing and state changes before the push(es) succeed
  (e.g., `detectedDuplicates.set([])`, `showDuplicateModal.set(false)` complete)
- `allPieces` DOES grow (items are added)
- The items DO have correct `[NAME]` values (e.g., starting with "📝")
- But the action times out at 5000ms
- Computed values that depend on `allPieces` may not re-evaluate

## Root Cause (Investigated)

This is NOT an infinite loop or unbounded cycle. With `--timeout 30000`, the
action completes successfully. The issue is **stale commit promise resolution
blocking the event loop**.

### The Mechanism

1. **Pattern setup** creates ~68 reactive actions (computations + effects).
   Each action calls `tx.commit()` which returns a promise. The commit happens
   asynchronously, and `commitPromise.then(...)` callbacks queue up.

2. **During action execution**, the scheduler's `execute()` runs 49-79 actions
   across 3 settle iterations. Each `await this.run(fn)` creates a new
   transaction and commits it. The commit promise callbacks include
   `resubscribe()` which sets up reactive dependency tracking.

3. **After `execute()` resolves idle promises**, the event loop processes the
   queued `commitPromise.then()` callbacks. There are 60-80 of them, each
   running `resubscribe()` work. This blocks the event loop for **6-10 seconds**.

4. **The idle promise resolution** was called inside `execute()`, but the
   `.then()` callback on the idle promise can't run until the commit callbacks
   finish, because they're all in the same microtask/macrotask queue.

### Timeline (from instrumentation)

For `createNotes` (push 2 Notes via Notebook handler):

| Event | Time | Notes |
|-------|------|-------|
| `.send()` | 0ms | Instant, queues the event |
| exec #4 | ~2ms | Empty exec, re-queues |
| exec #5 starts | ~2ms | pending=0 at start |
| exec #5 settle[0] | | 49 actions |
| exec #5 settle[1] | | 22 actions |
| exec #5 settle[2] | | 8 actions |
| exec #5 DONE | 2275ms | Resolves idle promises |
| commit callbacks | 2275-8700ms | ~60 stale commits run resubscribe() |
| idle() resolved | 8715ms | Promise callback finally runs |

The **6.4 second gap** between exec #5 finishing and idle() callback running
is entirely commit promise callbacks blocking the event loop.

### Key Insight

The commit callbacks are not just from the current action — they include
**stale callbacks from initial pattern setup** (exec #1, which ran 68 actions).
These setup commits were queued 10+ seconds ago but their `.then()` callbacks
hadn't run yet because the event loop was busy with test steps.

## Workaround

Add items in separate actions (one push per action):

```typescript
// Works: separate actions for each item
{ action: action_add_note },    // pushes one Note
{ action: action_add_notebook }, // pushes one Notebook
```

## Potential Fixes

1. **Await commit promises in the settle loop** — instead of fire-and-forget
   `tx.commit()`, await the commit before proceeding to the next action. This
   would serialize commit processing but prevent callback accumulation.

2. **Batch commits** — accumulate writes across multiple actions in the same
   settle iteration and commit once at the end.

3. **Lightweight resubscribe in commit callbacks** — the resubscribe work in
   commit callbacks may be doing more than necessary. Profile what
   `resubscribe()` actually does and optimize.

4. **Use queueMicrotask for idle resolution** — ensure idle promise resolution
   runs before commit callbacks, so callers don't wait for unrelated work.

## Impact

This blocks batch import operations in `notes-import-export.tsx`. The
`performImport` function creates multiple Notes and Notebooks then calls
`allPieces.set([...allPieces.get(), ...newItems])`. This works fine when
importing 1 item, but times out when importing 2+.

Tests 6 & 7 in `notes-import-export.test.tsx` fail because of this —
the `importSkipDuplicates` and `importAllAsCopies` actions both call
`performImport` which does a batch set.

## Files

- `packages/runner/src/scheduler.ts` — `execute()` settle loop, `run()` commit handling
- `packages/runner/src/scheduler.ts:716` — fire-and-forget `tx.commit()`
- `packages/runner/src/scheduler.ts:718-744` — commit `.then()` with resubscribe
- `packages/runner/src/scheduler.ts:795-810` — `idle()` promise resolution

## Context

- Discovered while testing `packages/patterns/notes/notes-import-export.tsx`
- Branch: `patterns/notes-modernization-v2`
- Related: `docs/development/debugging/reactive-proxy-length-bug.md` (separate bug)
