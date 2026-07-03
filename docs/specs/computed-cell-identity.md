# Computed Cell Identity And Write Conflict Policy

## Status

Phases 1-3 implemented. Phase 1 (minting), behind
`EXPERIMENTAL_COMPUTED_CELL_IDS`: `createRef`/`FabricHash` kind support
(preimage + `fid2:computed:` format), conservative builder classifier,
kind-aware descriptor/manifest matching. Phase 2 (server policy): the
memory-v2 engine acknowledges-and-drops stale all-computed commits — a
zero-revision commit row keeps replay dedupe, dependent pending reads, and
origin-committed preconditions working — and the storage client reverts the
optimistic pending value on a `droppedComputed` ack instead of promoting it
(promotion would shadow the authoritative value behind the monotonic seq
guard). Phase 3 (lineage) is verified by engine tests. Value-equality dedupe
(phase 4) and the server-side action runner (phase 5) are not started.
Derived from a design discussion on 2026-06-30/07-01 about avoiding needless
commit conflicts when multiple clients recompute the same derived values.

## Summary

When a pattern is instantiated, the runner materializes internal cells whose
contents are, in many cases, pure functions of the pattern's inputs: any
runtime holding the same inputs recomputes the same values. Today the memory
server treats writes to those cells exactly like writes to authoritative
state. When two clients recompute concurrently, or when one client commits a
recompute against inputs that another client has just advanced, the server
rejects the stale commit, the losing client's action re-runs, and it commits
again — protocol churn that exists purely to converge on a value both sides
would have derived anyway.

This proposal makes the derived/authoritative distinction visible to the
memory server by embedding a kind in the entity id of computed internal
cells, and relaxes the server's conflict handling for writes that target
those entities: a computed write whose reads are stale is acknowledged and
dropped instead of rejected, because reactivity guarantees the writer
recomputes from the newer inputs once they sync down. Clients keep sending
every commit — the database stays current for tools like `cf inspect`,
`localSeq`-based read resolution keeps working, and speculation lineage
preconditions stay satisfiable. Only the server's *response* to staleness
changes, and only for entities whose ids carry the computed kind.

## Goals

- Eliminate reject/re-run/recommit churn for concurrent or stale writes to
  purely derived internal cells, without weakening conflict detection for
  authoritative state.
- Make the derived/authoritative classification of an entity immutable,
  client-independent, and readable by the server (and by offline tools)
  without protocol shape changes or side-channel registries.
- Keep every commit flowing to the server so the durable store remains a
  complete, inspectable materialization of all values.
- Preserve the semantics of `PendingRead.localSeq` references and
  `origin-committed` commit preconditions.
- Lay the classification groundwork the future server-side action runner
  needs to know which entities it is licensed to regenerate.

## Non-goals

- Do not skip sending recompute commits from clients. (An earlier variant of
  this idea did; it was rejected because later commits' pending reads
  reference the `localSeq` of prior local commits, `origin-committed`
  preconditions name origin commits by `localSeq`, and non-runtime readers
  such as `cf inspect` would lose visibility.)
- Do not make the memory server execute pattern code. The server compares
  read watermarks; it never computes values. A server-side action runner is
  future work that this proposal feeds but does not include.
- Do not change conflict semantics for authoritative state cells, stream
  cells, or builtin result cells (`fetch`, `llm`, `generateText`, …). Their
  writes are not re-derivable and keep strict semantics.
- Do not retrofit visible kind tags onto existing kinds. Stream cells
  already carry `$kind: "stream"` in their id preimage but not in their
  visible form; adding a visible tag would re-identify every existing stream
  cell. Visible kind tags apply to newly introduced kinds only.
- Do not treat the kind tag as a security boundary. Conflict semantics are a
  convergence mechanism; authorization is unchanged.

## Current System Overview

### Internal cell identity

The pattern builder assigns each internal root cell a `partialCause` —
the cell's declared name, or an anonymous `{ $generated: N }` counter, with
`$kind: "stream"` mixed in for stream cells
(`packages/runner/src/builder/pattern.ts`). At instantiation the runner
mints the entity id from the piece's result cell and that partial cause:

```ts
createRef({}, { parent, type: "internal", cause: descriptor.partialCause })
```

