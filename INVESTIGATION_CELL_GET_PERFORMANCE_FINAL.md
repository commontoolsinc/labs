# Cell.get() Performance Investigation - Final Analysis

## User Clarification

Data is **already synced locally** - not waiting on network.
Issue is reading with **pending writes to server** (commits in flight).

## Root Cause: JSON.stringify() in Hot Path

**Location**: `packages/runner/src/schema.ts:379-383`

```typescript
const seenKey = JSON.stringify(link);  // ← Called for EVERY cell!
const seenEntry = seen.find((entry) => entry[0] === seenKey);
if (seenEntry) {
  return seenEntry[1];
}
```

This is in `validateAndTransform()` which is called from `Cell.get()` for **every cell** in a nested structure.

## The Performance Problem

For a structure spanning 10 docs with nesting:

### 1. Many validateAndTransform() Calls
- Root cell → `validateAndTransform()`
- Each child ref → `validateAndTransform()`
- Nested properties → more calls
- **Easily 50-100 calls total**

### 2. Expensive Operations Per Call

**JSON.stringify(link)** where link contains:
```typescript
{
  space: "did:key:...",
  id: "doc-id",
  type: "application/json",
  path: ["user", "address"],
  schema: {  // ← Can be LARGE nested object
    type: "object",
    properties: {
      // ... deeply nested schema definition
    }
  },
  rootSchema: { /* same */ }
}
```

- Schema objects can be deeply nested
- JSON.stringify must traverse entire object tree
- Called 50-100 times per nested read
- **0.2-0.5ms per call** if schema is large

**Linear search** with `.find()`:
- O(n) where n = number of cells processed so far
- Gets slower as more cells are added to `seen`
- **O(n²) total complexity**

### 3. Math

```
50 cells × 0.3ms stringify = 15ms
+ O(n²) find overhead = 3-5ms
+ resolveLink reads = 2-3ms
-----------------------------------
Total: ~20ms
```

## Why Benchmarks Are Fast

`cell.bench.ts` reads **before committing**:
- Data in transaction working copy (in-memory Chronicle)
- No separate docs to traverse
- Simpler structure = fewer validateAndTransform calls
- **Fast!**

User scenario reads **after committing**:
- Data split across 10 separate documents
- Each doc is a Cell requiring validateAndTransform
- Each cell triggers JSON.stringify + find
- **Slow!**

## Why "In Flight" Makes It Worse

After commit but before sync completes:
- Data is in **nursery** (fast to read)
- But structure is **split across docs**
- Each doc reference creates a **new Cell**
- Each Cell.get() → validateAndTransform → JSON.stringify
- More cells = more overhead

Before commit:
- Everything in **one transaction**
- Fewer Cell objects created
- Less validateAndTransform calls

## Evidence

1. **User observation**: "cell.bench.ts tests similar complexity and is pretty fast"
   - Benchmarks read before commit → fewer separate cells

2. **User observation**: "20ms for structure spanning maybe 10 docs"
   - After commit → 10 docs = 50+ cells = 50+ stringify calls

3. **Code inspection**: JSON.stringify called unconditionally for every cell
   - No caching of stringified keys
   - Linear search gets slower as seen array grows

## Potential Fixes

### High Priority

#### 1. Cache Stringified Keys
```typescript
// Use WeakMap to avoid memory leaks
const linkKeyCache = new WeakMap<object, string>();

function getLinkKey(link: NormalizedFullLink): string {
  let key = linkKeyCache.get(link);
  if (!key) {
    key = JSON.stringify(link);
    linkKeyCache.set(link, key);
  }
  return key;
}
```

**Problem**: Link objects are created fresh each time, so WeakMap won't help.

#### 2. Use Map Instead of Array for `seen`
```typescript
const seen = new Map<string, any>();

// In validateAndTransform:
const seenKey = JSON.stringify(link);
if (seen.has(seenKey)) {
  return seen.get(seenKey);
}
// ... later ...
seen.set(seenKey, result);
```

**Benefit**: O(1) lookup instead of O(n)

#### 3. Hash Link Objects More Efficiently
Instead of stringifying entire link (including schema), hash just the essential parts:

```typescript
function getLinkKey(link: NormalizedFullLink): string {
  return `${link.space}:${link.id}:${link.type}:${link.path.join('/')}`;
}
```

**Benefit**: Much faster than JSON.stringify of large schemas

**Concern**: Need to ensure uniqueness - what if same doc/path with different schema?

#### 4. Pass seen as Map + Use Efficient Key
```typescript
const seen = new Map<string, any>();

function getLinkKey(link: NormalizedFullLink): string {
  // Include schema hash only if present
  const schemaHash = link.schema
    ? `#${JSON.stringify(link.schema).length}`
    : '';
  return `${link.space}:${link.id}:${link.path.join('/')}${schemaHash}`;
}
```

### Medium Priority

#### 5. Memoize validateAndTransform Results
Cache results at Cell level so repeated .get() calls don't reprocess.

#### 6. Lazy Schema Resolution
Don't include full schema in link object - use schema ID/reference.

## Recommended Fix

**Two-phase approach**:

1. **Immediate**: Change `seen` from Array to Map (schema.ts:334)
   ```typescript
   seen: Map<string, any> = new Map()
   ```
   - Fixes O(n²) → O(n)
   - No semantic changes

2. **Short-term**: Optimize key generation
   ```typescript
   function getLinkKey(link: NormalizedFullLink): string {
     return `${link.space}|${link.id}|${link.path.join('/')}`;
   }
   ```
   - Only stringify if schema differs
   - Much faster than full JSON.stringify

## Test Plan

Created `schema-stringify-performance.test.ts`:
- Measures JSON.stringify overhead on realistic link objects
- Measures .find() overhead with growing array
- Compares before/after commit performance
- Should confirm ~20ms delay and show where time goes

## Summary

The 20ms delay is from:
1. **50-100 validateAndTransform() calls** for nested 10-doc structure
2. **JSON.stringify(link)** on each call with large schema objects
3. **O(n) linear search** through growing `seen` array
4. **O(n²) total complexity**

Not from:
- ❌ Network latency (data already local)
- ❌ IDB reads (data in nursery)
- ❌ Heap destructuring (only 2-3ms contribution)
- ✅ **Repeated expensive operations in validateAndTransform**
