---
status: historical
created: 2026-08-21
archived: 2026-08-21
reason: "Report on the deep-schema-traversal work: the narrow reads that stopped projecting whole piece results, and the read path's memo."
---

# The traversals a narrow read did not need, August 2026

## Result

Two changes, each measured on a board-shaped piece built and read in process.

`cf piece verbs` no longer walks the board. It projected the whole piece
result three times to produce a listing of top-level names; on a forty-row
board that was 5,070 schema visits, and the count grew linearly with the
board. It is now thirteen visits at every size, and 1.2 to 1.9ms against a
baseline that runs from 5.6ms to 15.5ms as the board grows.

A whole-result `Cell.get()` — what a client holding a result live pays — does
73% less traversal work, because the read path's memo was enabled and keyed
with the link. On a forty-row union-heavy board the traversal fell from 4,808
schema visits to 1,288, and the read from 14.07ms to 4.11ms.

Two things were established rather than changed. The query-path memo earns its
7% hit rate: sharing it across a query is worth 28% of replay wall time on the
heaviest captured fixture, so it should not be dropped. And the query-path
outlier — hundreds of milliseconds for a dozen schema visits — is not
traversal work at all.

## The narrow reads that were not narrow

`PiecePropIo.get(path)` pulls the requested cell rather than the whole root,
and has since #5231. Four callers never reach it. They take `getCell()` and
project the root themselves, to pluck one top-level property out of the
result:

| caller | what it wanted | what it read |
| --- | --- | --- |
| the `cf piece verbs` walk | the stored top-level names, and one value each | `rootCell.get()` |
| the same listing's fallback sweep | one value per rejected name | `resultRoot.get()` |
| `tryResolvePieceCallableAt` (`cf piece call` dispatch) | one name's value | `rootCell.get()` |
| `classifyReadPathVerb` (the read-path verb guard) | one name's value | `parentCell.get()` |

The last one runs on every read that carries a selection, which is what puts a
whole-result projection inside `cf get … --select`, a command whose whole
point is to ask for two scalars per row.

All four now go through the name's own cell. Enumeration reads the root
through `{type: "object", additionalProperties: {asCell: ["cell"]}}`, which
mints a handle at each property instead of following the link under it, so the
read stops at the root's own document. Classification is left to
`detectCallableKind` against the name's `asSchemaFromLinks()` cell, which is
where reading a cell for its stored signal was already written down — so no
value has to be supplied alongside it, and the only way to supply one was to
project the whole root.

A read that fails there is reported rather than absorbed. The listing has an
`incomplete` mark for the case where it cannot see the whole surface, and
turning a storage or permission failure into "no names" would hand back a
shortened list wearing no mark at all.

### The guard was reading the wrong thing anyway

`classifyReadPathVerb` refuses a read whose path lands on a verb, on either of
two definite stored signals: a link-derived schema that answers as a stream,
or the stored `{$stream: true}` sentinel. It looked for the sentinel at
`parentCell.get()[name]`.

On a real cell that is not where the sentinel is. A verb reaches its root as a
link, so a projected root carries a link payload at the name:

| read of a stream property | answer |
| --- | --- |
| `parent.get()[name]` | `{"/": {"link@1": …}}` |
| `child.getRaw()` | `{"/": {"link@1": …}}` |
| `child.getRaw({lastNode: "value"})` | `{"$stream": true}` |
| `child.asSchemaFromLinks().isStream()` | `true` |

So the sentinel disjunct was false for every real stream, and the guard rested
entirely on the schema disjunct beside it. The whole-result projection bought
nothing.

Both signals now come off the child through `detectCallableKind`, which is
where reading a link-derived cell for its stored signal was already written
down. What the guard adds is that only a handler refuses: a tool binding is
readable data and reads normally, so a `"tool"` verdict falls through exactly
as a null one does. The inline sentinel — a verb stored as a value rather than
behind a link, which is the case the parent projection was nominally for — is
reached there too, without reading the parent at all.

Three test doubles encoded the inverted arrangement — sentinel on the parent's
`get()`, a bare link and no `isStream` on the child — and were corrected to
what a real cell answers.

### What it costs

Board-shaped piece, in process, schema visits per operation:

| board rows | `cf piece verbs` before | after | `--select` read before | after |
| --- | --- | --- | --- | --- |
| 20 | 2,550 | 13 | 1,515 | 669 |
| 40 | 5,070 | 13 | 2,995 | 1,309 |
| 80 | 10,110 | 13 | 5,955 | 2,593 |

The listing's cost was linear in the board and is now constant. The selection
read keeps its per-row work and loses the whole-result projection on top of
it, a flat 56–57% of every schema visit the command made.

The selection read's repeats go to zero with it: 1,120 of its 2,995 visits at
forty rows repeated an (address, schema, link) triple, and all of them were
the guard's. What remains is a read at depth 5 that repeats nothing — the
profile of a read that only walks what it was asked for.

## The memo that was enabled on one side

`traverseWithSchema` consulted its memo only when `traverseCells` is set,
which is true on the memory server's query path and false on the runtime's own
read path. The stated reason held: the query path's key is address plus
schema, sound there because `StandardObjectCreator` ignores the `link`
argument, and unsound on the read path, where `TransformObjectCreator` builds
the returned value out of it — the cell handle it mints, the back-to-cell
annotation it attaches, the CFC label view it rebases.

Folding the link into the key costs almost nothing in hit rate. On a
union-heavy whole-result read, 95.7% of the address-plus-schema repeats
survive the link being added — 3,520 of 3,680 at forty rows.

### What was redundant

A whole-result `Cell.get()` over a board whose rows carry a three-way union,
with three array views over the same rows:

| board rows | visits | repeats (with link) | share | `anyOf` branches |
| --- | --- | --- | --- | --- |
| 10 | 1,208 | 880 | 72.8% | 360 |
| 20 | 2,408 | 1,760 | 73.1% | 720 |
| 40 | 4,808 | 3,520 | 73.2% | 1,440 |
| 80 | 9,608 | 7,040 | 73.3% | 2,880 |

Flat across a factor of eight in board size, and tracking `anyOf`: the
traverser walks one child document under several branches of one union and
gets the same answer each time.

### What enabling it recovers

Same workload, with the read path memoizing on address, schema, and link:

| board rows | visits before | lookups | hits | real traversals | reduction |
| --- | --- | --- | --- | --- | --- |
| 10 | 1,208 | 428 | 100 | 328 | 73% |
| 40 | 4,808 | 1,688 | 400 | 1,288 | 73% |
| 80 | 9,608 | 3,368 | 800 | 2,568 | 73% |

Document lookups fall with them, 1,447 to 487 at forty rows. Wall time for the
read, best of seven in-process reads across three processes: 14.07ms to
4.11ms, a 71% reduction that tracks the 73% reduction in work.

### Why a memo hit is sound

A hit skips a subtree, and with it the scheduler reads and tracker entries
that subtree records. Dropping a read mark breaks reactivity invisibly, so
this is the claim that matters.

It holds because a hit means the same key was already traversed **in this
traversal**. The first visit registered every read the skipped visit would
have registered, at the same addresses, and registering them again adds
nothing to the transaction's read set.

Everything in that argument is per-traversal, so the entries are too. The read
path memoizes into the private `schemaMemo`, never into the shared one a query
passes: an entry outliving its traversal would answer a later traversal that
never recorded its reads, under a `TransformObjectCreator` whose base link and
CFC label view belong to a different materialization. The private memo is now
cleared at the start of every `traverse()` rather than only when no shared
memo is present, which is what makes that scoping true rather than incidental.

`setBase` is called before traversal begins and not again during it, so the
creator's base is fixed for the traversal a memo entry belongs to.

### What the link in the key is worth

Unknown, and kept as insurance.

The capture/replay oracle in `packages/runner/test/traverse-replay/` compares
result hashes, the full read set, and schema-tracker contents against goldens.
It passes with the link in the key and also passes with the link removed — its
client invocations replay with `StandardObjectCreator`, which is the creator
that ignores links, so it cannot see the difference. Reading the same board
three ways — memo off, keyed with the link, keyed without — produced
byte-identical values, including the addresses of every cell handle in them.

So no case was constructed where an address-plus-schema key on the read path
diverges. The link stays in the key because it costs 4% of the hit rate and
one hash per visit against a 73% saving, and because the alternative is
resting on a proof that no link-dependent divergence exists anywhere in
`TransformObjectCreator`.

## The query-path memo earns its keep

