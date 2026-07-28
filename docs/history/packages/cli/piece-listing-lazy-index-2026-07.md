---
status: historical
created: 2026-07-28
archived: 2026-07-28
reason: "Cost and correctness evidence for moving piece-root index maintenance from data commits to lazy catch-up."
---

# Lazy piece-root index cost report (July 2026)

This report follows
[the C1, C2, and C3 comparison](./piece-listing-experiments-2026-07.md).
That comparison selected server-side root classification and an indexed,
snapshot-checked listing. Its first implementation maintained the index inside
every data commit. This report measures the replacement that keeps data commits
independent from the piece index.

## Resulting design

The memory protocol includes `piece-root.list` without a capability flag. No
relevant client or server had been deployed when the flag was removed.

A data commit updates the existing storage tables and the current-head index.
It does not classify roots or write any of the four piece-index tables. The
piece index records the latest storage commit sequence it has processed.

Catch-up runs in either of two places:

- after the server finishes a batched subscription fan-out
- at the start of a piece-root listing

A listing first uses a deferred SQLite read transaction for its sequence check
and page selection. If the index watermark is current, the listing does not
reserve SQLite's writer slot. If work is pending, the server ends that read
transaction and starts an immediate transaction that rechecks the sequence,
catches up, and selects the page atomically.

Incremental catch-up pages through current heads whose sequence is newer than
the index watermark. Several pending writes to one entity therefore produce one
root refresh using the final document. Each page contains at most 256 heads.
Reverse summary dependencies and registry dependency paths are also read in
pages of at most 256 rows. Catch-up selects summary-dependency targets across
the complete pending sequence range. Up to 256 matched targets use an ordered
merge with at most 8,192 buffered dependency rows. Broader batches use one
root-ordered dependency scan. Both paths classify each affected root once.
Directly changed roots are excluded from the dependency pass.
Selecting dependency targets makes a second indexed pass over the pending
current heads. It does not decode their revision bodies.

Registry handling reads revision bodies only for the registry document and for
changed entities that the stored registry dependency table names. Unrelated
pending revisions are not decoded. Registry tail patches keep their incremental
path. Replacements, removals, and reorderings rebuild registry positions.

A full rebuild pages through live default-branch heads in groups of 256. It
reuses prepared statements. Each root keeps at most 100 linked-document
addresses while resolving its summary. Registry entries use fresh dependency
maps per entry. The one unavoidable input that can grow with the registry is the
registry array itself, because it is stored and decoded as one document.

Cursor tie-breakers use an uncached SHA-256 digest of the stored entity
identifier. The earlier shared value-hash call retained up to 50,000 identifiers
in each of two process-wide caches during a large rebuild. Canonical piece IDs,
entity kinds, and data-URI redaction are unchanged.

## Correctness evidence

An engine test installs a trigger that rejects every insert into the root index.
A piece data commit still succeeds and leaves the index state absent. The first
listing reaches the trigger and rolls its catch-up transaction back. Removing
the trigger lets the next listing build the index and advance the watermark.

Another test warms the index, writes the same root 300 times, and audits root
table updates with a trigger. The watermark remains at the old commit throughout
the writes. The next listing performs one root update, returns the final name,
and moves the watermark directly to commit 301.

A high-fan-out test gives 1,025 roots the same linked name and pattern source.
Updating both shared documents refreshes the roots through merged
reverse-dependency pages. An audit trigger confirms that each root is updated
exactly once, rather than once per changed dependency.

A second fixture separates a directly changed root and two documents in its
shared 20-document name chain with 300 unrelated changed heads. The dependencies
land on different input pages, but each of the 300 roots is still updated once.
A 300-root fixture with 300 distinct changed name documents covers the bounded
root-scan path.

A registry fixture resolves 300 registry entries through distinct paths in one
wrapper document. Changing the final path updates the final registered root
after traversing two dependency-path pages.

A server test performs a write and then runs the decoupled fan-out pass. The
piece-index watermark advances before any listing. Query-plan checks confirm
that changed-head, reverse-dependency, and registry-dependency paging use their
indexes without temporary ordering tables. Separate engine and server tests
hold an immediate writer transaction open while listing an already-current
index. Both listings complete from deferred read transactions. Existing tests
continue to cover orphans, hidden children, registry wrappers, summary
dependencies, registration order, scope visibility, canonical collisions,
data-URI secrecy, continuation snapshots, and registry tail updates.

The complete memory engine test passed 58 tests. The focused memory protocol,
client, server, runner, and CLI run passed 98 tests with 90 nested steps.

## Write and first-read measurements

The comparison used the same local script before and after the change. Each run
wrote 5,000 ordinary documents, 1,000 piece roots, and another 5,000 ordinary
documents in batches of 100. Each document had a 256-byte payload. The first
listing requested all 1,000 roots. Each value below is the median of three
runs.

| Measurement | Eager index | Lazy index | Change |
| --- | ---: | ---: | ---: |
| All write phases | 578.4 ms | 368.1 ms | 36 percent lower |
| Piece-root write phase | 97.3 ms | 31.6 ms | 68 percent lower |
| First listing | 2.35 ms | 97.5 ms | 95.2 ms moved to the read |
| Writes plus first listing | 580.8 ms | 465.7 ms | 20 percent lower |
| Database file | 13,631,488 bytes | 13,402,112 bytes | 1.7 percent lower |

The script calls the engine directly, so no post-fan-out catch-up runs before
the listing. It measures the worst first-read placement of the deferred work.
When the server pass has already caught up, a listing pays only the indexed page
query. A separate five-run measurement listed the same 1,000 roots a second
time without intervening writes. Its median was 1.47 milliseconds.

