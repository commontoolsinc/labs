---
status: historical
created: 2026-10-17
archived: 2026-10-17
reason: "Measurements, October 2026, of the value hasher feeding a deep-frozen container it has walked from its kept bytes: a resolved definition view hashes in a tenth of the time, a thirty-message FabriChat room's cold load walks 40% fewer bytes, and the hashing samples move by about 2% of the worker's busy time, because the load hashes 107 thousand roots and their per-hash overhead is most of what hashing costs."
---

# The hasher's kept bytes of deep-frozen containers on a FabriChat room's cold load, October 2026

The definition-view memo record
([`2026-10-16-fabrichat-definition-view-memo.md`](2026-10-16-fabrichat-definition-view-memo.md))
found that interning a resolved definition view `{ ...body, $defs }` hashes
its document's whole definition map again, that a thirty-message room's cold
load walks 28 million characters of maps it has walked before by identity,
and that the hash is one SHA-256 over the tree's type-tagged bytes, so no
cached hash of a sub-object can shorten it. What a hasher can reuse is the
sub-object's encoded bytes. This record is what that reuse is worth.

## The change

`ValueHasher` keeps, by identity in a `WeakMap`, the type-tagged encoding of a
deep-frozen array or plain object it walks below the root, and feeds a
container it reaches again with one `update()` of those bytes in place of the
walk. The hash is unchanged: the bytes fed are the bytes the walk would feed,
and `test/hash-conformance.test.ts` and its fixture pass as they were.

Three rules bound what is kept. A container is kept only when its encoding is
256 bytes to 1 MiB long; one found outside that range is marked, so the next
walk of it is not captured again. One capture runs at a time, so a deep-frozen
container inside a captured one is part of the outer's bytes and not kept on
its own. And a container whose walk fed a cycle reference is marked and never
kept. That last rule is stricter than the memo record expected, which named
only a reference to an ancestor outside the container. It has to be: two
frozen objects referring to each other are each other's ancestors depending
on the root, and what `b` feeds under `{ x: b }` is `a`'s whole encoding and a
reference back to `b`, while under `{ x: a }` it is a one-hop reference to
`a`. A graph with a cycle encodes differently by which member the walk reaches
first, so position independence holds for acyclic sub-objects alone.
`packages/data-model/test/value-hash/frozen-container-bytes.test.ts` pins the
reuse, the composition of kept bytes inside a larger kept container, the size
floor, the cycle rule, and that a mutable container is walked every time.

`getContainersHashed()` counts walks, so a container fed from its kept bytes
is not counted. Every test reading it as evidence of a whole-value hash still
passes.

## Micro-benchmarks

The machine was at a one-minute load between 30 and 40 throughout, so ratios
are what the figures are for.

The record's benchmark, re-run against both trees: 200 distinct mutable views
`{ ...body, $defs: map }` over one deep-frozen map, time per view (best of
seven rounds) and containers walked per view.

| map | before | after |
| --- | ---: | ---: |
| 20 definitions, 6,421 JSON characters | 199 µs, 164 containers | 16 µs, 3 containers |
| 120 definitions, 38,801 JSON characters | 711 µs, 964 containers | 43–88 µs, 3 containers |

The size floor, from a fresh mutable root `{ i, sub }` per hash where `sub`
is a flat object of `n` short entries, in nanoseconds per hash: a mutable
`sub`, a deep-frozen `sub` walked before, and a deep-frozen `sub` on its first
walk. With the floor at zero the hit costs about the same at every size, so
what a hit saves is the walk, and under about 250 bytes the walk is within
2 µs of the root's own overhead.

| entries | bytes | mutable | hit, floor 0 | first walk, floor 0 | hit, floor 256 |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 17 | 2,767 | 2,223 | 3,758 | 2,219 |
| 4 | 62 | 4,078 | 3,137 | 8,611 | 2,647 |
| 8 | 122 | 4,176 | 2,636 | 10,009 | 3,931 |
| 16 | 248 | 6,718 | 2,831 | 10,792 | 5,225 |
| 32 | 504 | 11,920 | 2,631 | 14,932 | 2,707 |
| 64 | 1,016 | 19,137 | 2,700 | 21,736 | 3,082 |
| 128 | 2,068 | 32,028 | 3,561 | 40,333 | 3,038 |

