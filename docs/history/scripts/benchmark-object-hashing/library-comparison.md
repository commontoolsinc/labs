---
status: historical
created: 2026-03-17
archived: 2026-08-07
reason: "Record of the March 2026 stable-object-hashing library comparison; the
  benchmark rig it summarizes was deleted once the repository moved to its own
  hasher."
---

# Object hashing library comparison, March 2026

This is the surviving record of `scripts/benchmark-object-hashing/`, a one-time
benchmark added in March 2026 to choose a stable object hashing strategy. Here,
"stable" means that differences that carry no meaning — most importantly the
order in which an object's properties happen to be written — do not change the
hash.

The rig itself has been deleted. The question it was built to answer is settled:
the repository hashes values with its own hasher, in
`packages/data-model/src/value-hash.ts` on top of `packages/content-hash`, and
none of the libraries compared below are dependencies any more. Ongoing
measurement of hashing performance lives in the benchmarks that ship inside
those packages, `packages/data-model/bench/hashing.bench.ts` and
`packages/content-hash/bench/sha256.bench.ts`.

## What was compared

Ten strategies, at the library versions current in early 2026, each loaded from
`esm.sh` at run time so that nothing had to be added to the repository's
dependencies:

- `merkle-reference` 2.2.0, paired with three different SHA-256
  implementations: `@noble/hashes` 1.4.0 (pure JavaScript, and the library's own
  default), `hash-wasm` 4.11.0 (WebAssembly), and `node:crypto` (the platform's
  native implementation, available in Deno and Node but not in a browser).
- DAG-CBOR, the canonical binary encoding used by IPFS and IPLD, via
  `@ipld/dag-cbor` 9.2.1 and `multiformats` 13.3.2, in three forms: encoded and
  hashed with SHA-256, encoded and hashed with BLAKE2b-256, and encoded into a
  full IPLD content identifier (CIDv1).
- `object-hash` 3.0.0.
- `hash-it` 6.0.0.
- `fast-json-stable-stringify` 2.1.0 followed by a SHA-256 from
  `@noble/hashes`.
- `JSON.stringify` followed by the same SHA-256, included as a deliberately
  unstable baseline rather than as a candidate.

Each strategy was run against small structures (a flat object, a nested object,
an array, and a mixture of the three) and large ones (an object with a thousand
properties, an object nested a hundred levels deep, an array of a thousand
objects, a sparse array of a thousand mostly-absent elements, and a hundred user
records with nested profiles). Small structures were there to measure per-call
overhead, large ones to measure how each strategy scaled; the deep and wide
cases separated the cost of recursion from the cost of iterating properties.

The benchmark existed in three parallel implementations of the same test data
and the same strategy table — one for Deno, one hand-ported to Node, and one
written inline in a page that could be opened in a browser or driven through
headless Chrome — because the winning strategy had to be fast in all three
places, and the native SHA-256 available to a server is not available to a
browser.

## What it found

Every candidate except the `JSON.stringify` baseline was stable: reordering an
object's properties left the hash unchanged. That baseline was included to
demonstrate the failure it names, and it failed as expected.

On performance, the ordering was consistent rather than close. For
`merkle-reference`, the choice of SHA-256 implementation mattered more than
anything else: native `node:crypto` was fastest where it was available,
WebAssembly through `hash-wasm` was the fastest option a browser could reach and
ran several times quicker than pure JavaScript, and `@noble/hashes` was the slow
but universally available floor. DAG-CBOR with BLAKE2b was competitive with the
WebAssembly SHA-256 path, and DAG-CBOR with SHA-256 sat between the pure
JavaScript and WebAssembly results.

The numeric tables printed in the benchmark's own documentation were an
illustrative sample of the output format, not recorded measurements from a
particular machine. No run of this benchmark was ever committed, so the record
of what it produced is the shape of the result and its ordering, not a set of
figures that can be compared against today's hasher.

## What it concluded

Two conclusions came out of the comparison, and both are visible in the code
that followed it.

The first is that the SHA-256 implementation should be chosen per environment
rather than fixed once: native where the platform offers it, WebAssembly in a
browser, and pure JavaScript as the fallback that works everywhere. That is the
arrangement the repository shipped, and it outlived `merkle-reference` itself.

The second is that a full Merkle tree was more structure than stable hashing
needed. The benchmark's documentation recorded DAG-CBOR as the simpler
alternative worth considering for anyone who wanted stable hashing of a value
without the link structure of a Merkle reference: a canonical binary encoding,
more compact than a JSON-based one, with property order normalized by the format
rather than by the caller. The repository went further in the same direction and
defined its own canonical byte encoding, specified in
`docs/specs/space-model-formal-spec/2-hash-byte-format.md`, which drops both the
Merkle structure and the IPLD content-identifier wrapper while keeping the
property-order normalization that made every candidate here stable.
