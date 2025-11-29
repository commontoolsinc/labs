# Reactive Reduce and MapByKey Primitives

**Branch**: `feature/reactive-reduce-primitives`
**Status**: Implementation complete, critical bug blocking deployment
**Last Updated**: November 2024

---

## Executive Summary

This branch adds two reactive primitives to enable **MapReduce-style streaming pipelines** with per-item caching:

| Primitive | Purpose | Status |
|-----------|---------|--------|
| `reduce()` | Aggregate array of cells with value unwrapping | **Working** |
| `mapByKey()` / `cell.map(fn, {key})` | Process arrays with stable key-based identity | **Bug: Browser doesn't run mapByKey** |

The core goal is enabling patterns like:
```typescript
// Per-item LLM processing with caching
const analyses = articles.map(
  article => generateObject({ prompt: article.content }),
  { key: "articleURL" }  // Cache results by URL
);

// Aggregate completed results as they stream in
const allLinks = analyses.reduce([], (acc, item) =>
  item.pending ? acc : [...acc, ...item.result.links]
);
```

---

## Table of Contents

1. [Why This Matters](#why-this-matters)
2. [What We Built](#what-we-built)
3. [How It's Implemented](#how-its-implemented)
4. [The Blocking Bug](#the-blocking-bug)
5. [Framework Author Feedback & Next Steps](#framework-author-feedback--next-steps)
6. [Files Changed](#files-changed)
7. [Reproduction Steps](#reproduction-steps)

---

## Why This Matters

### The Problem: Per-Item LLM Caching

Consider a pattern that processes articles through LLM analysis:

```
Fetch articles → [Per-article LLM extraction] → Aggregate results → Save
```

**Without per-item caching**:
- Add 1 new article → Re-run LLM for ALL articles
- 100 articles × $0.05/call = $5.00 per update

**With per-item caching (mapByKey)**:
- Add 1 new article → Run LLM ONLY for the new article
- 99 cached results + 1 new call = $0.05 total

This 100x cost difference is why keyed maps matter.

### The Index-Based Identity Problem

The framework's `Cell.map()` uses **index-based identity**:

```typescript
// In map.ts
const resultCell = runtime.getCell(
  parentCell.space,
  { result, index: initializedUpTo },  // ← Index is the identity
  ...
);
```

When items move positions:
1. Task at index 1 has binding `element: list[1]`
2. Remove item at index 0 → task moves to index 0
3. The result cell **still reads from `list[1]`**
4. Result: Wrong data displayed

### The MapReduce Vision

With working `reduce()` and `mapByKey()`:

```typescript
// Phase 1: Extract links (async, per-item cached)
const extractions = articles.map(
  article => generateObject({ prompt: article.content, ... }),
  { key: "articleURL" }
);

// Phase 2: Aggregate as they complete (streaming!)
const allLinks = extractions.reduce([], (acc, item) => {
  if (item.pending) return acc;
  return [...acc, ...item.result.links];
});

// Results flow incrementally - no "wait for all" barrier
```

---

## What We Built

### 1. `reduce()` - Reactive Array Aggregation

**API**:
```typescript
// Standalone function
const sum = reduce(numbers, 0, (acc, num) => acc + num);

// Method on Cell
const sum = numbers.reduce(0, (acc, num) => acc + num);
```

**Key features**:
- Unwraps cell values before passing to reducer (unlike `derive()`)
- Supports closure capture (external variables work)
- Re-runs on any item change (streaming behavior)
- Template literals with captured values auto-wrapped with `str` tag

**Status**: **Working** - Tested with patterns including closure capture.

### 2. `mapByKey()` - Key-Based Array Mapping

**API**:
```typescript
// Standalone function with key path
const results = mapByKey(items, "id", item => process(item));

// Method on Cell with options
const results = items.map(
  item => process(item),
  { key: "id" }
);
```

**Key features**:
- Results cached by key, not index
- Same key = same result cell regardless of position
- Automatic cleanup when keys disappear
- Supports property paths: `"id"`, `["nested", "id"]`

**Status**: **Bug** - Works during deploy, breaks in browser.

---

## How It's Implemented

### reduce() - Transform to lift()

The ts-transformer converts `reduce()` calls into `lift()` calls:

```typescript
// User writes:
const scaled = numbers.reduce(0, (acc, n) => acc + n * multiplier);

// Transformer generates:
lift(({ list, initial, multiplier }) =>
  (!list || !Array.isArray(list)) ? initial :
  list.reduce((acc, n) => acc + n * multiplier, initial)
)({ list: numbers, initial: 0, multiplier })
```

**Why this works**:
- `lift()` unwraps values before passing to callback
- Closures captured at compile time (no serialization)
- Browser DOES run lift functions (they're cell subscriptions)

**Key files**:
- `packages/ts-transformers/src/closures/strategies/reduce-strategy.ts`
- `packages/runner/src/builder/module.ts` (reduce export)

### mapByKey() - Builtin with Key-Based Cell Identity

The runtime builtin uses keys instead of indices for result cell identity:

```typescript
// map.ts uses index:
{ result, index: initializedUpTo }

// map-by-key.ts uses key:
{ result, keyString }  // keyString = JSON.stringify(key)
```

**How key extraction works**:
```typescript
function extractKey(itemValue: any): any {
  if (keyPath === undefined) return itemValue;  // Identity
  if (typeof keyPath === "string") return itemValue?.[keyPath];  // Property
  if (Array.isArray(keyPath)) {  // Nested path
    let value = itemValue;
    for (const segment of keyPath) value = value?.[segment];
    return value;
  }
}
```

**How item movement is handled**:
```typescript
if (existing.index !== i) {
  // Item moved - stop old recipe and re-run with new index
  runtime.runner.stop(resultCell);
  runtime.runner.run(tx, opRecipe, createRecipeInputs(), resultCell);
  existing.index = i;
}
```

**Key files**:
- `packages/runner/src/builtins/map-by-key.ts`
- `packages/ts-transformers/src/closures/strategies/map-by-key-strategy.ts`

### cell.map(fn, {key}) - Unified API via Transform

The ts-transformer detects the `{ key }` option and routes to mapByKey:

```typescript
// User writes:
items.map(item => process(item), { key: "id" })

// Transformer generates:
mapByKey(items, "id", recipe(...), params)
```

**Key file**: `packages/ts-transformers/src/closures/strategies/map-strategy.ts`

---

## The Blocking Bug

### Symptom

When using `cell.map(fn, { key })` in the browser:
1. **Remove item**: Result shows stale/undefined entries
2. **Reorder items**: Result cells show wrong data
3. **Add item**: New item doesn't appear

### Root Cause: Browser Doesn't Instantiate Reactive Nodes

**During CLI deploy** (`instantiateRawNode` IS called):
- mapByKey closure is created with `keyToResultCell` Map
- Action is subscribed to scheduler
- Result cells created with key-based identity

**In browser** (`instantiateRawNode` is NEVER called):
- Browser only syncs cell data via websocket
- No mapByKey action is created
- No code runs to update result cells when array changes
- Result cells have stale index-based bindings

### Why reduce() Works But mapByKey Doesn't

| Aspect | reduce() | mapByKey() |
|--------|----------|------------|
| Implementation | Transforms to `lift()` | Builtin module |
| State | Stateless | Stateful closure |
| Browser runs it? | Yes (lift = cell subscription) | No (action never created) |
| Cell bindings | Single output | Multiple outputs |

### Evidence

Added logging to `runner.ts:instantiateRawNode`:
- **CLI deploy**: `[instantiateRawNode] Called for module: mapByKey` (appears)
- **Browser**: NO such logs at all

---

## Framework Author Feedback & Next Steps

### Prior Discussion

The index-based identity problem was filed as `community-patterns/patterns/jkomoros/issues/map-identity-tracking-issue.md`. The framework author responded:

> "The final solution will have to look at the schema of the mapper pattern (i.e. the pattern passed in) and use the current behavior if index is read and the proposed one if it isn't.
>
> Or alternatively we could use the proposed behavior everywhere - at least if the array being mapped over has ids itself - and let the system recompute all values when index is read.
>
> (if the array being mapped over has no ids for some reason, then it's a bit trickier to come up with good IDs. possibly we could just hash the values)"

### Interpretation: Fix at the Map Level, Not Separate Builtin

The framework author's guidance suggests a **more fundamental fix** to `map()` itself rather than a separate `mapByKey` builtin:

1. **Detect index usage at transform time** - Check if the mapper callback reads the `index` parameter
2. **If index is NOT used** → Use item-based identity (ID or hash)
3. **If index IS used** → Use current index-based behavior (or recompute)

### Why This Solves the Browser Problem

The current bug exists because:
- Result cells have bindings like `list[0]`, `list[1]` (index-based)
- When items move, bindings point to wrong data
- Browser can't fix this because mapByKey action doesn't run

With item-based identity:
- Result cells would bind to items by ID, not position
- "task-1" stays "task-1" regardless of array position
- No action needs to run in browser - bindings are inherently stable

### Implementation Plan

**Phase 1: Detect index usage in mapper callbacks**

In the ts-transformer, analyze the callback to determine if `index` parameter is used:

```typescript
// index NOT used - can use item-based identity
items.map(item => process(item))
items.map((item, _index) => process(item))  // Unused param

// index IS used - must use index-based identity (or recompute)
items.map((item, index) => ({ ...process(item), position: index }))
```

**Files to modify**: `packages/ts-transformers/src/closures/strategies/map-strategy.ts`

**Phase 2: Determine item identity source**

When index is not used, determine how to identify items:

1. **Explicit key option** (already implemented): `{ key: "id" }` or `{ key: item => item.id }`
2. **Auto-detect ID property**: If items have `id`, `[ID]`, or `_id` property, use it
3. **Hash fallback**: For items without IDs, hash the value with `JSON.stringify()`

**Phase 3: Change result cell identity**

Current (index-based):
```typescript
const resultCell = runtime.getCell(space, { result, index: i }, ...);
```

Proposed (item-based):
```typescript
const itemId = extractItemId(itemValue);  // From key option, auto-detect, or hash
const resultCell = runtime.getCell(space, { result, itemId }, ...);
```

**Phase 4: Change input bindings**

This is the tricky part. Current bindings are path-based:
```typescript
element: inputsCell.key("list").key(i)  // Resolves to list[i]
```

Options to explore:
1. **Bind to item cell directly** - Pass the actual item cell, not a path
2. **ID-based cell lookup** - Framework support for "cell with id X in array Y"
3. **Lift-based orchestration** - Use lift() to handle array→results mapping, with cached item processing

### Deep Dive: Why This Approach Solves the Browser Problem

**The core insight**: The browser problem exists because we're trying to fix stale bindings at runtime. But if bindings are **inherently stable** (based on item identity, not position), there's nothing to fix.

**Current broken flow**:
```
Deploy:
  - map() creates result cell for list[0] (happens to be task-1)
  - Binding: element → list[0]
  - Result stored with identity { result, index: 0 }

Browser (task-1 removed, task-2 now at index 0):
  - Result cell still has binding element → list[0]
  - list[0] now contains task-2's data
  - Result cell shows WRONG DATA
  - mapByKey action doesn't run to fix this
```

**Proposed fixed flow**:
```
Deploy:
  - map() creates result cell for task-1 (detected via id property)
  - Binding: element → [item with id "task-1"]  ← KEY CHANGE
  - Result stored with identity { result, itemId: "task-1" }

Browser (task-1 removed, task-2 now at index 0):
  - Result cell for task-1 no longer in output (task-1 doesn't exist)
  - Result cell for task-2 still has binding to [item with id "task-2"]
  - task-2 moved from index 1 to index 0, but binding follows the ITEM not the INDEX
  - Result cell shows CORRECT DATA
  - No action needed - bindings are inherently correct
```

**The magic**: By binding to item identity instead of array position, the bindings remain valid even when items move. The browser doesn't need to run any code to "fix" things.

### Implementation Details for Future Sessions

**Step 1: Detect if callback uses index parameter**

Location: `packages/ts-transformers/src/closures/strategies/map-strategy.ts`

```typescript
function callbackUsesIndex(callback: ts.ArrowFunction | ts.FunctionExpression): boolean {
  // Check if callback has >= 2 parameters and the second one is used
  if (callback.parameters.length < 2) return false;

  const indexParam = callback.parameters[1];
  if (!ts.isIdentifier(indexParam.name)) return false;

  // Check if the parameter name appears in the callback body
  // (excluding the parameter declaration itself)
  const indexName = indexParam.name.text;
  if (indexName.startsWith('_')) return false;  // Convention: _index means unused

  return isIdentifierUsedInBody(callback.body, indexName);
}
```

**Step 2: Extract item identity**

For items with explicit key option:
```typescript
// User wrote: items.map(fn, { key: "id" })
const itemId = item.id;
```

For items with auto-detected ID:
```typescript
// Check for common ID properties
const itemId = item.id ?? item[ID] ?? item._id ?? JSON.stringify(item);
```

**Step 3: Create ID-based result cells**

In `map.ts` (or enhanced version):
```typescript
// OLD: Index-based
const resultCell = runtime.getCell(space, { result, index: i }, ...);

// NEW: ID-based (when index not used)
const itemId = extractItemId(itemValue, keyOption);
const resultCell = runtime.getCell(space, { result, itemId }, ...);
```

**Step 4: The Hard Part - ID-based input bindings**

This is where we need framework guidance. Current bindings are paths:
```typescript
element: inputsCell.key("list").key(i)  // Path: list[0], list[1], etc.
```

Options:

**Option A: Direct cell reference**
```typescript
// Instead of path, pass the actual item cell
element: itemCell  // Direct reference to the cell containing this item
```
Problem: itemCell is ephemeral - created fresh each map() invocation.

**Option B: ID-based path (requires framework change)**
```typescript
// New path syntax that references by ID
element: inputsCell.key("list").byId("task-1")
```
Problem: Framework doesn't support this path type.

**Option C: Lift for orchestration (fallback)**
```typescript
// Transform map with key to lift that looks up cached results
lift(({ list, cachedResults }) => {
  return list.map(item => {
    const id = item.id;
    return cachedResults[id] ?? computeNew(item);
  });
})({ list, cachedResults: keyedResultsCell })
```
Problem: Loses per-item reactivity, but DOES work in browser.

### Notes for Future Sessions

**The separate `mapByKey` builtin may not be the right approach.** The framework author's feedback suggests enhancing `map()` itself. Consider:

1. Keep the `{ key }` option syntax - it's explicit and clear
2. But implement it by modifying how `map()` works, not as a separate builtin
3. The key insight is making **input bindings** item-based, not just result cell identity

**Key question to resolve**: How can cell paths reference items by identity rather than position? This may require framework-level changes to the cell/path system. Specifically, we need something like `inputsCell.key("list").byId(itemId)` that returns the cell for the item with that ID regardless of its current array position.

**Fallback if path changes are too deep**: Transform keyed maps to `lift()` for orchestration (Option C above). This loses some per-item reactivity but works in browser. This is similar to what we did for `reduce()`.

**What we have working that can be reused**:
- `{ key }` option detection in ts-transformer
- Key extraction logic (property path, function, auto-detect)
- Result cell identity by key (this part works)
- The problem is ONLY the input bindings

### Requirements (Non-Negotiable)

- **Caching MUST be preserved** - Per-item results cached by key
- **Adding items at runtime MUST work** - No "refresh required"
- **Should work like React's key prop** - Stable identity, correct updates

---

## Files Changed

### New Files

| File | Purpose |
|------|---------|
| `packages/runner/src/builtins/map-by-key.ts` | mapByKey builtin implementation |
| `packages/ts-transformers/src/closures/strategies/map-by-key-strategy.ts` | ts-transformer for mapByKey |
| `packages/ts-transformers/src/closures/strategies/reduce-strategy.ts` | ts-transformer for reduce |

### Modified Files

| File | Changes |
|------|---------|
| `packages/runner/src/builder/module.ts` | Added `reduce()` export |
| `packages/runner/src/builder/built-in.ts` | Added `mapByKey()` factory |
| `packages/runner/src/builtins/index.ts` | Registered mapByKey builtin |
| `packages/api/index.ts` | Added types for reduce and mapByKey |
| `packages/ts-transformers/src/closures/strategies/map-strategy.ts` | Route `{key}` option to mapByKey |
| `packages/ts-transformers/src/ast/call-kind.ts` | Added "reduce" and "mapByKey" call kinds |

### Test Patterns

| File | Purpose |
|------|---------|
| `packages/patterns/reactive-primitives-test.tsx` | Comprehensive test of reduce and mapByKey |
| `packages/patterns/shopping-cart-demo.tsx` | Real-world shopping cart example |

---

## Reproduction Steps

### Deploy Test Pattern

```bash
cd ~/Code/labs/packages/patterns
deno task ct charm new \
  --api-url http://localhost:8000 \
  --identity ~/Code/community-patterns/claude.key \
  --space test-space \
  reactive-primitives-test.tsx
```

### Reproduce Bug

1. Navigate to charm URL in browser
2. Look at TEST 6 section - shows 4 tasks correctly
3. Click "Remove First" button
4. **BUG**: TEST 6 now shows stale/undefined entries instead of remaining 3 tasks

### Verify reduce() Works

1. In same pattern, look at TEST 9 (reduce tests)
2. Modify the numbers array
3. **WORKS**: Sum, scaled sum, and count update correctly

---

## Related Documentation

Detailed design context in `community-patterns/patterns/jkomoros/issues/`:
- `DESIGN-reactive-reduce-and-keyed-map.md` - Original design, blockers, implementation approach
- `ISSUE-per-item-llm-caching-architecture.md` - Why per-item caching matters, Cell.map() proxy issues
- `map-identity-tracking-issue.md` - The index vs key identity problem

Real-world pattern demonstrating the need:
- `community-patterns/patterns/jkomoros/prompt-injection-tracker.tsx`

---

## Summary

| Component | Status | Notes |
|-----------|--------|-------|
| `reduce()` function | **Working** | Transform to lift() |
| `cell.reduce()` method | **Working** | Transform to lift() |
| `mapByKey()` function | **Bug** | Browser doesn't instantiate |
| `cell.map(fn, {key})` | **Bug** | Routes to mapByKey |
| ts-transformers | **Working** | Closure capture works |
| Template literal wrapping | **Working** | Auto-wrap with str tag |

**Bottom line**: reduce() is ready. mapByKey needs framework author input on how to make builtin modules work in browser.
