---
status: historical
created: 2026-08-17
archived: 2026-08-17
reason: "Investigation of a pattern-test CI flake traced to schema-memo keys carrying an inline document's whole id."
---

# The traversal that spent thirty seconds building map keys, August 2026

## Result

`packages/patterns/record-module-fields.test.tsx` failed one Pattern Unit
Tests shard with `Action at index 1 timed out after 180000ms`, while every
assertion either side of that action passed. The test file took 250 seconds.

The action never settled because two schema traversals of one document took
130 seconds and 61 seconds between them. Both were reported by the
`slow-traverse` warning, both on the same document, and both walking it the
same way: 8,453 schema visits, 12 levels of depth, and three or four hits in
a memo holding thousands of entries.

The document is an inline one: its id is a data URI, so it carries its own
content, and it ran to 64,330 characters. The schema memo builds one key per
schema visit out of the visited document's address, and the address
contributed the id in full. Reading a freshly joined string as a map key
copies it out flat and hashes every character, so each of those 8,453 visits
paid for the whole document. One traversal built 524 million characters of
key material.

An id longer than 128 characters now reaches the key as a digest, computed
once per id and cached.

## How it was measured

The failing traversal reproduces outside the pattern test. `CF_TRAVERSE_CAPTURE`
recorded the test's traversals — 1,339 invocations over 492 documents — and
`test/traverse-replay/replay.ts` replayed them with `collectLatency`. Invocation
360 took 22.6 seconds on the machine used here and reported the same counters as
the continuous-integration run, so the work is deterministic and the difference
between 22 seconds and 130 is the machine.

`test/traverse-replay/profile-driver.ts` sampled that one invocation over the
V8 inspector. It put 98.8% of the time in `traverseWithSchema` itself rather
than in anything it calls:

```text
13424ms  98.8%  traverseWithSchema @ runner/src/traverse.ts
   58ms   0.4%  traverseAndAddBaseIdToRelativeLinks @ runner/src/data-uri.ts
   20ms   0.1%  _traverseWithSchemaInner @ runner/src/traverse.ts
```

Self time in that function, with its callees accounted separately, leaves the
memo lookup as the candidate: `Map.get` and `Map.set` are native, so their cost
lands on the JavaScript frame that calls them.

Two rounds of temporary counters confirmed it and ruled out the other suspect.
Schema hashing was not the cost — the whole traversal computed 29 hashes and
spent 4 milliseconds on them, because `hashSchema()` caches by identity for
deep-frozen schemas. Key building was: 15,852 keys totalling 524,272,409
characters, of which 7,972 keys carried one 64,330-character id.

## Why the id is that long

A data URI names the value it holds. A pattern's UI inlines a component and
everything under it as one document, so a component holding a list — an emoji
picker's entries, in this case — becomes a document whose id spells out the
whole list. The traversal then walks every node of that document under that one
id, with only the path differing from visit to visit.

The two costs multiply. A document that grows has both more nodes to visit and
a longer id for each visit to carry, so the work grows with the product.

## What the fix bought

Measured on the captured traversal and the pattern test that produced it:

| | Before | After |
| --- | ---: | ---: |
| Full fixture replay | 34,178 ms | 133 ms |
| Slowest single traversal | 22,645 ms | 16 ms |
| `record-module-fields.test.tsx` | 44 s | 6 s |

The pattern test now passes under the 5-second-per-action budget a local `cf
test` gives it, rather than needing the 180-second budget continuous
integration passes and occasionally overrunning that too.

The replay goldens did not move, which is what says the traversal returns the
same results and issues the same reads as before. The counters in the
`slow-traverse` report did not move either: the visit count was never the
problem.

## What the tests pin

Two tests in `packages/runner/test/traverse.test.ts`, under
`SchemaObjectTraverser schema memo keys`. They traverse a document whose id is
a real data URI of about 22 KB and inspect the shared memo the traversal
filled:

- No key the traversal leaves behind is longer than a thousand characters.
- The key material per visit holds steady as the document grows, which states
  the shape of the problem rather than one measurement of it.

Neither test reads a clock, so neither depends on the speed of the machine
running it. Both fail on the code as it stood: every key carried the whole id,
at 22,631 characters for the first and 22,629 characters per visit against
5,667 for a document a quarter the size for the second.
