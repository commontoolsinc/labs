# Drag-and-Drop Multi-Tab Data Corruption Fix

## Status: Deferred

This document captures learnings and a plan for fixing data corruption that occurs when dragging modules with multiple browser tabs open.

---

## Feature Overview: How Drag-and-Drop Should Work

### User Experience

1. **Drag handle**: Each module has a ⋮⋮ drag handle on the left side
2. **Reorder within column**: Drag modules up/down to reorder them
3. **Pin/unpin via drag**: Drag a module from unpinned area to pinned sidebar (or vice versa)
4. **Drop zones**: Invisible 8px gaps between modules act as drop targets
5. **Last drop zone**: Bottom of the unpinned column should be a large drop target (flex: 1) for easy "drop at end"

### Current Implementation

- Uses `<ct-drag-source>` wrapper around each module card
- Uses `<ct-drop-zone>` between each module and at start/end of columns
- `insertAtPosition` handler receives the dragged item and insertion position
- Handler updates `subCharms` array with new order and pinned state

### Layout Modes

- **Rail layout** (has pinned items): Two-column layout with pinned sidebar + unpinned main area
- **Grid layout** (no pinned items): Single grid of modules with drop zones between

---

## CRITICAL WARNING: Two-Tab Conflict Danger

**This is the main issue that needs careful handling.**

The framework's sync mechanism creates a **race condition** when two browser tabs are open to the same charm:

```
Tab A: User drags module    →  subCharms.set([...reordered])  →  Write to server
Tab B: (idle, but syncing)  →  Receives update                →  May write back stale data
                                    ↓
                            CONFLICT DETECTED
                                    ↓
                            Retry with merged data
                                    ↓
                            PARTIAL DATA LOSS (type property missing!)
```

### Why Properties Get Lost

The framework's `diffAndUpdate` writes object properties individually, not atomically:

```typescript
// Under the hood, this becomes multiple writes:
subCharms.set([{ charm: link, type: "notes", name: "My Notes" }])
// → Write: modules[0].charm = link
// → Write: modules[0].type = "notes"    // ← Can be lost in conflict!
// → Write: modules[0].name = "My Notes"
```

