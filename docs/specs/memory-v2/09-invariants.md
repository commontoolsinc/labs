# 9. Consistency Invariants

This document is the normative catalog of end-to-end consistency invariants for
Memory v2. The other chapters state requirements per mechanism (the commit
model, the conflict matcher, the protocol); this chapter states the properties
those mechanisms exist to uphold, as a checkable list with stable identifiers.

Why it exists: optimizations to conflict detection and commit admission almost
always work by *narrowing an approximation* — fewer recorded dependencies, a
more precise overlap matcher, a later staleness basis. Each such change must be
argued against the invariant it narrows toward, not against the previous
implementation's behavior. A change that satisfies the letter of one
mechanism's MUST can still break a property nobody restated; this catalog is
where those properties are stated once.

## How to use this catalog

- **Reference invariants by ID** (e.g. `INV-1`) in PR descriptions, review
  comments, code comments, and tickets whenever a change touches commit
  admission, conflict detection, dependency recording, or client replay.
- **Every entry names its soundness direction.** Most invariants are
  asymmetric: one direction of approximation is safe (costs a retry), the
  other is corruption. An optimization is admissible only if it moves
  *within* the safe direction.
- **Known deviations are listed, not hidden.** An invariant with an open
  violation stays in the catalog with the ticket attached; the catalog
  describes the contract, not the current score.

Checkers referenced below:

- the **durable-history oracle**: `staleReadAnomalies` in
  `packages/state-inspector/oracle.ts`, which replays the engine's own
  admission predicate over a space DB's commit history
  (`packages/state-inspector/test/engine-oracle.test.ts` proves it detects
  seeded corruption);
- the **differential harness**:
  `packages/memory/test/v2-differential-consistency-test.ts`, which runs
  seeded random commit schedules against the engine and a naive reference
  validator (`packages/memory/test/naive-admission.ts`);
- the **TLA+ model**: `docs/specs/memory-v2/tla/PendingStacks.tla`, which
  model-checks INV-1/INV-3/INV-4/INV-5 over all small interleavings for each
  dependency-recording and staleness-basis variant.

## The invariants

### INV-1 — Read coherence (no phantom, no missed write)