(`packages/runner/src/link-utils.ts`, `getDerivedInternalCellLink`). The
result is a `FabricHash`: hash bytes plus an algorithm tag, stringified as
`<tag>:<base64urlHash>`, e.g. `fid1:abc…`
(`packages/data-model/src/fabric-primitives/FabricHash.ts`). The hash is
opaque: nothing about the preimage — including `type: "internal"` or the
partial cause — is recoverable from the id. `hashOf` mints the `fid1` tag at
a single chokepoint (`packages/data-model/src/value-hash.ts`).

The manifest of materialized internal cells is stored in result-cell
metadata and matched by `deepEqual(partialCause)`
(`packages/runner/src/runner.ts`, `materializeDerivedInternalCells`).

### Transaction provenance

The runner already distinguishes recompute transactions from event-handler
transactions, but only in process memory:

- Reactive action runs open their transaction with a `changeGroup` and set
  `tx.tx.sourceAction` (`packages/runner/src/scheduler/action-run.ts`).
- Event dispatch sets `tx.dispatchedEventId` and `tx.tx.immediate`
  (`packages/runner/src/scheduler/events.ts`).

Behind `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE`, reactive runs attach a
`SchedulerActionObservation` to their commit with
`actionKind: "computation" | "effect"`; the event path attaches no
observation, so the `"event-handler"` kind is currently never produced.

### Commit conflict handling

`ClientCommit` (`packages/memory/v2.ts`) carries `localSeq`, a read set
(confirmed reads with sequence watermarks, pending reads referencing prior
local commits by `localSeq`), operations, and optional preconditions. A
commit whose reads are stale relative to the space head is rejected; the
client's scheduler re-runs the action against the newer inputs and commits
again. The persistent-scheduler-state work already performs per-entry
keep/drop decisions on exactly this read-watermark basis for no-op
observation batches, recording dropped replay rows rather than surfacing
conflicts.

## Problem Statement

For a purely derived internal cell, a conflict between two clients is never
meaningful: if their inputs matched, their values match; if their inputs
differed, one client was stale and will recompute when the newer input
arrives. The reject-and-retry cycle spends protocol round-trips and commit
log entries converging on a value the system was always going to reach.
Worse, as more clients share spaces, the probability of two runtimes
recomputing the same node concurrently grows, so the churn scales with
exactly the deployments we want to work well.

The server cannot currently tell derived writes from authoritative ones. The
in-process provenance markers do not cross the wire, the observation
`actionKind` is an optional blob behind an experimental flag and absent on
the event path (so absence is not a safe discriminator), and the entity id
is an opaque hash.

## Proposed Model

### Kind-tagged entity ids

Embed the kind as a proper segment of a **versioned** id format:

```
fid2:computed:<base64urlHash>
```

`fid1:<hash>` remains the untagged form. `fid2` is a format version, not a
new hash algorithm — the bytes are produced by the same fid1 hashing — and
the version bump exists so the first segment stays a pure format
discriminator: a parser that only knows fid1 fails loudly on a kinded id
instead of silently mis-handling it.

Parsing: `FabricHash.fromString` splits at the **last** colon. The hash
segment is base64url and never contains a colon, so this is unambiguous,
parses every existing two-segment id identically, and yields
`tag = "fid2:<kind>"` for kinded ids. The `{tag, hash}` codec and the `of:`
URI layer round-trip the form unchanged, and nothing in the codebase asserts
specific tag values.

Alternative considered: folding the kind into the tag with a non-colon
separator (`fid1+computed:<hash>`), which keeps first-colon parsing working
untouched. Rejected because it overloads `fid1` — the format-version
identifier should stay clean before the first colon, and version-dispatching
parsers get the failure-on-unknown-format property for free.

Rules:

- **The kind is also minted into the hash preimage.** `createRef` gains a
  kind input that is injected into the cause (following the
  `$kind: "stream"` precedent) *and* selects the visible tag, from
  the same argument at the same call. The two representations cannot
  diverge, and two cells identical except for kind differ in hash bytes as
  well as string form — so code paths that compare by `hashString` or raw
  bytes rather than the full tagged form cannot alias a computed cell with
  a state cell.
- **Identity keys are the full tagged string form.** `fid2:computed:H` and
  `fid1:H` are distinct entities everywhere, unconditionally.
- **Absence means strict.** Untagged ids — every existing entity — keep
  authoritative conflict semantics. There is no migration; only newly minted
  computed cells get the new form, and the server's conservative default
  covers everything it cannot classify.

### Builder-side classification

The builder tags a cell `computed` only when it can prove the cell is
written solely by compute nodes:

- the cell is the output of a `lift`/`computed`/derive node, and
- the cell is not handed writable into any handler binding, and
- the cell is not a stream, and
- the cell is not the result cell of a non-replayable builtin (`fetch`,
  `llm`, `generateText`, `llmDialog`, `streamData`, …), and
- the cell is not exposed writable through the pattern's result/argument
  surface.

Everything else defaults to untagged (strict). The misclassification
asymmetry drives this conservatism: tagging a computed cell as state costs
only a missed optimization; tagging state as computed means the server
silently drops user writes. The classifier may start extremely narrow and
widen as capability analysis improves.

### Server conflict policy

At commit-apply time the engine classifies each semantic operation by
parsing the kind from its entity id string. Policy:

- **All-computed commits** (every semantic operation targets a
  computed-tagged entity):
  - Reads current → accept normally. Optionally dedupe value-equal writes
    (see Open Questions).
  - Reads stale → **acknowledge and drop.** No rejection is signaled, no
    retry is expected. The client's own scheduler re-runs the action when
    the winning input syncs down; convergence is unchanged, churn is
    eliminated.
  - Two current commits racing on the same computed entity: first wins.
    Determinism says the values should be identical; if they differ, that is
    a nondeterminism bug surfacing, and first-wins still converges because
    the losing client is corrected on sync-down.
- **Mixed commits** (computed and non-computed operations together): strict
  semantics for the whole commit. Atomicity is preserved; partial
  application of a commit is never introduced. Pure recompute transactions
  write only their computed output cells, so the all-computed case is the
  common one.
- **Non-computed commits**: unchanged.

