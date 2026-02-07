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

## Behavior

- The action starts executing and state changes before the push(es) succeed
  (e.g., `detectedDuplicates.set([])`, `showDuplicateModal.set(false)` complete)
- `allPieces` DOES grow (items are added)
- The items DO have correct `[NAME]` values (e.g., starting with "📝")
- But the action times out at 5000ms
- Computed values that depend on `allPieces` may not re-evaluate

## Likely Cause

Each sub-pattern instance (Note, Notebook) internally calls
`wish("#default")` which gives them a reference to `allPieces`. When the
instance is pushed INTO `allPieces`, the reactive system detects a change to
the cell the new instance is subscribed to, triggering re-evaluation. With 2+
instances, this likely creates a cascade or cycle that doesn't settle within
the action timeout.

## Workaround

Add items in separate actions (one push per action):

```typescript
// Works: separate actions for each item
{ action: action_add_note },    // pushes one Note
{ action: action_add_notebook }, // pushes one Notebook
```

## Impact

This blocks batch import operations in `notes-import-export.tsx`. The
`performImport` function creates multiple Notes and Notebooks then calls
`allPieces.set([...allPieces.get(), ...newItems])`. This works fine when
importing 1 item, but times out when importing 2+.

Tests 6 & 7 in `notes-import-export.test.tsx` fail because of this —
the `importSkipDuplicates` and `importAllAsCopies` actions both call
`performImport` which does a batch set.

## Files to Investigate

- `packages/runner/src/scheduler.ts` — reactive scheduling and cycle detection
- `packages/runner/src/reactivity.ts` — reactive dependency tracking
- `packages/runner/src/builtins/wish.ts` — wish resolution and subscriptions

## Context

- Discovered while testing `packages/patterns/notes/notes-import-export.tsx`
- Branch: `patterns/notes-modernization-v2`
- Related: `docs/development/debugging/reactive-proxy-length-bug.md` (separate bug)
