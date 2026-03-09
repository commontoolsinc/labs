# Bug Report: Same-Length Array Mutation via `.set()` Not Detected After `.push()`

## Summary

When a pattern calls `.push()` on a Writable array and later calls `.set(arr.toSpliced(...))` on the **same** Writable (replacing an element without changing array length), the change is not detected by the reactive system. This causes `runtime.idle()` to resolve immediately (before the mutation propagates), and downstream computeds/UI never update.

The issue affects both the test harness (assertions fail) and potentially the runtime (UI may not re-render).

## Severity

**Medium-High** — Affects any pattern that mixes `.push()` and same-length `.set()` on the same Writable array, which is a common pattern for CRUD operations (add items with `.push()`, edit items in-place with `.set(toSpliced())`).

## Reproduction

### Minimal repro pattern

```typescript
/// <cts-enable />
import { handler, NAME } from "@commontools/common-builder";

type Item = { id: string; label: string };

export default handler<{ items: Item[] }, { items: Item[] }>(({ items }) => {
  // Action 1: Push a new item
  const addItem = handler(() => {
    items.push({ id: "a", label: "original" });
  });

  // Action 2: Edit the item in-place (same-length mutation)
  const editItem = handler(() => {
    const current = items.get();
    const idx = current.findIndex((i: Item) => i.id === "a");
    if (idx >= 0) {
      items.set(
        current.toSpliced(idx, 1, { ...current[idx], label: "edited" })
      );
    }
  });

  return { items, addItem, editItem, [NAME]: "repro" };
});
```

### Minimal repro test

```typescript
/// <cts-enable />
import { handler, computed, action } from "@commontools/common-builder";
import subject from "./main.tsx";

type Item = { id: string; label: string };

export default handler<{}, { tests: any[] }>(() => {
  const result = subject({ items: [] });

  // Step 1: Push an item
  const pushItem = action(() => {
    result.addItem.send(undefined);
  });

  // Step 2: Edit the item (same-length .set(toSpliced()))
  const editItem = action(() => {
    result.editItem.send(undefined);
  });

  // Assertions
  const hasItem = computed(() => {
    const items = result.items;
    return Array.isArray(items) && items.length === 1;
  });

  const itemIsEdited = computed(() => {
    const items = result.items;
    return Array.isArray(items) && items.length === 1 && items[0]?.label === "edited";
  });

  return {
    tests: [
      { action: pushItem },
      { assertion: hasItem },         // PASS — .push() changes length, detected
      { action: editItem },
      { assertion: itemIsEdited },    // FAIL — .set(toSpliced()) same length, NOT detected
    ],
  };
});
```

### Expected behavior

After `editItem` action, `itemIsEdited` assertion should return `true` — the item's label should be "edited".

### Actual behavior

`itemIsEdited` returns `false` — still reads the old value "original". The mutation was written to storage but never triggered reactive propagation.

## Root Cause Analysis

The issue spans two layers of the system:

### Layer 1: `normalizeAndDiff()` in `data-updating.ts`

When `.set()` is called on a Writable, it goes through:

1. `cell.set(newValue)` → `recursivelyAddIDIfNeeded(newValue)` → `diffAndUpdate()`
2. `diffAndUpdate()` calls `normalizeAndDiff()` which produces a `ChangeSet`
3. `applyChangeSet()` writes the changes

For arrays, `normalizeAndDiff()` (lines 454-514) iterates element-by-element:

```typescript
// data-updating.ts, lines 472-491
for (let i = 0; i < newValue.length; i++) {
  const nestedChanges = normalizeAndDiff(
    runtime, tx, { ...link, path: [...link.path, i.toString()] },
    newValue[i], context, options, seen, currentArray?.[i],
  );
  changes.push(...nestedChanges);
}
// Lines 493-511: Length change detection
if (Array.isArray(currentValue) && currentValue.length != newValue.length) {
  changes.push({ location: { ...link, path: [...link.path, "length"] }, value: newValue.length });
}
```

**Key observation**: Same-length mutations don't produce a `length` change. The only way changes are detected is through the recursive element-by-element comparison. If that comparison fails to detect the change, the `ChangeSet` is empty and nothing propagates.

### Layer 2: How `.push()` vs `.set()` handle object identity

**`.push()` path** (cell.ts, lines 792-850):

```typescript
// cell.ts, line 847
diffAndUpdate(runtime, this.tx, resolvedLink,
  recursivelyAddIDIfNeeded([...array, ...value], this._frame), cause);
```

`.push()` creates a **new array** `[...array, ...value]` and passes it through `recursivelyAddIDIfNeeded()`. This function (cell.ts, lines 1673-1750) **adds `[ID]` symbols to objects in arrays** that don't already have them:

```typescript
// cell.ts, lines 1721-1725
if (isObject(value) && !isCellLink(value) && !(ID in value)) {
  return { [ID]: frame.generatedIdCounter++, ...value };
}
```

The `[ID]` symbol triggers the "ID-based object" branch in `normalizeAndDiff()` (lines 380-438), which converts the object into a **separate document** linked by a cell reference.

**`.set()` path** (cell.ts, lines 698-708):

