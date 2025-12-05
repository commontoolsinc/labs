# Merkle Hashing Performance in Memory Package

This document describes the performance optimizations made to merkle hashing in
the memory package, what we learned, and decisions made along the way.

## Executive Summary

For a typical `setFact` operation with a 16KB payload:

- Total time: ~664µs
- ~71% spent in `refer()` calls (~470µs)
- Of that, **only ~10% is actual SHA-256 hashing**
- **90% of refer() time is structural overhead** (sorting, traversal,
  allocations)

## Background

The memory package uses `merkle-reference` to compute content-addressable hashes
for facts. Every `set`, `update`, and `retract` operation requires computing
merkle hashes for assertions, transactions, and payloads.

Initial profiling showed that hashing was a significant bottleneck, with
`refer()` calls dominating transaction time despite SQLite being very fast
(~20µs for 16KB inserts).

## How merkle-reference Works Internally

The library computes content-addressed hashes via:

```
refer(source) → toTree(source) → digest(tree) → Reference
```

### Algorithm Steps

1. **toTree()**: Recursively converts JS objects to a tree structure
   - WeakMap lookup per node (cache check)
   - Type dispatch (object, array, string, number, etc.)
   - For objects: UTF-8 encode all keys, sort alphabetically, encode each value

2. **digest()**: Computes hash of tree
   - WeakMap lookup per node (cache check)
   - Leaf nodes: hash directly
   - Branch nodes: collect child digests, fold into binary tree

3. **fold()**: Combines digests via binary tree reduction
   - Pairs of digests hashed together
   - Repeated until single root hash

### Object Encoding (The Expensive Part)

```javascript
// From merkle-reference map.js
for (const [name, value] of entries) {
  const key = builder.toTree(name);
  const order = typeof name === "string"
    ? String.toUTF8(name) // UTF-8 encode for sorting
    : builder.digest(key);

  attributes.push({ order, key, value: builder.toTree(value) });
}

// EXPENSIVE: Sort all attributes by byte comparison
return attributes.sort((left, right) => compare(left.order, right.order));
```

**Key insight**: Every object requires UTF-8 encoding all keys + sorting them.
This is required for deterministic merkle tree construction across different
systems, but it's expensive.

## Time Breakdown: Where Does refer() Time Go?

For a 16KB payload taking ~190µs:

| Operation                  | Time    | %   | Notes                          |
| -------------------------- | ------- | --- | ------------------------------ |
| Actual SHA-256 hashing     | 10-20µs | 10% | Native crypto on ~16KB         |
| Key sorting (objects)      | 40-50µs | 25% | UTF-8 encode + byte comparison |
| Object traversal + WeakMap | 30-40µs | 20% | ~2µs per node × ~15-20 nodes   |
| UTF-8 encoding overhead    | 20-30µs | 15% | TextEncoder on string keys     |
| Tree node allocations      | 30-40µs | 20% | Arrays for branches            |
| Fold operation             | 20-30µs | 10% | Binary tree reduction          |

**Key finding**: Only ~10% of time is actual hashing. The other ~90% is
structural overhead required for deterministic merkle tree construction.

## Why Nested Transaction Schema is Expensive

### Current Changes Structure (4 levels deep)

```typescript
{
  changes: {
    [of]: {                    // Level 1: entity URI
      [the]: {                 // Level 2: MIME type
        [cause]: {             // Level 3: cause reference
          is: { /* payload */ } // Level 4: actual data
        }
      }
    }
  }
}
```

### Full Transaction Tree (~7 nested objects)

```
Transaction (8 keys) → args (1 key) → changes (1 key) → entity (1 key)
  → mime (1 key) → cause (1 key) → is (payload with ~5 keys)
```

### Cost Per Object Level

Each nested object requires:

- WeakMap lookup (nodes): ~2µs
- WeakMap lookup (digests): ~2µs
- Sort operation: ~5-10µs (small), ~20-40µs (many keys)
- Array allocations: ~2-5µs

**Total per level: ~11-19µs**

For 7 nested objects: **~77-133µs just for structure overhead**

## setFact Operation Breakdown (~664µs)

| Component             | Time     | %     |
| --------------------- | -------- | ----- |
| refer(user assertion) | ~370µs   | 56%   |
| refer(commit)         | ~100µs   | 15%   |
| intern(transaction)   | ~60µs    | 9%    |
| SQLite (3-4 INSERTs)  | ~60-80µs | 9-12% |
| JSON.stringify        | ~8µs     | 1%    |
| Other overhead        | ~30-66µs | 5-10% |

### Why Two swap() Calls Per Transaction?

Each `setFact` triggers two `swap()` calls:

1. **User fact**: The actual assertion (~350-550µs)
2. **Commit record**: Audit trail containing full transaction (~100-150µs)

The commit record embeds the entire transaction for audit/sync purposes.

## Key Findings

### 1. SHA-256 Implementation Matters

`merkle-reference` uses `@noble/hashes` for SHA-256, which is a pure JavaScript
implementation. On modern CPUs with SHA-NI (hardware SHA acceleration),
`node:crypto` is significantly faster for raw hashing operations.

The exact speedup varies by payload size, but native crypto typically provides
2-10x improvement on the hash computation itself. The gap widens with payload
size because node:crypto uses native OpenSSL with hardware SHA-NI instructions.

Note: The end-to-end `refer()` time includes more than just hashing (sorting,
tree traversal, object allocation), so the overall speedup is smaller than the
raw hash speedup.

**Environment-Specific Behavior**: The memory package uses conditional crypto:

- **Browser environments** (shell): Uses `@noble/hashes` (pure JS, works
  everywhere)
- **Server environments** (toolshed, Node.js, Deno): Uses `node:crypto` for
  hardware-accelerated performance

This is detected at module load time via
`globalThis.document`/`globalThis.window` and uses dynamic import to avoid
bundler issues with `node:crypto` in browsers.

### 2. merkle-reference Caches Sub-objects by Identity

`merkle-reference` uses a `WeakMap` internally to cache computed tree nodes and
digests by object identity. When computing a merkle hash:

1. It recursively traverses the object tree
2. For each sub-object, it checks its WeakMap cache
3. If the same object instance was seen before, it reuses the cached digest
4. Only new/unseen objects require hash computation

This means:

- If you pass the **same object instance** multiple times, subsequent calls are
  very fast (WeakMap lookup ~300ns)
- If you pass a **new object with identical content**, it must recompute the
  full hash (different object identity = cache miss)

This is crucial for our use case: assertions contain a payload (`is` field). If
the payload object is reused across assertions, merkle-reference can skip
re-hashing it entirely:

```typescript
const payload = { content: "..." }; // 16KB

// First assertion - full hash computation for payload + assertion wrapper
refer({ the: "app/json", of: "doc1", is: payload }); // ~250µs

// Second assertion with SAME payload object - only hash the new wrapper
// The payload's digest is retrieved from WeakMap cache
refer({ the: "app/json", of: "doc2", is: payload }); // ~70µs (3.5x faster)
```

**Cache size:** The cache is automatically bounded by the garbage collector
because it uses `WeakMap`. When a source object is no longer referenced anywhere
in your application, its cache entry is automatically collected.

### 3. Order of refer() Calls Matters

In `swap()`, we compute hashes in a specific order to maximize cache hits:

```typescript
// IMPORTANT: Compute fact hash BEFORE importing datum. When refer() traverses
// the assertion/retraction, it computes and caches the hash of all sub-objects
// including the datum (payload). By hashing the fact first, the subsequent
// refer(datum) call in importDatum() becomes a ~300ns cache hit instead of a
// ~50-100µs full hash computation.
const fact = refer(source.assert).toString(); // Caches payload hash
const datumRef = importDatum(session, is); // Cache hit on payload!
```

### 4. intern(transaction) is Beneficial

The `intern(transaction)` call (~18µs) provides ~26% speedup on `refer(commit)`:

| Scenario       | refer(commit) | Total |
| -------------- | ------------- | ----- |
| Without intern | 116µs         | 146µs |
| With intern    | 58µs          | 108µs |

**Mechanism**: Interning ensures all nested objects share identity. When
`refer(assertion)` runs first, it caches all sub-object hashes. When
`refer(commit)` runs, it hits those caches because the assertion objects inside
the commit are the exact same instances.

### 5. Tree Builder API

`merkle-reference` exposes `Tree.createBuilder(hashFn)` which allows overriding
the hash function while preserving the merkle tree structure and caching
behavior.

```typescript
import { Tree } from "merkle-reference";
import { createHash } from "node:crypto";

const nodeSha256 = (payload: Uint8Array): Uint8Array => {
  return createHash("sha256").update(payload).digest();
};

const treeBuilder = Tree.createBuilder(nodeSha256);
treeBuilder.refer(source); // Uses node:crypto, same hash output
```

**Important:** Hashes are identical regardless of which SHA-256 implementation
is used. The tree structure and encoding are the same; only the underlying hash
function differs.

## What Didn't Work

### Small Object Cache for `{the, of}` Patterns

We tried caching `{the, of}` patterns (unclaimed references) using a
string-keyed Map:

```typescript
// REMOVED - actually hurt performance
const unclaimedCache = new Map<string, Reference.View>();
if (isUnclaimedPattern(source)) {
  const key = source.the + "\0" + source.of;
  // ...cache lookup...
}
```

This added ~20µs overhead per call due to:

- `Object.keys()` check to detect the pattern
- String concatenation for cache key
- Map lookup

merkle-reference's internal WeakMap is faster for repeated access to the same
object, and for unique objects there's no cache benefit anyway.

**However**: `unclaimedRef()` with a simple Map cache DOES work well because it
caches the final Reference, not intermediate objects. This saves the entire
`refer()` call (~29µs) for repeated `{the, of}` combinations.

## Current Implementation

### 1. Conditional crypto hashing (browser vs server)

Use merkle-reference's default `refer()` in browsers (which uses `@noble/hashes`
internally), upgrade to a custom TreeBuilder with `node:crypto` in server
environments for hardware acceleration:

```typescript
import * as Reference from "merkle-reference";

// Default to merkle-reference's built-in refer (uses @noble/hashes)
let referImpl: <T>(source: T) => Reference.View<T> = Reference.refer;

// In server environments, upgrade to node:crypto for better performance
const isBrowser = typeof globalThis.document !== "undefined" ||
  typeof globalThis.window !== "undefined";

if (!isBrowser) {
  try {
    // Dynamic import avoids bundler resolution in browsers
    const nodeCrypto = await import("node:crypto");
    const nodeSha256 = (payload: Uint8Array): Uint8Array => {
      return nodeCrypto.createHash("sha256").update(payload).digest();
    };
    const treeBuilder = Reference.Tree.createBuilder(nodeSha256);
    referImpl = <T>(source: T): Reference.View<T> => {
      return treeBuilder.refer(source) as unknown as Reference.View<T>;
    };
  } catch {
    // node:crypto not available, use merkle-reference's default
  }
}

export const refer = <T>(source: T): Reference.View<T> => {
  return referImpl(source);
};
```

**Key design points:**

- Browser: Uses `Reference.refer()` directly (merkle-reference uses
  @noble/hashes)
- Server: Creates custom TreeBuilder with `node:crypto` for ~1.5-2x speedup
- Dynamic import (`await import()`) prevents bundlers from resolving
  `node:crypto`
- Environment detection via `globalThis.document`/`globalThis.window`

### 2. Recursive object interning

To enable cache hits on identical content (not just identical object instances),
we intern objects recursively with a strong LRU cache:

```typescript
const INTERN_CACHE_MAX_SIZE = 10000;
const internCache = new Map<string, object>();
const internedObjects = new WeakSet<object>();

export const intern = <T>(source: T): T => {
  if (source === null || typeof source !== "object") return source;
  if (internedObjects.has(source)) return source; // Fast path

  // Recursively intern nested objects first
  const internedObj = Array.isArray(source)
    ? source.map((item) => intern(item))
    : Object.fromEntries(
      Object.entries(source).map(([k, v]) => [k, intern(v)]),
    );

  const key = JSON.stringify(internedObj);
  const cached = internCache.get(key);
  if (cached) return cached as T;

  // LRU eviction
  if (internCache.size >= INTERN_CACHE_MAX_SIZE) {
    const firstKey = internCache.keys().next().value;
    if (firstKey) internCache.delete(firstKey);
  }

  internCache.set(key, internedObj);
  internedObjects.add(internedObj);
  return internedObj as T;
};
```

### 3. unclaimedRef() caching

For the common `{the, of}` pattern (unclaimed facts), we cache the entire
Reference to avoid repeated `refer()` calls:

```typescript
const unclaimedRefCache = new Map<string, Reference<Unclaimed>>();

export const unclaimedRef = (
  { the, of }: { the: MIME; of: URI },
): Reference<Unclaimed> => {
  const key = `${the}|${of}`;
  let ref = unclaimedRefCache.get(key);
  if (!ref) {
    ref = refer(unclaimed({ the, of }));
    unclaimedRefCache.set(key, ref);
  }
  return ref;
};
```

## Optimization Opportunities

### Immediate Wins (No Breaking Changes)

#### 1. Use Shared Empty Arrays (~5-10µs savings)

```typescript
// Before
prf: []; // New array each time

// After
const EMPTY_ARRAY = Object.freeze([]);
prf: EMPTY_ARRAY; // Reuse, enables WeakMap cache hits
```

### Medium-Term (Requires Library Support)

#### 2. Pre-sort Transaction Keys (~20-30µs potential)

If merkle-reference detected pre-sorted keys, we could skip sorting:

```typescript
// Keys in alphabetical order
return {
  args: { changes }, // 'a' comes first
  cmd: "/memory/transact",
  exp: iat + ttl,
  iat,
  iss: issuer,
  prf: EMPTY_ARRAY,
  sub: subject,
};
```