The first-walk column is why a container found too small is marked rather
than captured again: capturing copies every byte fed, and at these sizes that
doubled the walk. `bench/hashing.bench.ts` carries the `shared-sub-object`
groups, whose 75th percentiles were 6.7 against 6.3 µs at 4 keys, 11.4
against 8.9 at 16, 32.0 against 6.2 at 64 and 105.8 against 9.5 at 256.

## The room's cold load

The rig is the sink-fires record's: a toolshed with server execution baked
off over a copy of the fresh store, a dev shell per arm, the thirty-message
room fixture, and the worker profiled from sign-in to the room rendered. The
before arm is a detached worktree of the base commit. Two interleaved pairs,
compared by samples and counts; the machine's load rose from 37 to 115 during
the four loads, so the sample totals are noisy. Per load, in all four:
1,663 list-child syncs, 285 cell syncs, 615 `prepareCfc`, 190 native commits,
1,157 action runs, no conflicts.

| busy samples | before 1 | after 1 | before 2 | after 2 |
| --- | ---: | ---: | ---: | ---: |
| busy | 10,660 | 9,461 | 9,975 | 10,874 |
| `hashOfInternal` | 1,289 | 1,115 | 1,310 | 1,382 |
| `internSchemaReturningSchemaAndHash` | 786 | 619 | 806 | 785 |
| sink action, callback | 2,140 | 1,379 | 1,735 | 1,549 |

Hashing stays at 12 to 13% of busy. A diagnostic load of the after arm, with
a counter on every container the hasher reaches and every `update()`, says
why. Per load:

| | floor 256 | floor 128 |
| --- | ---: | ---: |
| hashes (roots fed) | 107,591 | 107,512 |
| of which deep-frozen roots | 35,254 | 35,175 |
| containers fed from kept bytes | 6,757 | 9,011 |
| bytes those fed | 17.6 M | 18.1 M |
| containers kept after a capture | 8,956 | 19,282 |
| bytes retained by those | 13.1 M | 15.1 M |
| captures found too small | 24,679 | 13,246 |
| walks of a container marked not kept | 32,768 | 22,822 |
| walks inside a capture | 283,531 | 281,426 |
| walks of a frozen container nobody proved deep-frozen | 11,716 | 11,714 |
| walks of a mutable container | 115,325 | 115,325 |
| `update()` calls | 2.86 M | 2.80 M |
| bytes walked | 26.8 M | 26.3 M |

The kept bytes serve 6,757 of the load's container feeds and take 17.6 of the
44.4 million bytes the load would otherwise walk, 40%. What that is worth in
time is bounded by what the walks cost: 2.86 million `update()` calls at well
under a microsecond each is a few hundred milliseconds, against 107,591
hashes whose per-hash overhead (the deep-frozen check, the hasher, the digest,
the `FabricHash`) is of the same order. So the walks the cache removes are
about 2% of busy, which is inside the noise of two pairs on a loaded machine.
Lowering the floor to 128 bytes keeps 10 thousand more containers for 2 MB
more retained and 2% fewer `update()` calls; the floor stays at 256.

The retained bytes are the measure to watch: 13 MB per load, held for as long
as the frozen containers live, which for interned schemas is the session. A
container captured as a whole and its sub-containers captured from other
roots overlap, so that figure is above the encoded size of the distinct
containers kept. Nothing bounds the total; the `WeakMap` dies with its keys,
and a bound would take a count of live kept bytes decremented through a
`FinalizationRegistry`.

## What hashing is, by caller

The after profile's 1,115 `hashOfInternal` samples by entry point: 654 under
`hashOf`, nearly all schema interning from a dozen call sites (resolving
references under the join, `memoizedStripAs` under alias sanitizing,
verifying arrived schema documents, handler schemas, the superset selector,
pruning definitions), and 451 under `hashStringOf`: snapshot ids under
`createElement`, watch ids and selector identities under `#refreshWatchSet`,
`valueEqual` under writes, `#viewRefHash` under argument reads, child keys
under the render. The 72,337 hashes of a mutable root per load are those, and
each pays the per-hash overhead whatever its size. Fewer hashes, rather than
cheaper walks, is the lever left in hashing.
