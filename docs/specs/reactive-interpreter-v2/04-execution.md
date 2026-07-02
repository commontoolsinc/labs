# 04 — Execution: partition, segments, collections, materialization

The execution model is v1 07's coalescing architecture, kept: boundaries
(effects/handlers/collections-with-effectful-elements) are ordinary scheduler
nodes; maximal pure regions become segment nodes; the scheduler runs the
coarser DAG unchanged. What changes is where the pieces live and the two seam
extensions v1 deferred.

## 1. Partition — harvested, with a richer output

`partition.ts` from #4298 carries over nearly verbatim (it is a pure layered
topological assignment + union-find, source-agnostic). Deltas:

- Boundary classification reads IR effect contracts
  ([02-ir.md](./02-ir.md) §2.4) — no classifier heuristics, no
  `unresolvedLeafOps` side-channel (an unresolved opaque ref is a loader
  failure, not a partition input).
- **F4 cut edges by construction**: `effect.writeTargets` feed
  `boundary → (segments reading its write-back targets)` edges, closing v1
  07 §8 F4 structurally.
- The output describes scheduler nodes directly: per segment, the exact
  input paths (read set), output cells (write set), cross-segment links, and
  fan-out — so the emission layer consumes a plan instead of re-deriving one
  (v1's `tryBuildPartitionedInterpreterPattern` re-derivation is what grew
  to ~1,100 lines).
- Unresolved refs are **errors**, not external inputs (v1's fail-open edge).
- Cost gate: below the crossover (~3 pure leaves, v1-measured) the plan says
  "expand legacy"; trivial patterns never pay the +1 segment node.

Partition runs at **load time** over the compiled IR and is cached by
artifact identity. (Not compile time: the boundary set can evolve with the
runtime — e.g. a builtin reclassified I/O vs handler-sink — without
recompiling the world. The IR carries facts; the runtime carries policy.)

## 2. Segment emission — a module, not a runner limb

v1's biggest scar: dispatch, eligibility, trust, and emission interleaved
into runner.ts (7,922 lines; the partition seam alone ~1,100). v2 puts
plan-consumption in a dedicated module with a deliberately narrow runner
API:

```text
RunnerSeam := {
  mintCell(cause, schema, scope): Cell
  emitNode(kind, reads: PathSet, writes: CellSet, impl): NodeHandle
  wireResultPath(path, source: Cell | InlineValue): void
}
```

Everything else — seeding, cross-segment links, boundary preservation,
inline-result-path writes — lives in the emission module and is unit-testable
against a fake seam. The runner's own diff for v2 should be measured in
hundreds of lines, not thousands.

## 3. The evaluator

`evalRog` from #4298 carries over: eager topological pass, per-op error
isolation (`NotInterpretedHere` becomes a loader-time impossibility; runtime
op errors isolate to `undefined` + error report, matching legacy). Deltas:

- **Seeding is keyed by boundary**, not scattered op ids: a segment's
  external inputs are (boundary output | earlier segment output | named
  cell) triples declared in the plan; the input-marker *nodes* from v1 (+263
  measured) are replaced by this metadata.
- **Per-path read sets** (D-V2-READSETS): the plan's input paths become the
  node's declared reads using `trigger-index.ts` match semantics exactly.
  A segment re-runs only when a path it reads changes. This discharges the
  spurious-re-run half of v1 OQ-C4 by construction; the oracle gate
  (segment re-runs ⊆ legacy re-runs under input mutation) stays as the
  regression tripwire.
- Whole-segment re-eval remains the semantics; R-SEAM-2 (per-trigger delta,
  V5a) is an optimization for collections and large segments, never a
  correctness dependency.
- Read-only cell context (v1 §4.9 / 2(b)) carries over as evaluator hooks
  (`inputCellViews` + read-only wrapping backed by the enforced
  `readOnlyReason`), driven by the compiler's `needsCellContext` +
  `writesInput` annotations instead of runtime write-scans.

## 4. Collections

Option A per D-V2-LABELS: coordinator node + per-element scheduled effects,
each read-isolated to its slot, each writing one per-element result doc;
container holds links; identity-only coordinator reads (the
`linkResolutionProbe` discipline) keep the coordinator's flow-join empty.

Fixes over v1's `$ri-collection-map`:

- The element Rog is inline in the IR — extracted never, compiled once.
- Element cell identity: cell cause is keyed by slot identity (stable across
  reorder) with index as position metadata, and cells for departed slots are
  **released** (v1 minted `{collectionInterpreterElem, index}` cells and
  never GC'd them; v1 02 §3.4's `releaseAbsent`/`gcCheckpointsFor` finally
  gets implemented).
- Subscription reconciliation moves as close to the scheduler as the seam
  allows; if a container-of-links output can become a scheduler-tracked
  primitive, the coordinator loop shrinks to element lifecycle only.
- `filter`/`flatMap` keep v1 03-cfc §5.3's label treatment (container
  structural label for membership; `ElementLocalExpansion` /
  `StableRelativeOrder` for flatMap) and remain **after** map in the
  schedule; they were never built in v1 and are not v2-core either.

## 5. Result materialization — one seam, two backends

All interpreter writes go through a single materialization seam that owns
the two v1-hard-won rules:

1. **Consolidated subtree writes.** Rendered/VNode subtrees are written with
   the raw consolidated primitive (v1 §4.8: `setRawUntyped` +
   `fabricFromNativeValue(convertCellsToLinks(...))`, legacy
   `updateResultProjection`'s idiom) — never through `Cell.set`, whose
   `recursivelyAddIDIfNeeded` → `normalizeAndDiff` hoisting fragments one
   subtree into a doc per node (the measured +2 docs/element inversion).
2. **Inline result paths.** A result-tree-only segment output writes inline
   at `result.<field>` (v1's inline-result-path emission, the −34% docs
   unlock), with the multi-user co-located shared-write contention gate
   carried over verbatim.

The seam's element-result backend is per-element docs today; if R-SEAM-3
lands (V5b), the same seam writes inline slots + per-path labels — consumers
and the evaluator never change (D-V2-LABELS).

Scope handling carries v1 D-R1/D-EMISSION-SCOPE unchanged: one interpreter
run is one scope context; narrowest-scope-read carries through to each
output's effective scope; cross-space `.inSpace`/`.asScope` routing is a
permanent boundary.

## 6. Checkpoint tier

Deferred (V5c), but the materialization seam is designed so a checkpoint is
just "persist this opOut, `derivedFrom` = its transitive external reads" —
v1 02 §4.1's design, which nothing in v2 contradicts. Whether it is worth
building depends on whether the unbounded importer/pipeline workload (v1's
motivation #1) is still a target; that is a product decision to confirm
before V5c, not an architectural one.

## 7. Instrumentation is a product surface

v1's census/footprint instrumentation was the campaign's steering wheel and
its most repeated lesson (green-via-fallback, twice). v2 keeps, permanently:

- the engagement census (now a *compiler* statistic for lowering coverage +
  a load-time statistic for partition engagement), dumped in CI;
- the footprint accounting harness (docs/nodes per pattern, slope per
  element) and the doc-explosion baseline law;
- the OQ-C4 invalidation oracle and the re-run counters
  (`RI_EXEC_DUMP`-class tracing) that root-caused the pull-amplification
  pathology.