If a conflict occurs between writes, some properties may not persist. The `charm` link tends to survive (it's the first/primary property), but `type` gets lost.

### Symptoms of Corruption

- Modules show "📋" fallback icon instead of proper icon (📝, 📧, etc.)
- Module header shows "📋 Unknown" or similar
- The `charm` link still works (sub-charm data is intact)
- Only the metadata in the parent's `subCharms` array is corrupted

---

## Problem Statement

When dragging modules in the Record pattern with TWO tabs open to the same charm:
- Modules lose their `type` property
- Shows fallback "📋" icon instead of proper labels like "📝 Notes" or "📧 Contact"
- Data corruption is intermittent but reproducible

---

## Root Cause Analysis

### Framework Behavior Discovered

1. **Each tab has independent WebSocket connection** to the server
2. **Cell writes use last-write-wins + retry** conflict resolution
3. **Array element updates are NOT atomic** - conflict mid-write can lose properties
4. **When two tabs write simultaneously:**
   - Both tabs call `subCharms.set(newList)`
   - Writes race to server
   - Conflict detected, retry occurs
   - Retry may read partial/stale data where `type` property is missing

### The `diffAndUpdate` Function

The framework's `diffAndUpdate` writes each property individually:
```typescript
// Writes to: modules[0] <- link, modules[0].type <- "module", modules[0].name <- "A"
// If conflict between writes, some properties may not persist
```

### Evidence

Corrupted modules show "📋" (fallback when `type` is undefined) while `charm` reference survives. This is consistent with partial writes where only some properties made it through.

---

## Recommended Solution

### Use Idiomatic Cell Methods

The current code uses manual `===` reference comparison which is fragile. Use the framework's idiomatic patterns:

1. **Use `Cell.equals()` for identity comparison** - Uses `areLinksSame()` internally for proper identity comparison (resolves aliases)
2. **Use `Cell.remove()` for removal** - Uses `areLinksSame()` internally
3. **No `insertAt()` exists** - Must use `get()` + manipulation + `set()` for positional insertion
4. **Get fresh data from current array** - Don't rely on potentially stale `sourceCell.get()` data

### Fixed Handler Implementation

```typescript
const insertAtPosition = handler<
  { detail: { sourceCell: Cell<SubCharmEntry> } },
  {
    subCharms: Cell<SubCharmEntry[]>;
    insertAfterEntry: SubCharmEntry | null; // null = insert at start
    targetPinned: boolean;
  }
>((event, { subCharms, insertAfterEntry, targetPinned }) => {
  const sourceCell = event.detail?.sourceCell;
  if (!sourceCell) return;

  const current = subCharms.get() || [];

  // Find the ACTUAL entry in current array using Cell.equals() for proper link identity
  // This ensures we have complete, fresh data even if sourceCell is stale from multi-tab conflicts
  const fromIndex = current.findIndex((e) =>
    e?.charm && sourceCell.equals(e.charm)
  );
  if (fromIndex === -1) return; // Entry not found (removed by another tab), bail

  const actualEntry = current[fromIndex];

  // Build updated entry - spreading actualEntry preserves all properties including type
  const updatedEntry = {
    ...actualEntry,
    pinned: targetPinned,
  };

  // Create new array without the dragged item (using slice for immutability)
  const withoutDragged = [
    ...current.slice(0, fromIndex),
    ...current.slice(fromIndex + 1),
  ];

  // Find insertion index using Cell.equals() for proper identity comparison
  let insertIndex: number;
  if (insertAfterEntry === null) {
    insertIndex = 0;
  } else {
    const afterIndex = withoutDragged.findIndex((e) =>
      e?.charm && insertAfterEntry?.charm &&
      (e.charm as Cell<unknown>).equals(insertAfterEntry.charm)
    );
    insertIndex = afterIndex >= 0 ? afterIndex + 1 : withoutDragged.length;
  }

  // Insert at position
  const newList = [
    ...withoutDragged.slice(0, insertIndex),
    updatedEntry,
    ...withoutDragged.slice(insertIndex),
  ];

  subCharms.set(newList);
});
```

### Key Changes from Original

| Original | Fixed |
|----------|-------|
| `e?.charm === draggedEntry?.charm` | `sourceCell.equals(e.charm)` |
| `e?.charm === insertAfterEntry?.charm` | `(e.charm as Cell<unknown>).equals(insertAfterEntry.charm)` |
| Spread `draggedEntry` (from stale sourceCell.get()) | Spread `actualEntry` (fresh from current array) |

### Why We Think This Fix Should Work (UNTESTED)

**Note: This fix has NOT been tested yet.** The reasoning below is theoretical based on our understanding of the framework.

1. **`Cell.equals()` handles link aliases**: The framework may create different Cell references that point to the same underlying data. `===` comparison fails, but `Cell.equals()` uses `areLinksSame()` which properly resolves aliases.

2. **Fresh data from current array**: Instead of using `sourceCell.get()` which may return stale data from before a conflict retry, we find the entry in the current `subCharms.get()` array. This array should be authoritative and have all properties intact.

3. **Spread preserves all properties**: By spreading `actualEntry` (not the potentially stale `draggedEntry`), we should ensure `type`, `name`, and any other properties are preserved even if there was a mid-operation conflict.

4. **Bail if entry not found**: If `fromIndex === -1`, another tab may have deleted the module. We bail gracefully instead of corrupting data.

**Testing is required to validate these assumptions.**

---

## Secondary Issue: Last Drop Zone Size

The last drop zone in the unpinned rail column is too small (8px). It should fill remaining column space for easier drop target.

### Fix

```jsx
<ct-drop-zone
  accept="module"
  onct-drop={insertAtPosition({ subCharms, insertAfterEntry: null, targetPinned: false })}
  style={{ flex: 1, display: "flex" }}
>
  <div style={{ flex: 1, minHeight: "40px" }} />
</ct-drop-zone>
```

Location: Around line 654-659 in record.tsx

---

## Files to Modify

**`/patterns/jkomoros/record/record.tsx`**

1. **insertAtPosition handler** (lines ~277-315): Replace with idiomatic Cell.equals() version above
2. **Empty rail drop zone** (lines ~654-659): Add flex: 1 styling

---

## Testing Checklist

When implementing:

- [ ] Single tab: Drag modules around, verify type persists
- [ ] Two tabs: Open same charm in two tabs, drag in one, verify no corruption
- [ ] Last drop zone: Can easily drop items at end of column
- [ ] All existing drag functionality still works
- [ ] Modules retain type after server restart (existing repair logic)

---

## Reference Patterns

The `card-piles.tsx` pattern in labs demonstrates proper drag-and-drop with Cell identity:

```typescript
// From labs/packages/patterns/card-piles.tsx
const moveToPile1 = handler<
  { detail: { sourceCell: Cell } },
  { pile1: Cell<Card[]>; pile2: Cell<Card[]> }
>((event, { pile1, pile2 }) => {
  const sourceCard = event.detail?.sourceCell?.get() as Card;
  if (!sourceCard) return;

  // Remove from pile2 if present (by value comparison for simple objects)
  const p2 = pile2.get();
  const idx2 = p2.findIndex(
    (c) => c.rank === sourceCard.rank && c.suit === sourceCard.suit,
  );
  if (idx2 >= 0) {
    pile2.set(p2.filter((_, i) => i !== idx2));
    pile1.push(sourceCard);
  }
});
```

Note: card-piles uses value comparison (rank + suit) rather than Cell.equals() because cards are simple value objects, not Cells containing links.

---

## Community Doc Candidate

This could become a community doc about:
- Multi-tab conflict resolution patterns
- When to use Cell.equals() vs === comparison
- Preserving data integrity during array mutations

---

## Created

2024-12-19 - Deferred to focus on simpler fixes first