```typescript
const transformedValue = recursivelyAddIDIfNeeded(newValue, this._frame);
diffAndUpdate(runtime, this.tx, resolveLink(...), transformedValue, ...);
```

`.set()` also calls `recursivelyAddIDIfNeeded()`. But here's the problem: when the pattern does `current.toSpliced(idx, 1, { ...current[idx], label: "edited" })`:

1. `current[idx]` returns a **proxy/cell reference** (not a plain object) because the item was originally stored as a separate document via `.push()`
2. Spreading it with `{ ...current[idx], label: "edited" }` creates a **new plain object** that loses the cell link identity
3. `recursivelyAddIDIfNeeded()` sees a new object without `[ID]` and assigns a **new** `[ID]`
4. In `normalizeAndDiff()`, this new object with new `[ID]` goes through the ID-based object path and creates a **new document** with a new ref
5. The diff at the array element position compares the **old cell link** (pointing to the old document) with the **new cell link** (pointing to the new document)

**The critical question**: Does this comparison detect a change? The answer depends on whether `areLinksSame()` or the primitive comparison at line 605 catches it.

If the diff engine determines the old and new cell links are "the same" (e.g., because `ID_FIELD` matching in lines 155-211 finds the original document via the `id` field and reuses it), then:
- The changes are written to the **existing** document
- But the **link at the array position doesn't change** (it still points to the same document)
- The `ChangeSet` may end up **empty at the array level** even though the document contents changed
- With no length change and no element-level changes, **nothing triggers the scheduler**

### Layer 3: Test harness `idle()` (test-runner.ts, lines 252-260)

```typescript
await Promise.race([
  runtime.idle(),
  timeout(TIMEOUT, `Action at index ${i} timed out...`),
]);
```

And in the scheduler (scheduler.ts, lines 802-817):

```typescript
idle(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (this.runningPromise) {
      this.runningPromise.then(() => this.idle().then(resolve));
    } else if (!this.scheduled) {
      resolve();  // Nothing scheduled = immediately idle
    } else {
      this.idlePromises.push(resolve);
    }
  });
}
```

If `normalizeAndDiff()` produces zero changes, no work is scheduled, and `idle()` resolves immediately. The assertion then reads the old (pre-mutation) value.

## Why Other Mutation Patterns Work

| Pattern | Works? | Why |
|---------|--------|-----|
| `.push(newItem)` | YES | Length change always detected (line 494) |
| `.set(arr.filter(...))` | YES | Length changes (shorter array) |
| `.set(arr.map(...))` | DEPENDS | Same length, but objects may have stable [ID] from prior .push() |
| `.set(arr.toSpliced(idx, 1, newObj))` | NO (after .push()) | Same length, new object identity conflicts with existing document |
| `.set(entirelyNewArray)` | YES | All new objects get new IDs, all links differ |

## Evidence from Real Patterns

### parking-coordinator (this run)

The `editSpotAction` uses `spots.set(currentSpots.toSpliced(idx, 1, { ...currentSpots[idx], label, notes }))` after spots were added via `.push()`. Test assertions for edited label/notes consistently fail (3-5 of 64 assertions).

### Exemplar patterns

- **budget-tracker**: Tests `editCategory` BEFORE adding transactions (no prior `.push()` on the same array), so the issue doesn't manifest
- **kanban-board**: Mixes `.push()` and `.set(toSpliced())` on DIFFERENT arrays, avoiding the issue

## Suggested Fixes

### Option A: Fix `normalizeAndDiff()` for same-length array mutations

Ensure that when an array element's document contents change, the change is propagated even if the link at the array position remains the same. This could mean:
- Always emitting a change for array elements where the recursive diff found document-level changes
- Or treating "same link, different content" as a change at the array level

### Option B: Fix `recursivelyAddIDIfNeeded()` to preserve existing document identity

When `.set()` is called with an array containing spread-from-proxy objects, detect that the object came from an existing document and preserve its `[ID]` / cell reference rather than creating a new one. This would make the diff see "same document, contents changed" and propagate correctly.

### Option C: Make `idle()` more robust

Rather than just checking `!this.scheduled`, `idle()` could also verify that all pending transaction writes have been applied and their effects propagated. This is more of a test harness fix and wouldn't address the underlying reactivity gap.

### Option D: Pattern-level workaround (current)

Patterns can avoid mixing `.push()` and `.set(toSpliced())` on the same array by:
- Using `.set([...arr, newItem])` instead of `.push(newItem)` — but this may have its own issues
- Using a different update strategy (e.g., writing to the individual document rather than replacing the array element)
- In tests: adding "warmup" no-op assertions to give the system propagation time (unreliable)

## Files Referenced

- `packages/runner/src/cell.ts` — `.set()` (line 698), `.push()` (line 792), `recursivelyAddIDIfNeeded()` (line 1673)
- `packages/runner/src/data-updating.ts` — `normalizeAndDiff()` (line 113), array handling (line 454), length check (line 494)
- `packages/runner/src/scheduler.ts` — `idle()` (line 802)
- `packages/cli/lib/test-runner.ts` — action handling (line 250), idle wait (line 254)