**Note**: Currently merkle-reference doesn't detect this, so no benefit yet.

#### 3. Library Optimizations (Upstream Contributions)

- Skip sorting for single-key objects
- Cache UTF-8 encoded keys for common strings
- Detect pre-sorted keys

### Long-Term (Breaking Changes)

#### 4. Flatten Changes Structure (~50-70µs savings, 26-37% faster)

**Current** (4 levels):

```typescript
{ [of]: { [the]: { [cause]: { is } } } }
```

**Proposed** (flat array):

```typescript
[ { of, the, cause, is }, { of, the, cause, is }, ... ]
```

**Benefits**:

- Eliminates 2 object traversals (~40µs)
- Arrays don't require key sorting (~20-30µs)
- Simpler tree = fewer allocations (~10µs)

**Tradeoffs**:

- Breaking change to transaction format
- Larger serialized size (repeated keys)
- Less convenient for lookups

#### 5. Skip Commit Records for Single-Fact Transactions (~100-150µs savings)

Currently every transaction writes a commit record for audit trail. For
single-fact transactions, this could be optional.

**Tradeoff**: Loses transaction-level audit trail.

## Realistic Expectations

| Optimization Level     | Expected Time | Improvement |
| ---------------------- | ------------- | ----------- |
| Current                | 664µs         | baseline    |
| With immediate wins    | ~640µs        | 4%          |
| With all non-breaking  | ~600µs        | 10%         |
| With flattened Changes | ~540µs        | 19%         |
| With skip commit       | ~440µs        | 34%         |

**Fundamental floor**: Object traversal + deterministic ordering will always
consume ~100-120µs for nested structures. This is inherent to
content-addressing.

## Performance Results

### Core Operations (16KB payloads)

| Operation         | Time   | Throughput |
| ----------------- | ------ | ---------- |
| get fact (single) | ~65µs  | 15,000/s   |
| set fact (single) | ~664µs | 1,500/s    |
| update fact       | ~756µs | 1,320/s    |
| retract fact      | ~436µs | 2,300/s    |

### Component Breakdown

| Component                | Time    | Notes                      |
| ------------------------ | ------- | -------------------------- |
| Raw SQLite INSERT        | 20-35µs | Hardware floor             |
| JSON.stringify 16KB      | ~8µs    |                            |
| refer() on 16KB          | ~190µs  | Payload only               |
| refer() on assertion     | ~470µs  | Includes 16KB payload      |
| refer() small object     | ~34µs   | {the, of} pattern          |
| unclaimedRef() cache hit | ~0.4µs  | Returns cached Reference   |
| intern() cache hit       | <1µs    | Returns canonical instance |

## Benchmarks Reference

Run benchmarks with:

```bash
deno task bench
```

Key isolation benchmarks to watch:

- `refer() on 16KB payload (isolation)`: ~190µs
- `refer() on assertion (16KB is + metadata)`: ~470µs
- `memoized: 3x refer() same payload (cache hits)`: ~24µs
- `refer() small {the, of} - with intern (cache hit)`: ~0.4µs

## Architecture Notes

### Why Content-Addressing?

merkle-reference provides:

- Deduplication (same content = same hash)
- Integrity verification
- Distributed sync compatibility
- Deterministic references

**Cannot be eliminated** without breaking the architecture.

### Deterministic Ordering Requirement

For merkle trees to produce consistent hashes across different systems, object
keys must be sorted deterministically. This is why:

- Every object incurs sorting cost
- UTF-8 encoding needed for byte-comparison
- This overhead is fundamental to the approach

## Current Optimizations Applied

1. **Conditional crypto** (node:crypto in server, @noble/hashes in browser):
   ~1.5-2x speedup on hashing in server environments, while maintaining browser
   compatibility
2. **Recursive object interning**: ~2.5x on shared content
3. **Prepared statement caching**: ~2x on queries
4. **Batch label lookups**: Eliminated N queries
5. **Fact hash ordering**: Payload hash reused from assertion traversal
6. **Stored fact hashes**: Avoid recomputing in conflict detection
7. **unclaimedRef() caching**: ~62x faster for repeated {the, of} patterns
8. **intern(transaction)**: ~26% faster commits via cache hits

## Files Reference

- `reference.ts`: TreeBuilder with conditional crypto (noble/node:crypto),
  intern() function
- `fact.ts`: Fact.assert(), unclaimedRef() caching
- `space.ts`: swap(), commit(), transact() - core write path
- `transaction.ts`: Transaction structure definition
- `changes.ts`: Changes structure (candidate for flattening)
