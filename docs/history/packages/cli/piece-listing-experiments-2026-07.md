---
status: historical
created: 2026-07-27
archived: 2026-07-27
reason: "Comparison of three piece-listing experiments and the evidence behind the indexed server-classified design selected for C4."
---

# Piece-listing experiments (July 2026)

Labs C1, C2, and C3 attempted to make `cf piece ls` describe more than the
space's piece registry. They started from the same base and made different
choices about discovery, classification, and output.

## Experiment attribution

| Experiment | Model |
| ---------- | ---------------- |
| C1 | 5.6 Sol Max |
| C2 | Opus 5 Extra |
| C3 | Fable 5 Max |
| C4 | 5.6 Sol Max |

## What each experiment established

### C1: indexed entity enumeration

C1 added a memory protocol operation that reads live default-branch,
space-scoped entity IDs from the SQLite `head` index. Its paged form pins the
first page's server sequence. A write between pages raises
`SnapshotChangedError`. The response does not select stored values.

The CLI mapped every returned entity ID directly to a row. This includes
orphans, but it also includes ordinary cells, source documents, schemas,
streams, and other non-piece entities. It has no registration, pattern, name,
or scope output.

The durable contribution is the enumeration mechanism. It is bounded, indexed,
and snapshot checked. Its entity-level classification is too broad for a
command named `piece ls`.

### C2: piece-owner traversal

C2 seeded discovery from the registry and the default root. It walked each
piece's input, result, and internal manifest. The internal-manifest addition is
important: one fixture creates a child and stores it in an exported collection,
while another stores the child only in pattern-local state. Both fixtures prove
that result-only traversal misses valid children.

The traversal can discover unregistered children linked from a known piece. It
cannot discover a piece with no inbound path from a seed. It also starts every
listed piece to materialize its name and pattern summary. This can run arbitrary
piece code and makes listing cost depend on piece behavior.

### C3: stored-document traversal and output semantics

C3 walked raw stored links from the space cell and registry roots. It
classified a document as a piece when it had a valid pattern identity or
argument link. It resolved registry wrapper documents to canonical piece roots.
It kept space, user, and session instances distinct.

C3 also defined the useful output contract. Registered roots come first in
registry order. Remaining roots are ordered by canonical ID and scope. The
default listing includes `registered`; registry-only output omits it. Narrower
scopes appear only when needed. Pattern references use canonical fabric
references.

C3 starts no discovered piece, but reading the registry starts the default
root. It loads every reachable document. It still cannot see true orphans.

## Empirical checks

The full CLI unit task was run in each experiment. Each run completed between
1,261 and 1,263 passing checks. Each also reported the same nine unrelated
environment failures. Those failures were TCP permission denials and
interference between tests that share process-global color or user state. The
piece-listing tests themselves passed.

The C4 live integration creates both C2 hidden-child fixtures and invokes each
factory. The default indexed listing contains both unregistered children. The
registry-only listing contains neither. The same run contains the default root
and other unregistered system pieces, which confirms that enumeration is not
limited to the fixture graph.

One resulting integration store contained 214 live documents. Forty-four used
computed entity IDs. The index classified 14 roots, all with ordinary `of:`
entity IDs, and excluded every computed document. Synthetic engine tests also
cover computed, data URI, and generic URI roots. They confirm that C3
canonicalization strips the computed scheme and hashes data URIs. C4 carries
the stored URI scheme separately so canonical ID collisions remain
distinguishable. Its page cursor contains hashes rather than the stored data
URI.

Inspection of the resulting store disproved one assumption about summaries.
Each hidden child had durable piece markers and pattern metadata. Its `$NAME`
pointed to a computed cell with no durable `value` after the creating session
ended. Starting the child could materialize a name, but a no-start listing
cannot promise one. C4 therefore makes names optional and identifies the
fixtures by their durable pattern symbol and entry filename.

A memory client test puts a repeated secret string in a piece value, captures
the encoded listing response, and confirms that the secret is absent. The test
then writes between pages and confirms that the continuation fails with
`SnapshotChangedError`.

