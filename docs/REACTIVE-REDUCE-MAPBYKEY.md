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
5. [Questions for Framework Author](#questions-for-framework-author)
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

## Questions for Framework Author

### Primary Question

**Why doesn't the browser instantiate reactive nodes, and can we make it do so for mapByKey?**

The browser loads persisted cell data but doesn't run `instantiateRawNode` for builtin modules. This means stateful builtins like mapByKey never get their actions scheduled.

### Alternative Approaches

1. **Run mapByKey in browser**: Make browser instantiate builtin modules like CLI does

2. **Persist mapByKey state**: Save `keyToResultCell` mapping, restore in browser
   - But: How to handle new items that need recipe execution?

3. **Transform mapByKey to lift()**: Like reduce, but...
   - Loses caching (lift re-runs all items on any change)
   - Or needs to pass recipe through lift (serialization issues?)

4. **Hybrid**: Use lift for orchestration, builtins for computation
   - Key lookup via lift, but existing items use cached cells
   - New items: compute on-the-fly (uncached) or show placeholder

### Key Constraint

User requirements:
- **Caching MUST be preserved** - This is the whole point
- **Adding items at runtime MUST work** - No "refresh required"
- **No limitations acceptable** - Should work like React's key prop

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