> Every read recorded by an **accepted** commit observed exactly the durable
> state at the commit's resolution point: the set of writes that produced the
> observed value equals the set of accepted overlapping writes with
> `seq < commit.seq` (restricted to the read's path, branch, and scope).

This is the master invariant. It forbids both failure directions at once:

- **Phantom read** (observed ⊃ durable): the observation includes a write
  that was never durably accepted — e.g. a rejected pending layer whose
  optimistic value leaked into a dependent commit's observation. This is the
  CT-1872 "1c corruption" shape.
- **Missed write** (observed ⊂ durable): a concurrent accepted write
  overlapping the read landed before the reader's commit but after its
  recorded basis, and admission did not scan it. This is the CT-1910 shape.

Layer: server admission (`validateConfirmedReads`, `resolvePendingReads` in
`packages/memory/v2/engine.ts`) together with client dependency recording
(`packages/runner/src/storage/v2.ts`, `v2-transaction.ts`).

Soundness direction: admission MAY reject a commit whose observation is in
fact coherent (over-rejection costs a retry). It MUST NOT accept a commit
whose observation is incoherent.

Checked by: the durable-history oracle (any hit is by construction a
violation); the TLA+ model's `ReadCoherence` invariant; the differential
harness's replay comparison.

Known deviations: **CT-1910** (pending-read basis over-advance), repaired
for readers that declare `basisSeq` and RETAINED for legacy readers that do
not: a pending read without `basisSeq` is scanned from the highest
dependency's resolution seq, so overlapping foreign writes landing between
the reader's confirmed basis and that seq are not scanned. A read declaring
`basisSeq` is scanned over the full interval from that basis, excluding
only the session's TRUE PREDECESSOR commits — those with a localSeq below
the reader's, the accepted layers its view included; an own write admitted
out of submission order conflicts like a foreign one
(03-commit-model.md §3.6.3) — the shape current clients always emit. The TLA+ config
`PendingStacks_Current.cfg` reproduces the legacy-shape violation (kept as a
regression witness, alongside the legacy-shape engine test in
`packages/memory/test/v2-pending-read-basis-overadvance.test.ts`) and
`PendingStacks_Repaired.cfg` certifies the repaired shape in the bounded
model. The residual deviation retires when clients that omit `basisSeq`
fall below the support floor.

### INV-2 — Overlap over-approximation only

> Write/read overlap detection MAY over-approximate (report overlap where
> none exists) and MUST NOT under-approximate (miss a real overlap). A real
> overlap is: the write changed a value the read's result depends on.

This is `03-commit-model.md` §3.6.2 restated as the standing rule for every
matcher refinement. The three granularity refinements in
`08-conflict-granularity.md` (leaf-only touched paths, nonRecursive shape
reads, asCell reference-resolution exclusion) are each an argument that a
narrowing stays on the safe side; any future refinement owes the same
argument, including its whole-system preconditions (e.g. leaf-only matching
is sound only because the runner never emits indexed-array structural ops —
guarded by `assertNoIndexedArrayStructuralOps`).

Layer: `patchOverlapsRead`, `patchOverlapsNonRecursiveRead`,
`touchedLeafPathsForPatch`, `touchedPathsForPatch` (engine); read tagging and
exclusion at the client boundary (`reactivity-log.ts`, `buildReads`).

Soundness direction: toward precision only from above; never below exact.

Checked by: the differential harness (engine-accept must imply
naive-accept, where the naive validator implements exact overlap); the
generator test asserting the runner's array-op discipline
(`packages/runner/test/memory-v2-native-commit.test.ts`).

### INV-3 — Dependency completeness and staleness-basis selection

> A commit that reads a document through a pending stack records a dependency
> set that (a) includes every pending layer whose acceptance or rejection can
> change the observed value, and (b) includes the document's top-of-stack
> layer below the reader. For a read declaring its true confirmed basis
> (`basisSeq`), the staleness scan runs from that basis with predecessor-only
> own-session exclusion; for a legacy read, the top-of-stack layer's
> resolution is the staleness basis. Narrowing may drop only non-top layers
> whose write footprint provably cannot influence the read path.

Clause (a) is what makes rejection cascades reach every semantically
dependent commit (see INV-4); recording fewer layers than the value's true
contributors is how phantoms are born (CT-1872 1c: the pre-#4606 scalar shape
named only the top writer of the read path and missed a rejected lower layer
that also wrote it). Clause (b) anchors the cascade at the stack top; for a
LEGACY read it is also `03-commit-model.md` §3.5's basis rule — basing that
scan below the top of stack without own-session exclusion is unsound, not
merely conservative, which is exactly why the `basisSeq` shape pairs its
lower basis with the exclusion (§3.6.3).

The current full-stack recording (every layer of the document, no overlap
filtering) over-approximates clause (a) — safe direction, costs false dooms
(the CT-1872 over-coupling). The proposed overlap-filtered refinement must
keep every layer overlapping the read path *and* the top-of-stack layer; the
TLA+ config `PendingStacks_Filtered.cfg` certifies that shape in the bounded
model. Dropping a layer that overlaps the read path instead re-creates the
CT-1872 phantom — an INV-1 violation.

Layer: client dependency recording (`packages/runner/src/storage/v2.ts`
pending-stack bookkeeping); server resolution (`resolvePendingReads`).

Soundness direction: MAY record more layers than semantically necessary;
MUST NOT drop a layer that overlaps the read path, and MUST NOT drop the
top-of-stack layer. A legacy read MUST NOT base its staleness scan below
the top of stack; a `basisSeq` read scans from its declared basis and MUST
exclude only true predecessor own-session commits (localSeq below the
reader's — an own write accepted out of submission order conflicts like a
foreign write).

Checked by: the TLA+ model (all three recording modes); stacked-commit unit
tests (`packages/runner/test/memory-v2-stacked-commit.test.ts`).

### INV-4 — Cascade totality

> If a pending commit is rejected, every commit whose recorded dependency set
> names it is also rejected (server side), and every queued or in-flight
> commit naming it is dropped before its verdict arrives (client mirror).
> Combined with INV-3(a), no commit built on a rejected layer's optimistic
> value is ever durably accepted.

Note the division of labor: the cascade mechanism is only as good as the
dependency sets it walks (INV-3). A complete cascade over incomplete
dependencies still admits phantoms.

Layer: server (`resolvePendingReads` rejection path); client drop cascade
(`packages/runner/src/storage/v2.ts`).

Soundness direction: MAY drop commits that name a rejected layer they did
not semantically depend on (over-coupling, a wasted retry); MUST NOT leave a
dependent commit standing.

Checked by: the TLA+ model; stacked-commit tests; the differential harness.

### INV-5 — Per-session monotonic resolution

> Within a logical session, commits resolve (accept or reject) in increasing
> `localSeq` order. A held commit is never leapfrogged by a later
> same-session commit. Consequently a commit's resolution seq is monotonic in
> its `localSeq`.

This ordering is what makes the top-of-stack staleness basis sound (INV-3(b)
depends on it): every own-session layer below a reader resolves at or before
the basis layer's seq, so the scan interval past the basis contains no
own-session commits.

Layer: server session queueing (`03-commit-model.md` §3.6.3 — the current
implementation rejects rather than holds, which preserves the ordering
trivially).

Soundness direction: none — this is an exact ordering requirement, not an
approximation. Any reordering optimization (parallel admission, speculative
holds) must re-establish it.

Checked by: the TLA+ model (FIFO processing is load-bearing there; any
future relaxation should be modeled first); reconnect/race unit tests.

### INV-6 — Accepted-versus-dropped agreement

> The server and the client never disagree about a commit's fate: a commit
> the client has locally cascade-dropped is never durably accepted, and a
> commit the server has durably accepted is never treated by the client as
> dropped.

This is why the scalar downgrade rule exists (`03-commit-model.md` §3.5): a
client talking to a server without `pendingReadStacks` MUST hold a commit
whose omitted lower dependencies are unsettled, because the server could
durably accept what the client is about to cascade-reject.

Layer: client send gating and replay (`v2.ts`, reconnect paths); server
dedup by `(sessionId, localSeq)`.

Soundness direction: MAY hold a send longer than necessary; MUST NOT send a
commit whose local doom is still possible, and MUST NOT locally drop a
commit whose acceptance is still possible without confirming its fate.

Checked by: currently only example-based tests (reconnect-race,
pending-commit-durability). The TLA+ model treats verdict delivery as atomic
with admission and therefore does NOT cover this invariant; extending it
with delayed verdict delivery is the natural next step if this area churns.

### INV-7 — Committed writes are never silently dropped

> A write that reached `.commit()` successfully either becomes durable or its
> failure is surfaced to the caller (rejection, revert notification, retry
> exhaustion). There is no path on which it silently vanishes.

Stated in
[Committed-write backpressure](../../development/committed-write-backpressure.md);
listed here because retry-loop and backpressure optimizations are the changes
most likely to violate it.

Layer: client retry/backpressure (`scheduler/backpressure.ts`, storage
rejection taxonomy in `rejection.ts`).

Soundness direction: MAY surface a failure for a write that would have
eventually succeeded; MUST NOT drop one without surfacing.

Checked by: backpressure and convergence-storm tests
(`packages/patterns/integration/convergence-storm.test.ts` asserts all 2K
contended writes land).

### INV-8 — Transaction atomicity

> All operations of an accepted transaction produce revision rows and head
> updates at one seq, or none do. No partial visibility, on the server or in
> any client's integrated view.

Layer: engine (`applyCommitTransaction` runs in one database transaction);
client integrate path.

Soundness direction: none — exact.

Checked by: engine unit tests; the differential harness's value-replay
comparison (a torn apply diverges from the naive fold).

### INV-9 — Log determinism and convergence

> An entity's value is a deterministic function of the accepted commit log
> prefix: `value = fold(apply, genesis, log[1..n])`. Any two replicas that
> have integrated the same prefix compute identical values, and a stored
> snapshot equals the replay of its prefix (`01-data-model.md` §7.3).

Layer: patch application (`packages/memory/v2/patch.ts` server-side, the
client apply path in `v2-document.ts`); snapshot materialization.

Soundness direction: none — exact. Note this requires client and server
apply semantics to be identical; a "fast path" on one side that reorders or
coalesces ops differently is a violation even if each side is internally
consistent.

Checked by: the differential harness (engine `read` versus naive fold);
`packages/state-inspector` convergence verdicts
(`multispace.ts`) and `reconstruct-parity.test.ts`.

### INV-10 — Single-snapshot reads

> A transaction's recorded read set describes one coherent local snapshot:
> confirmed bases from one integrated prefix plus the session's own pending
> stack, never a mixture of states observed across an integration boundary
> (`03-commit-model.md` §3.3.4).

Layer: client (sync-frame buffering while a transaction builds).

Soundness direction: MAY buffer integration longer than necessary; MUST NOT
let a transaction observe two prefixes.

Checked by: chronicle re-validation tests; no dedicated checker (the
durable-history oracle would surface a resulting incoherent acceptance as an
INV-1 hit).

### INV-11 — Idempotent replay

> Replaying a commit after reconnect is idempotent: the server deduplicates
> by `(sessionId, localSeq)`; an identical payload returns the original
> result, a differing payload is a protocol error, and replay never produces
> a second durable commit.

Layer: server dedup (`03-commit-model.md` §3.7.4); client retained-commit
replay.

Soundness direction: none — exact.

Checked by: engine and reconnect unit tests.

## Change discipline

When a change narrows dependency recording, overlap matching, staleness
scanning, cascade scope, or retry behavior:

1. Name the invariant(s) the narrowing approaches, by ID, in the PR.
2. State why the change stays on the safe side of each soundness direction,
   including any whole-system preconditions it newly relies on — and guard
   those preconditions (assertion + generator test, as
   `assertNoIndexedArrayStructuralOps` does for INV-2).
3. If the change touches pending-stack recording, resolution ordering, or
   staleness bases, run the corresponding TLA+ configs (see
   `docs/specs/memory-v2/tla/README.md`) — add a mode to the model if the
   change introduces a new recording/basis shape.
4. Run the differential harness; if the change makes the engine accept
   strictly more histories, the naive validator must agree on every newly
   accepted one.

When an invariant is found violated in the field or by a checker: file a
ticket, add it to the invariant's "known deviations" with the ticket ID, and
where feasible reproduce it as a TLA+ config or a differential-harness seed
before fixing — the reproduction is what certifies the fix.