A paired local microbenchmark measured the write cost against C1 after the
adversarial review fixes. Each run wrote 5,000 ordinary documents, 1,000 piece
roots, and then another 5,000 ordinary documents. Writes used batches of 100.
Each document carried a 256-byte payload. Across seven alternating runs, the
median first ordinary phase increased from 170 milliseconds to 196
milliseconds, about 16 percent. The piece-root phase increased from 31
milliseconds to 73 milliseconds, about 137 percent. The ordinary phase after
the index held 1,000 roots increased from 148 milliseconds to 179 milliseconds,
about 21 percent. All three phases together increased from 350 milliseconds to
449 milliseconds, about 28 percent. The database grew from 12,582,912 bytes to
13,500,416 bytes, about 7.3 percent. Listing 1,000 indexed summaries took a
median 1.4 milliseconds.

A second local benchmark added 500 registry entries one commit at a time. The
common tail-patch path took a median 747 milliseconds across three runs.
Replacing the full growing array took 4,114 milliseconds. The index retained
existing positions and processed only new entries. One further append took 3.0
milliseconds with 1,000 existing entries, 6.5 milliseconds with 5,000, and 32
milliseconds with 20,000. The storage engine still materializes the registry
array to apply its patch, so total append time grows with the stored array even
though the piece index does not traverse the old prefix. A nested state patch
to one registered piece took 0.76, 0.84, and 1.09 milliseconds at the same
registry sizes. This confirms that ordinary registered-piece writes no longer
rebuild membership. Arbitrary removals and reorderings still require a full
registry rebuild. These are local synthetic measurements, not production
latency, but they quantify where the design pays its cost.

Engine tests cover canonical registry-wrapper resolution, registry order,
orphans, argument-only roots, malformed-marker rejection, user and session
scope separation, exclusion of another user's root, linked-name refresh,
declassification removal, cross-space wrapper rejection, legacy registry
eligibility through values and stream schemas, bounded malformed-link handling,
safe non-default URI canonicalization, opaque cursor IDs, a two-connection
SQLite snapshot, late space discovery, incremental registry tails, database
backfill, and reopening an index with its owning space. Query-plan checks
confirm that registered and unregistered continuations use their matching
indexes without a temporary ordering table. They also confirm that batched
dependency lookups drive the target indexes instead of scanning every
dependency.

## Selected design

C4 keeps C1's server-side, paged snapshot. It adds a transactionally maintained
`pragma_piece_root` index rather than returning every entity. The server
classifies roots and stores only the summaries needed by the command.
Dependency tables refresh a root when its linked durable name or matching
source document changes. Registry dependencies refresh canonical membership
and order. The internal table names use the `pragma_` namespace that the
pre-existing SQLite statement guard reserves. A binary rolled back after
opening the upgraded database therefore cannot target a stale index table with
a folded cell-database statement. The index state records the latest storage
commit sequence it processed. Reopening after an older binary advances storage
therefore detects the stale index and rebuilds it before serving a listing.

The CLI uses C3's output, canonicalization, ordering, and scope rules. It keeps
C2's two integration fixtures. The default command never loads a piece value
and starts no code. An explicit `--registry` retains the historical fallback
for a server that predates the indexed protocol.

## Costs and limits

- Every default-branch write now performs piece classification. Piece roots
  also update summary and dependency rows. Listing becomes cheap and bounded
  by shifting work and storage to writes. The local benchmark measured about
  16 to 21 percent overhead for ordinary writes and substantially more for
  piece-root writes.
- The first open of an older database scans its live heads to build the index.
  A large existing space pays that migration cost before it can serve requests.
  Reopening after a rolled-back binary wrote to storage pays the same cost.
- Durable summaries can be incomplete. Computed names are the demonstrated
  case. Missing or structurally invalid pattern source documents also omit the
  entry filename.
- The strict marker contract can expose internal and system pieces that are
  real roots but are not useful to every human reader. It deliberately excludes
  partially written or malformed documents.
- Common registry appends update the new tail. Registry removal, replacement,
  or reordering re-resolves the complete registry because every later position
  may have changed. Applying an append to the underlying stored array still
  materializes that array.
- A concurrent write aborts a multipage listing. The caller receives a clear
  snapshot error and can decide whether to run a new command.
- The index contains roots from all stored scopes. Each request filters to
  space scope plus the calling principal's user and session scope. This makes
  authorization correctness part of the server query rather than a client-side
  filtering concern.
- Default listing requires the new protocol capability. The explicit registry
  mode can use an older server, but that compatibility path keeps the old
  behavior of starting registered pieces.
