# record.tsx Performance Analysis

**Branch:** `perf/record-tsx-analysis`
**Date:** 2025-12-30
**Context:** Pull-based scheduler testing revealed record.tsx takes 830.7ms vs 45.5ms for simple patterns (18x slower)

## Executive Summary

The record.tsx pattern has severe performance issues on initial load. The primary bottleneck is `initializeRecord` (lines 143-200), which performs 94 cell reads in a single computation taking 298.8ms. The excessive reads come from:
1. Creating a `Note` pattern that calls 3 `wish()` functions to materialize large charm collections
2. Cascade of 6+ derived `lift()` computations
3. 27+ inline `computed()` calls inside JSX per module

## Top Performance Issues (Ranked by Impact)

### 1. Note Pattern's `wish()` Calls (~150-200ms)

**Location:** Lines 164, 174 in `record.tsx` via `Note()` pattern

**Problem:** Creating a Note pattern triggers:
- `wish<{ allCharms }>("/")` - reads ALL charms in space
- `wish<MentionableCharm[]>("#mentionable")` - reads mentionable charms
- `wish<MinimalCharm[]>("#recent")` - reads recent charms

Then runs multiple `computed()` filters over these collections:
- `notebooks` - filters all charms
- `allNotesCharm` - finds by name
- `recentNotes` - filters recent
- `containingNotebookNames` - iterates all notebooks

**Optimization:**
```typescript
// CURRENT - Creates Note immediately with all wish() calls
const notesCharm = Note({ linkPattern: recordPatternJson });

// OPTION 1: Defer Note creation until first render/interaction
// OPTION 2: Use lightweight NotePlaceholder initially, promote on edit
// OPTION 3: Note pattern could lazy-load wish() data on first access
```

### 2. Cascade of Derived Computations (~40-60ms)

**Location:** Lines 851-893

**Problem:** 6 chained `lift()` computations run sequentially:
```typescript
const entriesWithIndex = lift(...)({ sc: subCharms, expandedIdx });
const pinnedEntries = lift(...)({ arr: entriesWithIndex });
const unpinnedEntries = lift(...)({ arr: entriesWithIndex });
const allEntries = lift(...)({ arr: entriesWithIndex });
const pinnedCount = lift(...)({ arr: pinnedEntries });
const hasUnpinned = lift(...)({ arr: unpinnedEntries });
```

**Optimization - Consolidate into single lift:**
```typescript
const { pinnedEntries, unpinnedEntries, allEntries, pinnedCount, hasUnpinned } = lift(
  ({ sc, expandedIdx }) => {
    const entries = (sc || []).map((entry, index) => ({
      entry,
      index,
      isExpanded: expandedIdx === index,
    }));
    const pinned = entries.filter((item) => item.entry?.pinned);
    const unpinned = entries.filter((item) => !item.entry?.pinned);
    return {
      pinnedEntries: pinned,
      unpinnedEntries: unpinned,
      allEntries: entries,
      pinnedCount: pinned.length,
      hasUnpinned: unpinned.length > 0,
    };
  },
)({ sc: subCharms, expandedIdx: expandedIndex });
```

### 3. Inline `computed()` Calls in JSX (~30-50ms)

**Location:** Lines 1105-1957 (27+ inline computed calls)

**Problem:** Each inline `computed()` creates a reactive node:
```tsx
style={computed(() => ({
  display: "flex",
  borderBottom: entry.collapsed ? "none" : "1px solid #f3f4f6",
  background: "#fafafa",
}))}
aria-expanded={computed(() => entry.collapsed ? "false" : "true")}
```

For N modules, this creates 27*N computations.

**Optimization - Pre-compute in entriesWithIndex:**
```typescript
const entriesWithIndex = lift(({ sc, expandedIdx }) => {
  return (sc || []).map((entry, index) => ({
    entry,
    index,
    isExpanded: expandedIdx === index,
    // Pre-compute styles
    containerStyle: {
      display: "flex",
      borderBottom: entry.collapsed ? "none" : "1px solid #f3f4f6",
      background: "#fafafa",
    },
    ariaExpanded: entry.collapsed ? "false" : "true",
    // Pre-compute display info
    displayInfo: getModuleDisplaySync(entry.type, entry.charm?.label),
  }));
})({ sc: subCharms, expandedIdx: expandedIndex });
```

### 4. `getModuleDisplay` Called Inside `.map()` (~10-20ms)

**Location:** Lines 1073-1076, 1321-1324, 1573-1576, 1852-1855

**Problem:** `getModuleDisplay` is a `lift()` called 4x per render cycle:
```tsx
{pinnedEntries.map(({ entry, index, isExpanded }) => {
  const displayInfo = getModuleDisplay({ type: entry.type, charm: entry.charm });
  // ...
})}
```

**Optimization:** Include in pre-computed entries (see #3 above).

### 5. addSelectItems Re-computes on Every Change (~5-10ms)

**Location:** Lines 900-929

**Problem:** Dropdown items rebuilt on any subCharms change:
```typescript
const addSelectItems = lift(({ sc }: { sc: SubCharmEntry[] }) => {
  const existingTypes = new Set((sc || []).map((e) => e?.type).filter(Boolean));
  // ... builds dropdown
})({ sc: subCharms });
```

**Optimization:** Only recompute when module types actually change:
```typescript
const moduleTypes = lift(({ sc }) =>
  new Set((sc || []).map(e => e?.type).filter(Boolean))
)({ sc: subCharms });

const addSelectItems = lift(({ types }) => {
  // ... build dropdown from types
})({ types: moduleTypes });
```

## Superstitions from community-patterns

Key gotchas that may apply:

1. **Expensive Computation Inside .map() JSX** - Causes N-squared CPU spikes. Pre-compute in `computed()` outside map.

2. **`computed()` Inside .map() With `.get()`** - Creates fresh cells per iteration, causes thrashing. Use inline computed WITHOUT `.get()`.

3. **Timing Inside computed() Is Misleading** - Only fires during graph construction. Use call counts or DevTools for real measurement.

4. **applyChangeSet Per-Write Overhead** - ~68ms per write average. Coalesce changes when possible.

## Quick Wins (Low Risk)

1. **Consolidate derived lifts** - Lines 868-893 (Est: -20ms)
2. **Pre-compute collapsed-dependent styles** - Lines 1105-1148 (Est: -15ms)
3. **Move getModuleDisplay into entry pre-computation** - (Est: -10ms)

## Medium Effort (Moderate Risk)

4. **Defer TypePicker creation** - Create after Record first paint
5. **Virtualize collapsed modules** - Don't create charm until uncollapsed
6. **Cache getAddableTypes()** - Line 897

## High Effort (Architectural Change)

7. **Lazy Note pattern** - Defer wish() calls until needed
8. **Lazy charm factories** - Store `{ type, initialValues }` instead of live charms
9. **Template pre-computation** - Pre-build common template charm arrays

## Performance Budget

| Pattern | Current | Target | Notes |
|---------|---------|--------|-------|
| Simple pattern | 45ms | 45ms | Baseline |
| record.tsx (empty) | 830ms | <200ms | Initial load |
| record.tsx (with modules) | TBD | <300ms | With 5 modules |

## References

- `/Users/alex/Code/labs/packages/patterns/record.tsx` - Main file
- `/Users/alex/Code/labs/packages/patterns/notes/note.tsx` - Note pattern with wish() calls
- `/Users/alex/Code/community-patterns/community-docs/superstitions/` - Performance gotchas
- `/Users/alex/Code/labs/docs/common/CELLS_AND_REACTIVITY.md` - Cell best practices
