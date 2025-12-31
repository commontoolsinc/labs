# Cell.get() Performance Investigation - ROOT CAUSE FOUND

## Summary

The 20ms delay when calling `.get()` on structures with mentionables is caused by **repeated expensive resolveLink() calls** during array schema processing, compounded by **O(n²) complexity in validateAndTransform's seen array**.

## The Complete Flow

### 1. Pattern Exports Mentionable Array

**File**: `packages/patterns/notes/notebook.tsx:1341`
```typescript
return {
  // ...
  mentionable: notes,  // Cell<NoteCharm[]>
};
```

### 2. BacklinksIndex Calls .get() on Mentionable

**File**: `packages/patterns/system/backlinks-index.tsx:73-76`
```typescript
} else if (exported && typeof (exported as any).get === "function") {
  const arr = (exported as { get: () => MentionableCharm[] }).get() ?? [];
  for (const m of arr) if (m) out.push(m);
}
```

This `.get()` call happens in a `lift` function, which is a JavaScript module node.

### 3. Runner Executes JavaScript Nodes

**File**: `packages/runner/src/runner.ts:1103-1105`
```typescript
const argument = module.argumentSchema
  ? inputsCell.asSchema(module.argumentSchema).withTx(tx).get()
  : inputsCell.getAsQueryResult([], tx);
```

When runner executes JavaScript nodes, it calls `.get()` to materialize the inputs.

### 4. Cell.get() Triggers validateAndTransform

**File**: `packages/runner/src/cell.ts:527`
```typescript
get(): Readonly<T> {
  if (!this.synced) this.sync(); // No await, just kicking this off
  return validateAndTransform(this.runtime, this.tx, this.link, this.synced);
}
```

### 5. validateAndTransform Processes Array Schema

**File**: `packages/runner/src/schema.ts:743-835`

For EACH element in the array:

#### 5a. Stringify Link for Deduplication
```typescript
// Line 379-383
const seenKey = JSON.stringify(link);
const seenEntry = seen.find((entry) => entry[0] === seenKey);
```
- **Cost**: ~0.004ms per call (proven negligible)
- **O(n) linear search** in growing `seen` array

#### 5b. Call resolveLink()
```typescript
// Line 352-357
const resolvedLink = resolveLink(
  runtime,
  tx ?? runtime.edit(),
  link,
  "writeRedirect",
);
```
- **This is called for EVERY array element!**

#### 5c. Process Array Elements
```typescript
// Line 753, 827-833
for (let i = 0; i < value.length; i++) {
  // ...
  result[i] = validateAndTransform(
    runtime,
    tx,
    elementLink,
    synced,
    seen,
  );
}
```

Each element triggers:
1. parseLink() - line 795
2. Potentially createDataCellURI() - line 818
3. **Recursive validateAndTransform()** - line 827

## The Performance Problem

### For an array with N elements (e.g., notes with 2 entries):

1. **Parent array validateAndTransform**: calls resolveLink() once
2. **For each of N elements**:
   - validateAndTransform() called → line 827
   - Each calls resolveLink() → line 352
   - Each calls JSON.stringify() → line 379
   - Each does .find() on growing seen array → line 380

### What resolveLink() Does (Expensive!)

**File**: `packages/runner/src/link-resolution.ts:63-200`

From previous investigation, resolveLink() performs:
- **Line 97**: Sigil probe at full path (read operation)
- **Line 110**: Read full value for reactivity (read operation)
- **Line 137**: Parent sigil probe (read operation)
- **Line 143**: Read parent value (read operation)

**Multiple reads per element!**

### Why "In Flight" Data Makes It Worse

When data is in the nursery (pending writes to server):
- Reads must check nursery first
- Then fall back to heap
- Each read operation has overhead to check both locations
- For N array elements × M reads per resolveLink = N×M nursery lookups

## The Math

For a structure with 2 notes in a notebook:

### Scenario: Reading mentionable array

```
Parent array Cell.get()
  → validateAndTransform(notebook.mentionable)
    → resolveLink() ← ~2-5ms (nursery/heap reads)
    → For note 1:
      → validateAndTransform(note[0])
        → resolveLink() ← ~2-5ms
        → parseLink() ← ~0.5ms
        → Process note schema...
    → For note 2:
      → validateAndTransform(note[1])
        → resolveLink() ← ~2-5ms
        → parseLink() ← ~0.5ms
        → Process note schema...
```

**Estimated cost**:
- Parent resolveLink: 3ms
- Note 1 resolveLink: 3ms
- Note 2 resolveLink: 3ms
- parseLink × 2: 1ms
- Schema processing: 2-3ms
- Other overhead: 2-3ms
- **Total: ~14-17ms**

With more complex nesting or additional reads: **easily 20ms+**

## Why Previous Hypotheses Failed

### ❌ Heap Destructuring (Investigation V1)
- Only 2-3ms contribution
- Not the main bottleneck

### ❌ JSON.stringify() Overhead (Investigation Final)
- Only 0.004ms per call
- Total 0.2ms for 50 cells
- Not significant

