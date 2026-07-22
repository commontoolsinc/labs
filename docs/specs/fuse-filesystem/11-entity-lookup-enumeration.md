# 11. Entity Lookup, Enumeration, and Performance

This document defines the performance contract for the raw `entities/` view.
It separates three operations that have very different costs:

- **exact lookup** addresses one entity whose full ID is already known;
- **enumeration** discovers every live space-scoped entity ID; and
- **hydration** reads one entity value and builds its projected subtree.

Keeping those operations separate is the central constraint. Identifier-only
enumeration must never turn into an implicit read of every entity value.

The per-directory-handle preparation rule and the live-head storage index in
this document describe the implementation on this branch. Cold exact lookup
still refreshes the complete ID list, and entity IDs are still exposed as
traversable directories. Point-existence lookup, a crawler-safe namespace, and
wire-level list pagination are explicitly identified below as follow-ups; they
are not current behavior.

## Addressing and Discovery

An exact path has the form:

```text
<mountpoint>/<space>/entities/<encoded-entity-id>/...
```

The full entity ID is the address. Directory enumeration is a discovery aid,
not a prerequisite for interpreting that address. The implementation may keep
identifier stubs in the in-memory filesystem tree so a known name can resolve
without loading its value.

The Memory v2 `entity-id.list` operation is the complete discovery source for
servers that advertise `entityIdListing`. It returns sorted, live entity IDs
from the default branch and space scope. It excludes deleted, user-scoped, and
session-scoped entities. The operation is authorized as a space `READ`.

The operation deliberately returns IDs rather than entity documents. Complete
discovery is still inherently linear in the number and encoded length of live
IDs: the server must produce them, the wire must carry them, and FUSE must
represent their names. "Identifier-only" means that this work is independent
of entity value size; it does not mean enumeration is constant-cost.

### Exact lookup versus a missing stub

An ID already present as an identifier stub resolves from the in-memory tree.
The current implementation refreshes the complete identifier list when a name
is missing from that tree. That preserves freshness but means a cold exact
lookup is not yet an O(1) storage operation. A future point-existence operation
may remove that coupling. Until then, callers that need predictable point-read
cost should reuse a mounted space's identifier snapshot rather than repeatedly
probing unrelated, absent names.

Mount connection also obtains the initial identifier set on a capable server.
It does not read the space root, default pattern, `allPieces`, or any entity
value. The cost of connecting a space is therefore O(number and length of live
IDs), plus construction of one empty FUSE directory stub per ID.

## Hydration Boundary

An identifier stub is an empty synthetic directory. These operations remain
identifier-only:

- connecting the space;
- listing `entities/`;
- looking up or stating an existing entity-ID stub; and
- refreshing the live-ID set to add or remove stubs.

Reading the entity directory crosses the hydration boundary. The bridge loads
that entity through `PiecesController.get()`, constructs its entity projection,
and hydrates both its `input` and `result` projections for the directory read.
Hydration can transfer and retain bytes proportional to the entity value.

### Recursive crawlers

A recursive walker that opens every entity directory crosses the hydration
boundary once per entity. Tools such as `find`, IDE indexers, backup scanners,
and agents must not be assumed to stop after the top-level identifier listing.
On the current directory-shaped projection, a crawler that descends into all
stubs can request all entity values and materialize all of their projected
nodes.

This is an exposed behavior, not an optimization detail. Consumers that only
need discovery must stop at `entities/` and treat its child names as opaque
IDs. They must not recurse into each child. A crawler-safe namespace in which
enumerated IDs are non-followed links, or in which exact lookup lives below a
non-enumerable `by-id/` directory, remains a possible follow-up; it would move
the opt-in boundary into the filesystem shape itself.

The acceptance invariant is strict even before such a namespace exists:
listing `entities/` alone performs zero entity-value requests. Tests and
benchmarks must count value requests directly rather than inferring this from
the absence of a familiar payload string.

## Directory Handles and FUSE Pagination

One userspace directory read is commonly split across several low-level FUSE
`readdir` callbacks. The kernel supplies an offset and a finite output buffer;
the daemon returns as many entries as fit, then receives a continuation call.
These callbacks are pagination of one open directory, not independent requests
to rediscover the directory.

The daemon tracks preparation per directory file handle:

1. `opendir` allocates a directory handle.
2. The first `readdir` for that handle prepares the dynamic directory. For
   `entities/`, preparation requests the live identifier set and reconciles
   identifier stubs.
3. Continuation `readdir` calls for the same handle read the already prepared
   in-memory directory and do not issue another identifier-list request.
4. `releasedir` discards the handle state.
5. A later `opendir` gets a new handle and may refresh the identifier set.