Replayed over the four captured fixtures, the query-path memo's hit rate is
what the earlier report found: 7.1% on `notebook-test` (4,715 hits in 66,406
lookups), 3.0% on `toolshed-reload`, 1.1% on `shopping-list-test`. Between 92%
and 99% of its entries are written and never read.

That is still worth having, because a hit skips a subtree rather than a node.
Replaying with each traversal given its own memo instead of the query's shared
one:

| fixture | visits shared | visits unshared | wall shared | wall unshared |
| --- | --- | --- | --- | --- |
| notebook-test | 66,406 | 87,290 | 467ms | 596ms |
| toolshed-reload | 68,551 | 79,382 | 385ms | 389ms |
| shopping-list-test | 1,163 | 1,165 | 14ms | 14ms |

Sharing is worth 28% of wall time on the heaviest fixture and nothing on the
others. It should not be dropped.

The memory concern is separate and stands: the entries that are never read are
a peak on the side where memory is what binds a large board. A cap on
insertion — keep the first N entries, stop inserting past them, which suits
traversal order because the reusable upper graph goes in first — was measured
and not landed:

| cap | notebook-test visits | hits kept | toolshed-reload visits | hits kept |
| --- | --- | --- | --- | --- |
| none | 66,406 | 4,715 | 68,551 | 2,046 |
| 8,000 | 66,446 | 96% | 68,551 | 100% |
| 2,000 | 75,188 | 84% | 68,551 | 99% |
| 500 | 84,390 | 41% | 75,575 | 67% |

Eight thousand entries keeps essentially every hit on both fixtures. It was
left unlanded because a cap is a silent performance cliff for a working set
larger than the cap — `notebook-test` at 2,000 already pays 13% more visits —
and two fixtures are not enough to choose the number a large board needs.

## The outlier is not traversal

Query-path traversals reported at 210 to 680 milliseconds while visiting a
dozen schema nodes and making ten `getDocAtPath` calls at depth five.

Replay prices the traversal machinery with document access held constant: its
manager serves documents from an in-memory corpus. Across all four fixtures
latency is proportional to schema visits at 5–7µs each, with no outlier of
that shape at any size. The slowest invocation in the corpus, 31.9ms, has
6,157 schema visits. So the outlier's time is not in walking schema nodes.

What a traversal does that scales with document bytes rather than schema nodes
is `getDocAtPath` → `EngineObjectManager.load` → `Engine.readState`, which
replay replaces with a map lookup. That path is cached per manager, so only
the first touch of a document pays, and on a `documentCache` miss it either
decodes a stored document or, for a `patch` revision, calls
`reconstructPatchedDocument` — which decodes the latest base or snapshot and
then replays every patch recorded since it.

A create-heavy run appends a patch per create, so the chain since the last
snapshot grows with the run. Ten first-touches of documents reconstructed that
way is 21–68ms apiece at the reported range, is disproportionate to schema
visits by construction, and gets worse over a fifty-create run — which is the
shape and the setting the outlier was observed in. Snapshot cadence and the
`documentCache` hit rate are where that would be confirmed and fixed; neither
was measured here.

## What was measured, and how

A board-shaped piece compiled and run in process against
`StorageManager.emulate`, filled by sending its `addTopic` verb N times: rows
of several fields for the narrow-read measurements, and rows carrying a
three-way union plus three array views over the same rows for the wide-read
ones. Traversal counters came from a scratch probe in `traverseWithSchema`
counting visits and, per traversal, visits whose key was already seen — once
keyed as the query path keys it, once with the link folded in — plus
module-level memo lookup, hit, and insert counters. The probe is not part of
the change.

Query-path figures came from `packages/runner/test/traverse-replay/`, replayed
over its four captured fixtures with `collectLatency`, with scratch knobs to
disable memo sharing and to cap memo size.

## Caveats

Every measurement here is in process, against an emulated storage manager, on
one machine. The earlier report's real-board reads spend most of their wall
clock idle — 2 to 12 seconds of client CPU inside reads of 51 seconds to three
and a half minutes — so this is CPU saved, not latency saved, and none of it
makes those reads fast on its own.

The enumeration in `cf piece verbs` widens slightly: stored names a declared
result type omits are absent from a projected read and present in the shallow
one.
Classification is unchanged and remains the verdict, so a candidate storing no
stream is dropped exactly as a data field is, and the graph-name sweep closes
the same gap from the other side.
