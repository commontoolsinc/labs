# Baselines, cost model, and targets

Performance is the primary goal, so the spec is anchored on measured numbers, not
intuition. This document records the baseline measurement, the per-document cost
model it implies, and the target numbers the interpreter must hit.

---

## 1. The measurement harness

`packages/runner/test/doc-explosion-measure.test.ts` (in-process, emulated
storage, no browser) instantiates a pattern and counts, via verified probes:

- **distinct documents** — subscribe to the `StorageManager`; a commit
  notification change with `before === undefined` at the root path is a new
  document (`storage/v2.ts` commit notifications);
- **scheduler nodes** — `runtime.scheduler.getGraphSnapshot()` node/edge counts;
- **recompute on edit** — `getReactivityLog().writes` distinct ids + node
  run-count deltas when one input changes;
- **load proxy** — wall time of initial `run().commit()` + first sink.

Run:

```bash
cd packages/runner
deno test --allow-read --allow-write --allow-net --allow-ffi --allow-env \
  test/doc-explosion-measure.test.ts
```

It prints a report (no asserts fail by default; `MEASURE_STRICT=1` asserts the
law). The harness is the reusable instrument for the [06](./06-migration-plan.md)
differential oracle and the target-number regression.

## 2. Measured baseline (current system)

> **Pinning.** These are "as last measured" on the worktree at spec-authoring
> time, in-process emulated storage, single run (the harness has no default
> assert; `MEASURE_STRICT=1` asserts only the positive slope). The observation
> `2.40×/5.72×` figures come from `v2-scheduler-observation-persistence.bench.ts`
> at `paths=25` / churning read-set on an M3 Max. Re-pin to a commit + run config
> before treating any constant as fixed; the constants are
> provenance-dependent (cell-link vs inline element), the **slope** is the claim.

| Pattern | Documents | Scheduler nodes | Edit 1 elem (nodes / docs) | Append 1 (nodes / created / rewritten) | Load |
| --- | --- | --- | --- | --- | --- |
| trivial (1 computed, no list) | 4 | 6 | 2 / 2 | — | 38 ms |
| `map` over N=5 | 20 | 28 | 4 / 2 | 6 / 4 / 6 | 37 ms |
| `map` over N=50 | 155 | 208 | 4 / 2 | 6 / 4 / 6 | 142 ms |

Linear fit over N ∈ {5, 50}:

```
documents       = 5 + 3·N      (per-element: 3 documents)
scheduler nodes = 8 + 4·N      (per-element: 4 nodes)
```

Reconciliation with prior probes: the "3 documents/element" here is the
cell-link element case folded with inner-node count; an inline-value element or a
multi-inner-node element op shifts the constant slightly (run-meta + argument +
1/inner-node). The **slope is the point**: every element adds a fixed, permanent
document and node cost.

Observations:

- **Edits are already `O(1)`** (4 nodes / 2 docs regardless of N) — the `map`
  coordinator reuses per-element runs. The interpreter must *preserve* this.
- **Load is `O(N)`** (37 → 142 ms from N=5 → N=50) and is known to go
  super-linear as a space fills (`default-app-note-create.bench.ts`: 14 / 24 /
  60 ms note-create at 0 / 32 / 128 notes, +41 traverse calls and +28 dirty-visits
  per existing note per create). This is the cost the interpreter removes: it does
  not instantiate N child patterns at load.
- **Steady state is `5 + 3N` documents, forever** — the dominant scaling defect.

## 3. The workloads this hurts (spread, not a single case)

The `3 docs + 4 nodes per element` tax is paid by every collection-driven
pattern. Three points on the spectrum:

- **importer + pipeline** (e.g. Gmail importer → downstream transforms):
  `N` grows **without bound** over time, so documents, nodes, sync, conflict
  surface, and `O(N)` reprocessing grow without bound. The most extreme case, but
  the same mechanism.
- **notes**: a steady list mapped to views — `3N` docs / `4N` nodes plus the
  super-linear space-fill cost above.
- **lunch-vote**: options × voters collections × per-user scope multiplier, all
  conflicting under multi-user load — the `3N` is multiplied again by scoping.

## 4. Per-document cost model (why `5 + 3N` is expensive)

A document is not a row. Each of the `3N` documents is (all verified in the
memory/data-model code):

| Axis | Cost per document |
| --- | --- |
| At rest | append-only revision chain (never overwritten, retain-all) + periodic snapshot + head upsert; **× scope_key** (PerUser/PerSpace multiplies one causal id into N physical instances). |
| Per write | commit row + revision/op + head upsert + snapshot in one DB tx; SHA-256 merkle hash (value hashing is ~29% of note-create worker CPU; deep-freeze ~12%). |
| Conflict | whole-document conflict unit; `set`/`delete` conflicts any confirmed read (path-agnostic). Internal result cells are coarse whole-doc conflict participants. |
| Scheduler | 1 persistent observation/run + 1 `scheduler_read_index` row per read-path + 1 `scheduler_write_index` row per write-path — even on no-op commits. Observation persistence measured at **2.40× (paths=25) to 5.72× (churning read-set)** vs no observation. |
| Sync / load | in the watch-union if reachable; `internal` lineage followed transitively; in the initial FactSet. |
| Link hop | 1 storage read + 1 reactivity dependency per hop. |

So `5 + 3N` documents is `5 + 3N` separately-hashed, separately-synced,
separately-conflicting, separately-observed entities — and the observation
multiplier and conflict surface are themselves super-linear in change rate. The
interpreter's `O(1 + checkpoints)` document footprint attacks every row of this
table at once.