Preparation failures do not mark a handle prepared. The next operation on that
handle may try again after the caller observes the failure. This is not an
internal retry loop or a time-based poll.

This handle rule prevents a large listing from accidentally becoming
quadratic: without it, a directory spanning P FUSE buffers would transfer the
same O(N) identifier response P times. It also defines the freshness boundary
for pull-based identifier discovery. One handle observes one prepared view;
new opens can observe additions and deletions. Subscription-driven updates may
still invalidate live tree entries as described in
[Reactivity and Caching](./6-reactivity.md).

Memory v2 currently returns the identifier set in one response rather than
protocol pages. If identifier counts grow enough to require wire pagination,
pages must share a fixed `serverSeq` (or fail with a typed changed-snapshot
error), use a server-capped page size, and still prepare only once per FUSE
directory handle. Silent restart loops are not acceptable.

## Storage Live-ID Index

Entity values and current identifier liveness have different access patterns.
A value read needs the current revision data. Identifier enumeration needs only
the compact tuple `(branch, scope, id, current operation)`.

The `head` table therefore stores the current operation (`set`, `patch`, or
`delete`) beside its revision pointer. A partial covering index over live heads
supports sorted space-scope enumeration without joining the JSON-bearing
`revision` table:

```sql
CREATE INDEX idx_head_live_entity_ids
ON head (branch, scope_key, id, op)
WHERE op <> 'delete';
```

The list query reads `head`, filters the default branch and space scope, and
orders by ID. Keeping the current operation in `head` matters for two reasons:

1. it avoids one `revision` index probe per head; and
2. the partial index excludes retained tombstones, so listing cost scales with
   live IDs rather than every ID that ever existed in the space.

Existing databases backfill `head.op` from the current revision during schema
migration. Set, patch, and delete operations update the revision pointer and
operation atomically thereafter. Entity payload bytes remain solely in the
revision path and are not selected, decoded, or returned by ID enumeration.

## Measured Baseline

The scheduled benchmark workflow runs these diagnostic benchmarks. Their
results show trends but do not cause changes to fail CI:

- `packages/fuse/entity-projection.bench.ts` measures identifier-stub
  construction, the first open directory view, repeated refresh, CFC
  annotation overhead, and recursive hydration with a fake manager; and
- `packages/memory/test/v2-entity-id-list.bench.ts` measures the SQLite list
  query across live-count, payload-size, and tombstone-count fixtures, and
  compares it with the live-head index.

Representative commands are:

```bash
deno task --cwd packages/fuse bench:entity-projection
deno task --cwd packages/memory bench:entity-id-list
```

The workflow's JSON artifact records only the operations named by each
benchmark. Fixture construction, forced garbage collection, and diagnostic
measurement happen outside those timers. Heap, request-count, response-size,
and independently measured wall-time diagnostics go to stderr. The workflow
stores them in `diagnostics.log` beside the JSON results. Each FUSE diagnostic
includes an invocation number and labels Deno's first invocation as `warmup`.
Later `measured` invocations correspond to the samples summarized in JSON.

The measurements below were collected on 2026-07-22 with Deno 2.8.x. Ranges
come from the measured invocations in a local run. They are evidence about
scaling and relative cost, not portable latency budgets.

### FUSE projection

Connection obtains the initial ID list and creates the stub tree. With CFC
annotations disabled:

| Live IDs | Stub build | Retained V8 heap | ID response | Final inodes |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 2.4–2.8 ms | 0.6 MiB | about 0.06 MiB | 1,008 |
| 10,000 | 24.3–24.6 ms | 6.9 MiB | about 0.6 MiB | 10,008 |
| 100,000 | 288–293 ms | 62.1 MiB | about 5.5 MiB | 100,008 |

The result is linear but material: connecting with 100,000 IDs retains roughly
62 MiB in the V8 heap before any entity value is loaded. The retained-memory
baseline already contains the fixture's source ID array, so this delta covers
the stub projection rather than counting the source IDs again.

The first `entities/` directory read on a handle refreshes the identifier set
and retains a stable entry snapshot for continuation offsets. The snapshot has
one object per entry and remains live until `releasedir`. Concurrent handles
retain independent snapshots. The measurements below report the complete
refresh-and-snapshot operation and its incremental retained heap:

| Live IDs | First directory view | Added V8 heap | ID response | Entries |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 1.3–1.7 ms | 0.1 MiB | about 0.06 MiB | 1,002 |
| 10,000 | 13.6–14.2 ms | 0.5 MiB | about 0.6 MiB | 10,002 |
| 100,000 | 144–157 ms | 5.5 MiB | about 5.5 MiB | 100,002 |

`FsTree` keeps an inode-to-name map for path classification while building the
snapshot. This keeps the child loop linear. Scanning the parent directory once
for every child makes the operation quadratic.