An acknowledged-and-dropped commit is indistinguishable from an accepted one
for bookkeeping purposes: it consumes its `localSeq`, satisfies
`origin-committed` preconditions that name it, and resolves
`PendingRead.localSeq` references from later commits (the referenced read
resolves against the value that actually won, which is the value the reader
will observe after sync-down; if that read is thereby stale, the *reading*
commit's own policy applies). This is the invariant that lets clients keep
their existing commit pipeline untouched.

### Client behavior

None required beyond minting. The drop is invisible: the client applied its
write optimistically, the server acks, and the authoritative value arrives
through the normal subscription path exactly as a lost conflict does today —
minus the rejection, the action re-run, and the second commit.

### Kind flips across pattern versions

A cell whose kind changes between pattern versions (e.g. a `computed(...)`
refactored into handler-managed state) mints a different partial cause and
therefore a different entity id. This is semantically correct, not a
migration problem: in the computed→state direction the orphaned value was
derived garbage; in the state→computed direction the old value is superseded
by derivation. Either way the old contents are meaningless under the new
kind, and the manifest's `deepEqual(partialCause)` matching materializes the
new cell and drops the stale entry naturally.

Internal-cell identity is already refactor-fragile — anonymous cells re-mint
on reorder via the `$generated` counter, named cells on rename — so kind
flips add a trigger to an existing hazard class (durable cross-piece links
pointing at an orphaned entity), not a new class.

### Trust model

The kind tag is client-asserted; the server cannot verify purity without
executing code. What the design guarantees instead:

- **Immutability.** The kind is part of identity. There is no retag
  operation, no migration case, and no surface where a buggy or malicious
  client demotes an existing state cell to computed to get its writes
  stale-dropped: changing the tag necessarily changes the id, i.e. names a
  different entity.
- **Blast-radius containment.** A client that mints a computed-tagged id and
  writes non-derived data through it only relaxes conflict semantics for
  entities it created itself. It gains no ability to affect the conflict
  handling of anyone else's data.
- **Honest tagging by construction.** The tag originates in the builder's
  structural analysis, never in pattern-author-controlled values.

## Relationship To Persistent Scheduler State

The two workstreams are complementary, with the dependency pointing from
this proposal onto persistent-scheduler-state:

- The server-side machinery this policy needs — comparing a payload's read
  watermarks against heads and making per-entry keep/drop decisions with
  dropped-replay bookkeeping — already exists for no-op observation batches.
  Implementing this policy is largely extending that mechanism from
  observation rows to semantic operations on computed-tagged entities.
- In return, this proposal de-risks persistent-scheduler-state's hardest
  open problem: rehydration trust. For the computed subset of entities,
  acting on a stale or invalid persisted observation degrades from a
  correctness cliff to a performance cost — a wrong write is dropped and
  recomputed — so the conservative fallback can be less conservative exactly
  where data is replayable, even while action-identity fingerprints remain
  version-1 placeholders.
- Together they form the knowledge layer for the future server-side action
  runner: persistent-scheduler-state supplies the dependency graph, read and
  write surfaces, and dirty state; computed-tagged ids supply the set of
  entities the server is licensed to regenerate; `ClientCommit.codeCID`
  supplies code identity. Execution remains the missing (and out-of-scope)
  half.

## Correctness Invariants

- A write to a non-computed entity is never dropped, deduped, or otherwise
  relaxed by this policy.
- A commit is either applied whole or dropped whole; mixed commits are never
  partially applied.
- An acknowledged-and-dropped commit satisfies every bookkeeping obligation
  an accepted commit satisfies: `localSeq` consumption, `origin-committed`
  preconditions, `PendingRead` resolution.
- For deterministic computations, all clients converge on identical values
  and identical entity ids without any client observing a conflict on a
  computed entity.
- For a nondeterministic computation mistakenly tagged computed, the system
  still converges (first-wins plus sync-down correction); the failure mode
  is value flapping, never divergence or data loss.
- Existing entities and untagged ids behave exactly as before the change.

## Phased Plan

1. **Minting.** Thread a kind input through `createRef`/`hashOf` (preimage +
   visible tag from one argument). Builder classifier, starting with the
   narrowest provable-pure rule. Gate minting behind an experimental flag in
   the `EXPERIMENTAL_MODERN_DATA_MODEL` mold — new-form ids are a data
   compatibility event, so the flag controls id creation, and readers accept
   both forms unconditionally from the start.
2. **Server policy, drop-on-stale.** Engine-side kind parse at commit-apply;
   ack-and-drop for all-computed stale commits, with dropped-replay rows for
   inspectability, reusing the persistent-scheduler-state keep/drop path.
3. **Lineage integration.** Verify `origin-committed` and
   `PendingRead.localSeq` semantics against dropped commits under the
   speculation test suites.
4. **Value-equality dedupe** for current-read computed commits, if the
   measured commit-log savings justify the comparison cost.
5. **Later:** server-side action runner consumes the tags (separate spec).

## Test Strategy

- Unit: `FabricHash` round-trips of the folded tag through string, URI, and
  codec forms; full-form identity keying (computed and untagged ids with
  equal hash bytes are distinct everywhere).
- Builder: classifier coverage for each exclusion (handler-writable, stream,
  builtin result, result-surface exposure); a pattern refactor that flips a
  cell's kind mints a new id and re-materializes via the manifest.
- Engine: all-computed stale commit is acked, dropped, recorded as a dropped
  replay row, satisfies a dependent `origin-committed` precondition, and
  resolves a later commit's pending read; mixed commit keeps strict
  semantics; race of two current computed commits is first-wins.
- Integration: two-client scenario where both recompute the same node —
  assert convergence with zero conflict-driven action re-runs; `cf inspect`
  shows the computed value and the drop bookkeeping.

## Open Questions

- Do builtin result cells flow through nodes the scheduler already marks as
  effects, or as computations? The classifier's exclusion list must be
  grounded in what the graph actually reports, not the builtin registry
  alone.
- Whether the kind vocabulary is a closed registry from day one (the format
  question itself is resolved: `fid2:<kind>:<hash>`, last-colon parsing).
- Should the engine cache per-entity kind or parse per operation? Parsing a
  string prefix is likely cheap enough to skip the cache.
- Is value-equality dedupe on current-read commits worth the comparison
  cost, or does drop-on-stale capture nearly all of the win?
- How should dropped commits surface in telemetry and `cf inspect` so that
  a misclassified cell (state writes being silently dropped) is diagnosable
  rather than mysterious?
- Interaction with multi-space commits (`enableMultiSpaceWrites`): per-space
  commits classify independently, but the partial-failure contract needs
  re-reading against ack-and-drop.
- Whether CFC flow-label derivation needs to observe dropped writes, or is
  indifferent to them.
- Preimage embedding shape: the current implementation wraps the preimage in
  a `{ entityKind, inner }` envelope inside `createRef` (guaranteeing an
  untagged preimage — which always has a top-level `causal` key — can never
  collide bytes-for-bytes with a kind-tagged one). An alternative is to bake
  `$kind: "computed"` into the `partialCause` itself, mirroring the existing
  `$kind: "stream"` convention for generated stream cells; that would also
  let manifest matching collapse back to plain `deepEqual(partialCause)`
  instead of the current `(partialCause, kind)` pair. Deferred for now; the
  envelope approach stands.