The changed-head sequence index is the only new write-side structure used by
lazy catch-up. A seven-round alternating comparison ran the same writes with
and without that index. Median write time was 382.2 milliseconds with the index
and 384.9 milliseconds without it. The distributions overlapped, so this run
found no measurable latency penalty. The index used 163,840 bytes for 11,000
heads, about 15 bytes per head.

## Large rebuild measurements

Two fresh databases contained equal numbers of ordinary documents and roots.
Each root had one summary dependency. The rebuild ran in a new process and the
first listing triggered all index work.

| Roots | Total heads | Rebuild | User CPU | System CPU | RSS after | V8 heap used after |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 20,000 | 342 ms | 0.54 s | 0.04 s | 241,188,864 bytes | 38,316,312 bytes |
| 50,000 | 100,000 | 1,627 ms | 2.10 s | 0.07 s | 335,577,088 bytes | 45,812,640 bytes |

Five times as many roots used 1.20 times as much live V8 heap after the rebuild.
The remaining RSS growth includes SQLite's page cache and resident
memory-mapped database pages. Each open engine permits about 62.5 MiB of SQLite
page cache and up to 256 MiB of virtual database mapping.

Before the uncached cursor digest, the 50,000-root run finished with
150,322,376 bytes of used V8 heap and 443,514,880 bytes of RSS. The final path
used 69 percent less V8 heap and 24 percent less RSS in that comparison.

The reverse-dependency fix was measured separately on the 50,000-root database.
Every root depended on one shared pattern-source document. A write created that
document, then catch-up refreshed all roots. Each value below is the median of
three fresh-process runs and records memory immediately after synchronous
catch-up returned.

| Implementation | Catch-up | RSS after | V8 heap used after |
| --- | ---: | ---: | ---: |
| One unbounded reverse-dependency result | 1,616 ms | 401,899,520 bytes | 84,793,792 bytes |
| Bounded ordered reverse-dependency merge | 1,657 ms | 346,701,824 bytes | 51,686,088 bytes |

Paging used 14 percent less RSS and 39 percent less V8 heap in this comparison.
Catch-up time was 3 percent higher, which is within normal run variation. All
50,000 summaries acquired the new source filename in every run.

Another three-run comparison used 300 roots that shared a 20-document name
chain, then changed all 20 documents in one commit. Independent per-dependency
pages updated the same roots 6,000 times and took a median 2,502 milliseconds.
The bounded ordered merge updated the roots 300 times and took a median 78
milliseconds. This removes the write and classification multiplier while still
reading every matching dependency edge.

## Stored structures and growth

The feature manages four current-state tables:

| Table | Retained rows |
| --- | --- |
| `pragma_piece_root` | One row for each live classified root in any stored scope |
| `pragma_piece_root_dependency` | Distinct documents used by each root summary |
| `pragma_piece_registry_dependency` | Distinct document paths used to resolve the default root and registry |
| `pragma_piece_root_index_state` | One row containing the version, watermark, owning space, and registry tail state |

None of these tables stores commit history. Deleting or declassifying a root
removes its root and summary-dependency rows. Rebuilding the registry replaces
its dependency rows. Durable user and session scope instances remain until
their documents are deleted.

After the 50,000-root rebuild, SQLite's `dbstat` reported 22,511,616 bytes for
all piece tables and indexes. That is about 450 bytes per root in this
one-dependency fixture. Root dependency rows and their reverse lookup index
used about 189 bytes per dependency. Real roots with longer durable name-link
chains use more rows, up to the 100-hop resolution limit.

The changed-head sequence index used 1,343,488 bytes for 100,000 current heads,
about 13.4 bytes per head. The `head` table retains one current row for every
entity and scope address, including a deletion marker. This index therefore
grows with distinct addresses seen over the database's lifetime, not only with
currently live roots.

There is no permanent JavaScript root map. Incremental catch-up retains one
256-row head page, at most 257 matched dependency targets, at most 8,192
reverse-dependency rows across its ordered merge cursors, and, when needed, one
256-row revision, registry-dependency, or root-scan page. A server listing can
hold up to one capped result page from each visible scope before merging their
order. The server keeps one SQLite engine per opened space until shutdown, so
resident page-cache and mapped-page usage can accumulate across many active
spaces. That engine cache predates the piece index, but catch-up can warm more
of each database.

## Trade-offs

- Ordinary commits no longer pay classification, summary resolution, registry
  traversal, or piece-index writes. They do maintain the small head-sequence
  index that makes catch-up proportional to changed current heads.
- The first read after pending writes blocks while catch-up runs. A post-fan-out
  pass usually pays this cost earlier. A large opportunistic rebuild can still
  delay a write that arrives after the rebuild has acquired SQLite's write
  transaction.
- Catch-up work is atomic. A failure leaves both the old rows and old watermark
  intact. The next read or post-fan-out pass can start from the same state.
- The ordered-merge catch-up path reads each matching summary-dependency edge.
  It keeps one classification and index write per affected root while CPU
  remains proportional to those matching edges.
- Catch-up reads pending current-head keys twice: once to classify direct
  changes and once to select changed summary-dependency targets. Targets whose
  dependent roots are all changing directly are omitted.
- A pending range with more than 256 changed summary-dependency targets scans
  the complete root-dependency table once. This bounds cursors and avoids
  repeated root writes at the cost of more reads for unusually broad batches.
- Full rebuild CPU and index storage remain linear in the number of roots and
  summary dependencies. JavaScript working memory is bounded, except for the
  stored registry array.
- Registry append patches add only the new tail. A removal or reorder must
  revisit every registry entry because later positions may change.
- Snapshot stability is fail-fast across pages. A write after the first page
  causes `SnapshotChangedError`; the server does not retain an old multi-page
  snapshot.