The benchmark's fake transport excludes database time, network framing, JSON
decoding, and FUSE buffer-copy cost.

CFC annotations amplify stub-construction cost because annotations derive and
retain additional metadata per node:

| Live IDs | Build time with CFC annotations |
| ---: | ---: |
| 1,000 | 23.3–23.5 ms |
| 5,000 | 356 ms |
| 10,000 | 1.37 s |
| 20,000 | 5.94–6.60 s |

Repeated refreshes confirmed why per-handle preparation matters. Ten refreshes
of 10,000 IDs took 79–82 ms and made 11 list requests including connection.
Three refreshes of 100,000 IDs took 281–288 ms and made four requests. Each
100,000-ID response was about 5.5 MiB even though the identifier set had not
changed.

The recursive-walk fixture descended into 1,000 stubs. It performed exactly
1,000 entity gets, 1,000 input gets, and 1,000 result gets. About 3 MiB of
source JSON expanded to 71.5–71.6 MiB of retained heap and 106,008 inodes in
228–232 ms. This quantifies the crawler boundary: identifier-only top-level
listing is cheap relative to projecting every value, but directory shape can
invite the latter.

### Storage query

Representative former-query and live-head medians were:

| Fixture | Former head/revision join | Live-head index |
| --- | ---: | ---: |
| 1,000 live, 16-byte payload | — | 0.247 ms |
| 10,000 live, 16-byte payload | — | 2.9 ms |
| 100,000 live, 16-byte payload | 82.4 ms | 24.2 ms |
| 10,000 live, 4 KiB payload | — | 1.8 ms |
| 1,000 live + 99,000 tombstones | 68.8 ms | 0.185 ms |

Absolute values varied between runs, but the ratios were stable. The 4 KiB
payload fixture remained comparable to the small-payload fixture, confirming
that values were not decoded. Tombstones were the dominant defect: the former
join scaled with 100,000 lifetime heads even when only 1,000 were live.

`EXPLAIN QUERY PLAN` made the cause explicit. The former query searched `head`
and then searched `revision` by its primary-key index for every row. The
live-head form searches only `idx_head_live_entity_ids` by branch and scope.
The index reduced the 100,000-live fixture by roughly 3.4x and the
tombstone-heavy fixture by over two orders of magnitude. Rebuilding a local
100,000-head tombstone-heavy database with the current migration took about
93 ms in one run. This is a one-time, open-time write-lock cost rather than
steady-state listing work.

## Acceptance Invariants

Changes to the entity projection must preserve all of the following:

1. **No value transfer during discovery.** Space connection and top-level
   `entities/` preparation issue zero per-entity reads and transfer no entity
   document values.
2. **One preparation per handle.** FUSE continuation offsets for one open
   directory do not repeat identifier discovery. A new handle may refresh.
3. **Linear, live-set storage work.** The query plan uses the live-head index,
   does not access `revision`, and does not scan tombstones.
4. **Value-size independence.** Increasing entity payload size does not change
   the logical list result or cause payload decoding. Tests should inspect
   response structure and request counts as well as payload sentinels.
5. **Explicit hydration.** Access below one entity stub hydrates at most that
   entity. Top-level enumeration hydrates none.
6. **Deletion correctness.** A refreshed identifier snapshot removes deleted
   stubs and all indexes associated with their projected subtrees. New opens
   can observe the removal without a sleep or polling loop.
7. **Bounded failure behavior.** A failed list does not publish a partially
   connected space or poison a directory handle. Callers may retry the failed
   operation; the daemon does not run a hidden retry loop.
8. **Capability-safe compatibility.** A client never sends `entity-id.list`
   unless the server positively advertises `entityIdListing`.

Performance tests should prefer deterministic counters and query-plan
assertions over wall-clock CI thresholds. Useful scale fixtures are 1,000,
10,000, and 100,000 live IDs; a tombstone fixture should hold the live count
constant while increasing lifetime heads by at least 100x. A recursive fixture
must report entity, input, and result request counts explicitly.

## Older Servers

An older Memory v2 server omits `entityIdListing`; omission parses as `false`.
The client does not send the unknown request. Connecting the space therefore
does not fall back to reading the space root, default pattern, or `allPieces`,
and `entities/` begins empty.

If the caller later opens `pieces/`, the legacy `allPieces` projection is
materialized. Those known piece IDs may then appear under `entities/`, but this
is an incomplete view: entities outside `allPieces` cannot be discovered from
an older server. Exact access is correspondingly limited to already known piece
controllers in the current implementation. Compatibility must remain explicit
and fail closed; absence of the capability must never trigger a hidden
space-wide value scan.

---

**Previous:** [CFC Filesystem API Semantics](./10-cfc-filesystem-api-semantics.md)
