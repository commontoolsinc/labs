# Merkle Hashing Performance in Memory Package

This document describes the performance optimizations made to merkle hashing in
the memory package, what we learned, and decisions made along the way.

## Background

The memory package uses `merkle-reference` to compute content-addressable hashes
for facts. Every `set`, `update`, and `retract` operation requires computing
merkle hashes for assertions, transactions, and payloads.

Initial profiling showed that hashing was a significant bottleneck, with
`refer()` calls dominating transaction time despite SQLite being very fast
(~20µs for 16KB inserts).

## Key Findings

### 1. SHA-256 Implementation Matters

`merkle-reference` uses `@noble/hashes` for SHA-256, which is a pure JavaScript
implementation. On modern CPUs with SHA-NI (hardware SHA acceleration),
`node:crypto` is significantly faster for raw hashing operations.

The exact speedup varies by payload size, but native crypto typically provides
2-10x improvement on the hash computation itself. The gap widens with payload
size because node:crypto uses native OpenSSL with hardware SHA-NI instructions.

Note: The end-to-end `refer()` time includes more than just hashing (JSON
encoding, tree traversal, object allocation), so the overall speedup is smaller
than the raw hash speedup.

### 2. merkle-reference Caches Sub-objects by Identity

`merkle-reference` uses a `WeakMap` internally to cache computed tree nodes and
digests by object identity. When computing a merkle hash:

1. It recursively traverses the object tree
2. For each sub-object, it checks its WeakMap cache
3. If the same object instance was seen before, it reuses the cached digest
4. Only new/unseen objects require hash computation

This means:

- If you pass the **same object instance** multiple times, subsequent calls are
  very fast (WeakMap lookup)
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

**Important:** This caching is built into `merkle-reference` - we don't
implement it ourselves. We simply use `Tree.createBuilder()` which inherits this
behavior. The key is ensuring callers reuse payload objects when possible.

**Cache size:** The cache is automatically bounded by the garbage collector
because it uses `WeakMap`. When a source object is no longer referenced anywhere
in your application, its cache entry is automatically collected. No manual
eviction, no memory leaks, and the cache scales naturally with your
application's memory usage.

### 3. Tree Builder API

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

## Previous Implementation

The original `reference.ts` used an LRU cache with `JSON.stringify` keys:

```typescript
// PREVIOUS APPROACH - replaced
const referCache = new Map<string, Reference.View>();

export const refer = <T>(source: T): Reference.View<T> => {
  const key = JSON.stringify(source);
  let ref = referCache.get(key);
  if (ref) return ref;

  ref = Reference.refer(source); // Uses @noble/hashes internally
  referCache.set(key, ref);
  return ref;
};
```

Problems with this approach:

1. `JSON.stringify` on every call (~8µs for 16KB)
2. String-keyed Map lookup is slower than WeakMap
3. Still used slow @noble/hashes for actual hashing
4. Memory overhead from storing stringified keys

The new approach uses merkle-reference's built-in WeakMap caching and swaps to
node:crypto, eliminating all of these issues.

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

### Content-Based Object Interning (Revisited)

Initially we tried interning objects by JSON content but removed it because:

1. `JSON.stringify` on 16KB payloads takes ~8µs overhead
2. For an append-only database, most top-level payloads are unique

However, we later realized that **recursive interning** solves this: even when
top-level objects are unique (different IDs), their **nested content** is often
shared. By interning recursively, nested objects get deduplicated:

```typescript
// Objects with unique IDs but shared nested content
{ id: "uuid-1", content: { large: "data..." } }
{ id: "uuid-2", content: { large: "data..." } }

// After recursive interning, both objects share the same `content` instance
// merkle-reference's WeakMap cache hits on the shared content
```

The key insight: the ~20µs interning overhead is paid once, but saves ~110µs
per subsequent reference to shared content. This is now implemented in
`Fact.assert()` and `Fact.unclaimed()`.

## Final Implementation

The implementation has two parts:

### 1. Native crypto hashing

Swap the hash function to use node:crypto:

```typescript
import * as Reference from "merkle-reference";
import { createHash } from "node:crypto";

const nodeSha256 = (payload: Uint8Array): Uint8Array => {
  return createHash("sha256").update(payload).digest();
};

const treeBuilder = Reference.Tree.createBuilder(nodeSha256);

export const refer = <T>(source: T): Reference.View<T> => {
  return treeBuilder.refer(source);
};
```

### 2. Recursive object interning

To enable cache hits on identical content (not just identical object instances),
we intern objects recursively:

```typescript
const internCache = new Map<string, WeakRef<object>>();
const finalizationRegistry = new FinalizationRegistry((key: string) => {
  internCache.delete(key);
});

export const intern = <T>(source: T): T => {
  if (source === null || typeof source !== "object") return source;

  // Recursively intern nested objects first
  const internedObj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    internedObj[k] = intern(v);
  }

  const key = JSON.stringify(internedObj);
  const cached = internCache.get(key)?.deref();
  if (cached) return cached as T;

  internCache.set(key, new WeakRef(internedObj));
  finalizationRegistry.register(internedObj, key);
  return internedObj as T;
};
```

This is integrated into `Fact.assert()` and `Fact.unclaimed()` so payloads are
automatically interned. The benefit: when two objects have the same nested
content (even if they're different object instances), the nested objects become
the same instance, enabling merkle-reference's WeakMap cache to hit.

Example:
```typescript
// Two facts with unique IDs but shared content
const fact1 = Fact.assert({ the, of: "doc1", is: { data: "shared..." } });
const fact2 = Fact.assert({ the, of: "doc2", is: { data: "shared..." } });

// fact1.is === fact2.is (same object due to interning)
// refer(fact2) is 2.5x faster because `is` payload hits WeakMap cache
```

This gives us:

- **Faster hashing** via native crypto (exact speedup depends on payload size)
- **~2.5x speedup** when content is shared across facts (interning)
- **~62x speedup** for repeated small objects like `{the, of}` patterns
- **Identical hashes** to the default implementation
- **Automatic GC** of interned objects via WeakRef + FinalizationRegistry

## Performance Results

### Core Operations (16KB payloads)

| Operation         | Time   | Throughput |
| ----------------- | ------ | ---------- |
| get fact (single) | 58µs   | 17,200/s   |
| set fact (single) | 786µs  | 1,270/s    |
| update fact       | 758µs  | 1,320/s    |
| retract fact      | 394µs  | 2,540/s    |

### Component Breakdown

| Component              | Time   | Notes                            |
| ---------------------- | ------ | -------------------------------- |
| Raw SQLite INSERT      | 17-27µs| Hardware floor                   |
| JSON.stringify 16KB    | 7µs    |                                  |
| refer() on 16KB        | 170µs  | Payload only                     |
| refer() on assertion   | 250µs  | Includes 16KB payload (p75)      |
| refer() small object   | 29µs   | {the, of} pattern                |
| intern() cache hit     | <1µs   | Returns canonical instance       |

## Recommendations for Callers

1. **Interning is automatic** - `Fact.assert()` and `Fact.unclaimed()` now
   intern payloads automatically. Identical content will share object identity.

2. **Batch operations** when possible - amortizes fixed costs and improves
   throughput.

3. **For manual refer() calls**, consider using `intern()` on payloads if you
   expect repeated identical content across multiple references.

## Future Considerations

- If `merkle-reference` adds native hash function support, we could remove our
  wrapper entirely
- WebAssembly SHA-256 implementations might close the gap with node:crypto while
  remaining portable
- For very large payloads (>256KB), streaming hash computation could reduce
  memory pressure