## 5. Targets

The interpreter MUST hit these (measured by the same harness, extended with an
interpreter mode):

- **T-DOCS — `O(1)` documents per non-scoped ROG instance.** A `map` over N
  elements where the result is consumed but no element is externally referenced or
  checkpointed MUST materialize a constant number of **documents** (the result
  container with N inline entries + user state), **independent of N**. Concretely:
  replace `~5 + 3N` documents with a small constant (target ≤ ~5, dominated by the
  container + user-state cells), plus one document per checkpointed element only.
  **Per scope context.** For scoped data (PerUser/PerSession), the target holds
  per observed scope; genuinely scope-varying *outputs* exist per observed scope
  (intrinsic to scoping — per-user data is per-user), but the scaffolding and
  scope-invariant work never multiply by scope ([02](./02-design.md) §3.4,
  [01](./01-requirements.md) R-SCOPE). This is a **document** target; the
  persistent **read-index** stays `O(distinct external reads)` (still `O(N)` for
  per-element external reads — the importer case — but cheaper rows; see §4 and the
  cost-model row). G1/I2 are scoped to documents+nodes, not read-index rows.
- **T-NODES — `O(1)` scheduler nodes.** Replace `8 + 4N` scheduler nodes with
  `O(1)` (the interpreter node + its effects), independent of N.
- **T-EDIT — preserve `O(1)` edit.** Editing one element MUST remain `O(1)`
  recompute (interior: one element op + downstream-in-ROG), and MUST rewrite only
  the affected portion of the container (path-granular write), not the whole
  container.
- **T-LOAD — sub-linear resume.** Resuming a piece with N checkpointed elements
  MUST be `O(checkpointed + demanded)`, not `O(N)` re-instantiation. Cold load of
  an unchecked `map` MUST be `O(1)` instantiation + `O(N)` *pure computation*
  (no per-element document/ node creation), i.e. dominated by leaf CPU, not by
  storage/scheduler scaffolding.
- **T-CONFLICT — fewer participants.** The number of documents participating in
  optimistic commit/conflict for a list-update MUST drop from `O(N)`-resident to
  `O(changed + checkpointed)`.
- **T-CFC — no precision regression.** Per-output labels MUST be ≥ the
  per-element-transaction labels on a CFC differential corpus (the
  [06](./06-migration-plan.md) §4 oracle), with zero label *narrowing* that lacks
  a passing trust gate.

## 6. Spike validation (measured, 2026-06-23)

A throwaway spike (`packages/runner/test/spike-map-interpreted.test.ts`)
implemented `mapInterpreted` — a test-only builtin that collapses `map`-of-leaf
into one coordinator node computing the leaf inline and holding results in one
inline container (no per-element child pattern). Measured against legacy `map`
in the same harness:

| | docs | sched nodes (computation) | load | edit (nodes / docs) |
| --- | --- | --- | --- | --- |
| legacy `map` N=500 | 1505 | 2008 (501) | 948 ms | 4 / 2 |
| `mapInterpreted` N=500 | **5** | **508 (1)** | **87 ms** | 3 / 2 |

- **Documents: slope `3.0/element → 0.0`** — flat at 5 regardless of N (1505 → 5
  at N=500). The scaffolding explosion is eliminated. **T-DOCS validated.**
- **Computation nodes: N → 1** (one coordinator). **T-NODES validated** for the
  computation tier. The residual total-node slope (~1.0/element) is the **N
  genuine input cells** (the read-index), *exactly* the `O(distinct external
  reads)` the design predicts stays — not scaffolding.
- **Load ~11× faster** at N=500 (948 → 87 ms). **T-LOAD** directionally validated
  (cold load is now leaf-CPU + input reads, no per-element instantiation).
- **Edit stays `O(1)`** (3 nodes / 2 docs at every N). **T-EDIT preserved.**
- **Falsifier disproven, empirically:** the container edit wrote at **pathLen 2**
  — a path-scoped array patch at the index, not a whole-container rewrite. With
  `buildPatchOperation` emitting array-aware patches and `patchOverlapsRead`
  scoping conflicts by path, inline-value containers are viable even for large
  values.

**Not validated by the spike (deliberately):** CFC per-element labels — the naive
coordinator reads the whole list in one transaction and would *smear* labels;
pointwise soundness requires the read-isolation mechanism (§[01](./01-requirements.md)
OQ-4), which is an implementation effort, not a spike. So **CFC soundness reduces
entirely to OQ-4**; the footprint/load win and basic feasibility are confirmed.
Also out of spike scope: filter/flatMap, control flow, nested patterns, scoped
cells, the op passed in (leaf hardcoded), and externally-referenced element
results.

## 7. Measurement plan during implementation

- Extend the harness with an **interpreter mode** so every row of §2 is measured
  for both models on identical patterns, producing the before/after table as a CI
  artifact (the spike §6 is the prototype of this).
- Add the three spectrum workloads (§3) as fixtures: an unbounded-growth importer
  simulation (append M items, measure footprint + resume at M = 1k, 10k), a notes
  list, and a multi-user lunch-vote.
- Track the per-document cost-model axes (§4) that change: observation row counts,
  conflict participants, sync FactSet size — not just raw document count.
- Build the CFC differential oracle on a read-isolated `mapInterpreted` once OQ-4
  has a mechanism: assert per-index labels match legacy (conf ⊇, integrity ⊆).