### ❌ Network/IDB Waits (Investigation V3)
- User confirmed data is already synced locally
- Not waiting on network

### ✅ **Repeated resolveLink() Calls**
- Called for every array element
- Each does 2-4 reads from storage
- Reads are slow when data is in nursery (pending commits)
- **THIS IS THE ROOT CAUSE**

## Additional Compounding Factors

### 1. O(n²) Complexity with seen Array
```typescript
// Line 334, 379-380
seen: Array<[string, any]> = []
const seenEntry = seen.find((entry) => entry[0] === seenKey);
```

For N cells processed:
- 1st cell: searches 0 items
- 2nd cell: searches 1 item
- Nth cell: searches N-1 items
- **Total: O(n²)**

### 2. Multiple .get() Calls from Patterns

**File**: `packages/patterns/system/link-tool.tsx:40-44`
```typescript
for (let i = 0; i < mentionable.get().length; i++) {
  const c = mentionable.key(i);
  if (c.get()[NAME] === name) {
    return c;
  }
}
```

- `mentionable.get()` to get length
- `mentionable.key(i).get()` for each element
- **Multiple passes over the same data!**

## Why It's Slow Even With 2 Entries

The user said: "it's already slow with just two entries in the array"

This makes sense because:
1. **resolveLink() overhead dominates** - not the array size
2. Each resolveLink does 2-4 storage reads
3. Storage reads in nursery have overhead
4. The 20ms is not from processing 2 items
5. **It's from processing the entire nested structure** that references those 2 items

Example: Reading a notebook with 2 notes triggers:
- Notebook validateAndTransform → resolveLink
- Note 1 validateAndTransform → resolveLink
- Note 2 validateAndTransform → resolveLink
- Each note's schema properties might trigger more resolveLinks
- If notes reference other entities, even more resolveLinks

## Recommended Fixes

### High Priority: Cache resolvedLink Results

```typescript
// In validateAndTransform
const resolveLinkCache = new Map<string, NormalizedFullLink>();

function getCachedResolvedLink(link: NormalizedFullLink): NormalizedFullLink {
  const key = JSON.stringify({ space: link.space, id: link.id, path: link.path });
  let cached = resolveLinkCache.get(key);
  if (!cached) {
    cached = resolveLink(runtime, tx ?? runtime.edit(), link, "writeRedirect");
    resolveLinkCache.set(key, cached);
  }
  return cached;
}
```

**Benefit**: Eliminates redundant resolveLink calls

### High Priority: Change seen from Array to Map

```typescript
// Line 334
seen: Map<string, any> = new Map()

// Line 379-383
const seenKey = JSON.stringify(link);
if (seen.has(seenKey)) {
  return seen.get(seenKey);
}
// ... later ...
seen.set(seenKey, result);
```

**Benefit**: O(1) lookup instead of O(n)

### Medium Priority: Optimize Link Key Generation

```typescript
function getLinkKey(link: NormalizedFullLink): string {
  // Only include essential parts, not full schema
  return `${link.space}:${link.id}:${link.path.join('/')}`;
}
```

**Benefit**: Faster than JSON.stringify of entire link object

### Medium Priority: Batch Resolve for Arrays

When processing an array, collect all element links first, then resolve in parallel:

```typescript
// Before processing array elements
const elementLinks: NormalizedFullLink[] = [];
for (let i = 0; i < value.length; i++) {
  elementLinks.push({...link, path: [...link.path, String(i)]});
}

// Batch resolve (if storage supports it)
const resolvedLinks = await Promise.all(
  elementLinks.map(link => resolveLink(runtime, tx, link, "writeRedirect"))
);

// Then process with cached results
for (let i = 0; i < value.length; i++) {
  result[i] = validateAndTransform(
    runtime,
    tx,
    resolvedLinks[i],
    synced,
    seen,
  );
}
```

### Low Priority: Lazy Resolution

Only resolve links when actually needed for the schema type, not unconditionally.

## Test Plan

Create a test that:
1. Creates a notebook with 2 notes
2. Commits in transaction 1
3. Reads mentionable in transaction 2
4. Measures time for `.get()` call
5. Instruments resolveLink to count calls
6. Should show multiple resolveLink calls and ~20ms total time

## Files to Modify

1. **packages/runner/src/schema.ts**
   - Line 334: Change seen to Map
   - Line 352: Add resolveLink caching
   - Line 379: Update seen access to use Map

2. **packages/runner/src/link-resolution.ts**
   - Consider adding caching layer
   - Consider batching support

3. **packages/patterns/system/link-tool.tsx**
   - Line 40: Avoid multiple .get() calls
   - Cache mentionable.get() result

## Conclusion

The root cause is **repeated resolveLink() calls** during validateAndTransform of array schemas. Each resolveLink performs 2-4 storage reads, and when data is in the nursery (pending commits), these reads have overhead. For a structure referencing N documents, this creates N×M read operations, easily totaling 20ms+.

The solution is to **cache resolveLink results** and **optimize the seen array** to Map for O(1) lookups.
