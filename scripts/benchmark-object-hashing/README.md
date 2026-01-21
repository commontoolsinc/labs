# Object Hashing Benchmark

This benchmark compares `merkle-reference` against various alternatives for
stable object hashing, where "stable" means that minor non-semantic differences
like property order don't change the hash.

## What's Tested

### Hashing Strategies

1. **merkle-reference** with different SHA-256 implementations:
   - `noble` - @noble/hashes (pure JS, default)
   - `hash-wasm` - WebAssembly SHA-256 (~3x faster than pure JS)
   - `node:crypto` - Native crypto (Deno/Node only, hardware accelerated)

2. **dag-cbor** - IPFS/IPLD canonical encoding (used in production by IPFS):
   - `dag-cbor+sha256` - DAG-CBOR encoding with SHA-256
   - `dag-cbor+blake2b` - DAG-CBOR encoding with BLAKE2b-256 (faster hash)
   - `dag-cbor+CID` - Full IPLD Content Identifier (CIDv1)

3. **object-hash** - Popular npm package for object hashing

4. **hash-it** - Fast object hashing library

5. **stable-stringify+noble** - fast-json-stable-stringify + @noble/hashes
   SHA-256

6. **JSON.stringify+noble (UNSTABLE)** - Baseline using regular JSON.stringify
   (NOT stable for property order)

### Test Data Structures

**Small structures:**

- Simple object: `{ a: 1, b: 2, c: 3 }`
- Nested object: `{ a: { b: { c: 1 } } }`
- Array: `[1, 2, 3, 4, 5]`
- Mixed: `{ a: [1, 2], b: { c: 3 }, d: "hello" }`

**Large structures:**

- Wide (1000 properties)
- Deep (100 levels of nesting)
- Large array (1000 objects)
- Sparse array (1000 elements, mostly empty)
- Complex nested structure (100 users with profiles)

## Running the Benchmarks

### Deno

```bash
# Run in Deno environment
deno run --allow-net --allow-read --allow-env scripts/benchmark-object-hashing/main.ts

# Or use the wrapper
deno run --allow-net --allow-read --allow-env scripts/benchmark-object-hashing/deno.ts
```

### Headless Chrome

```bash
# Run in headless Chrome browser
deno run --allow-net --allow-read --allow-env --allow-run --allow-write scripts/benchmark-object-hashing/chrome.ts
```

### Browser (Manual)

Open `scripts/benchmark-object-hashing/browser.html` in any browser to run the
benchmark interactively.

## Dependencies

All dependencies are loaded from esm.sh at runtime, so no packages need to be
added to the repository:

- merkle-reference@2.2.0
- @ipld/dag-cbor@9.2.1
- multiformats@13.3.2 (CID and multihash support)
- object-hash@3.0.0
- hash-it@6.0.0
- fast-json-stable-stringify@2.1.0
- @noble/hashes@1.4.0 (sha256 and blake2b)
- hash-wasm@4.11.0

## Output

The benchmark produces:

1. **Stability Test** - Verifies that property order doesn't affect the hash
2. **Detailed Results** - Time and ops/sec for each strategy on each test case
3. **Summary Table** - Side-by-side comparison of all strategies

Example output:

```
=== Object Hashing Benchmark ===

Environment: Deno

## Stability Test (property order independence)

merkle-reference[noble]                  ✓ STABLE
merkle-reference[hash-wasm]              ✓ STABLE
merkle-reference[node:crypto]            ✓ STABLE
dag-cbor+sha256                          ✓ STABLE
dag-cbor+blake2b                         ✓ STABLE
dag-cbor+CID                             ✓ STABLE
object-hash                              ✓ STABLE
hash-it                                  ✓ STABLE
stable-stringify+noble                   ✓ STABLE
JSON.stringify+noble (UNSTABLE)          ✗ UNSTABLE

## small/simple

merkle-reference[noble]                  45.23ms (221K ops/sec)
merkle-reference[hash-wasm]              32.15ms (311K ops/sec)
merkle-reference[node:crypto]            28.94ms (345K ops/sec)
dag-cbor+sha256                          35.67ms (280K ops/sec)
dag-cbor+blake2b                         31.45ms (318K ops/sec)
object-hash                              38.67ms (258K ops/sec)
...

=== SUMMARY (ops/sec - higher is better) ===

Strategy                                simple      nested      array       ...
--------------------------------------------------------------------------------
merkle-reference[noble]                 221K        198K        245K        ...
merkle-reference[hash-wasm]             311K        287K        356K        ...
dag-cbor+sha256                         280K        255K        290K        ...
dag-cbor+blake2b                        318K        289K        330K        ...
...
```

## Interpretation

- **ops/sec** - Higher is better
- **Stability** - Only strategies marked as STABLE should be considered for
  production use where property order independence is required
- **Small vs Large** - Small structures test overhead and simple cases; large
  structures test scalability
- **Deep vs Broad** - Deep tests recursion handling; broad tests property
  iteration performance
- **Sparse arrays** - Tests handling of undefined/empty array elements

## Why DAG-CBOR?

DAG-CBOR (Directed Acyclic Graph - Concise Binary Object Representation) is
specifically designed for content-addressable data and is battle-tested in
production by IPFS and related systems. Key advantages:

- **Canonical encoding**: Guaranteed stable hashing (property order normalized)
- **Binary format**: More compact than JSON-based approaches
- **IPLD ecosystem**: Interoperability with IPFS, Filecoin, and other systems
- **Link support**: Native support for content-addressed links between objects
- **Production proven**: Used at scale in decentralized systems

DAG-CBOR could be a simpler alternative to `merkle-reference` if you need stable
object hashing but not the full Merkle tree structure.

## Current Usage

The codebase currently uses `merkle-reference` with environment-specific SHA-256
implementations configured in `packages/memory/reference.ts`:

- Server (Deno): `node:crypto` (hardware accelerated)
- Browser: `hash-wasm` (WASM, ~3x faster than pure JS)
- Fallback: `@noble/hashes` (pure JS, works everywhere)
