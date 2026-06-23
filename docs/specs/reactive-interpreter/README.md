# Reactive Interpreter — a trusted meta-node that executes a Reactive Operation Graph

> **Status**: Proposal (requirements + design + phased plan). Not yet
> implemented.
> **Substrate**: builds on `docs/specs/scheduler-v2/` (targets the v2 node
> model and states the deltas it needs).
> **Companion (formal)**: the CFC label semantics for this component are to be
> specified for proof in the CFC spec repo (`~/src/specs/cfc`). This is **new**
> proof work, not a reduction onto an existing theorem (see
> [03-cfc.md](./03-cfc.md) §8).
> **Companion docs**: [01-requirements.md](./01-requirements.md) ·
> [02-design.md](./02-design.md) · [03-cfc.md](./03-cfc.md) ·
> [04-scheduler-and-transformer-deltas.md](./04-scheduler-and-transformer-deltas.md) ·
> [05-baselines.md](./05-baselines.md) · [06-migration-plan.md](./06-migration-plan.md)

---

## 1. The problem, measured

Common Fabric lowers an authored pattern into a fine-grained reactive graph of
builder-factory calls, instantiates that graph into runtime `Cell`s and
scheduler nodes, and persists those cells as documents in memory. The
collection operators (`map`/`filter`/`flatMap`) go further: the internal `map`
implementation instantiates a **full child pattern per element**
(`runtime.runner.run(opPattern, …, perElementResultCell)` —
`packages/runner/src/builtins/map.ts:258-273`), each child minting its own
result / argument / internal documents and its own scheduler nodes.

We measured the result with an in-process harness
(`packages/runner/test/doc-explosion-measure.test.ts`, reproduced in
[05-baselines.md](./05-baselines.md)):

| Pattern | Documents | Scheduler nodes | Edit 1 elem (nodes / docs) | Load |
| --- | --- | --- | --- | --- |
| trivial (1 computed) | 4 | 6 | 2 / 2 | 38 ms |
| `map` over N=5 | 20 | 28 | 4 / 2 | 37 ms |
| `map` over N=50 | 155 | 208 | 4 / 2 | 142 ms |

The dominant terms are linear in element count (the constants are
provenance-dependent — see [05](./05-baselines.md) §2; treat them as a slope,
not an exact law):

```
documents       ≈ 5 + 3·N
scheduler nodes ≈ 8 + 4·N
```

**The wins this proposal targets, in priority order:**

1. **Steady-state footprint.** Every list element permanently costs ~3
   documents and ~4 scheduler nodes — each document a hashed, separately-synced,
   separately-conflicting, separately-observed entity ([05](./05-baselines.md)
   §4). This is the primary defect: cost scales with derived intermediate size,
   not with externally-observable output.
2. **Load / rehydration.** Instantiation is `O(N)` (37 → 142 ms from N=5 → N=50)
   and goes super-linear as a space fills
   (`default-app-note-create.bench.ts`: 14 / 24 / 60 ms note-create at 0 / 32 /
   128 notes). Resuming a piece re-instantiates every element's child pattern.
3. **Incremental recompute is already `O(1)`** for an edit (4 nodes / 2 docs,
   independent of N — the `map` coordinator reuses per-element runs). The
   interpreter must **preserve** this while removing the steady-state and load
   costs above. (We do not claim to fix edit latency; we claim to remove the
   per-element node and document that edit latency sits on top of.)

This is **not** an importer-specific problem. It is the cost shape of **every
collection-driven app** — `3·N` documents and `4·N` nodes, resident, synced,
conflicting:

- **importer + pipeline** (e.g. a Gmail importer feeding downstream
  transforms): data grows without bound over time, so the footprint and the
  `O(N)` reprocessing grow without bound — the most extreme case;
- **notes**: a list of notes mapped to views, plus the super-linear space-fill
  cost above;
- **lunch-vote**: options × voters collections, multiplied again by per-user
  scoping ([05](./05-baselines.md) §3), all conflicting under multi-user load.

The cost of a pattern scales with the size of its **derived intermediate
data**, not with its **externally-observable output** or with **what actually
changed**. That is the defect this proposal removes.

## 2. The idea

If you squint, the lowered graph is the beginning of an AST that the runtime
re-interprets as a reactive, information-flow-controlled dataflow — at the cost
of one scheduler node and a clutch of documents per AST node.

So: **stop materializing the AST as runtime objects. Emit it as data — a
Reactive Operation Graph (ROG) — and execute it with one trusted node.**

- **The Reactive Operation Graph (ROG)** is the runtime IR: a content-addressed,
  schema-annotated data form of the operation graph the transformer already
  produces, over a small closed vocabulary — reactive leaves (`lift` / `computed`
  bodies, kept opaque), `pattern` invocation, the collection operators
  (`map` / `filter` / `flatMap`), helper control flow (`ifElse` / `when` /
  `unless`), structural access (`key`), and value construction. It is the same
  *normalized authored graph* the CFC formalization's authored-graph→operation-
  graph bridge already models in spirit (`~/src/specs/cfc/formal/`); note the
  Lean type literally named `ReactiveOperationGraph`
  (`Cfc/Proofs/OperationGraphBridge.lean`) is a **different, audience-delivery
  abstraction** — connecting the interpreter to a formal model is new work
  ([03-cfc.md](./03-cfc.md) §8).

- **The Reactive Interpreter** is a single, trusted scheduler node — the
  "meta-node" — that executes a ROG *as data*. Because it sees the whole
  sub-graph at once, it can:
  1. **be incremental** — recompute only the inner operations a change actually
     affects, instead of re-running whole nodes blind;
  2. **cache the invariant work** — the inner topological order and the
     *structure* of label propagation are stable for a fixed ROG shape, so they
     are computed once (the order may be precomputed at transform time as an
     untrusted, soundness-inert hint; the propagation *structure* is a hint the
     interpreter re-derives or verifies — §[03-cfc.md](./03-cfc.md) §3);
  3. **not materialize internal state** — only cells reachable from an
     externally-observable boundary (what the pattern returns, what it renders,
     what handlers write, plus user state and checkpoints) become documents;
     everything else lives inside the interpreter;
  4. **stay information-flow-correct** — it propagates CFC labels itself, as
     trusted runtime code.

It is, in one line, **a trusted interpreter for a reactive, CFC-aware dialect
of the JavaScript subset we already lower into.** The leaves stay as today's
sandboxed JS (`lift` bodies); the interpreter only interprets the reactive
*skeleton* between them.

## 3. What changes (one paragraph)

A `map` over N elements stops being `1` coordinator node + `N` child patterns +
`~3·N` documents + `~4·N` nodes. It becomes **one interpreter step inside one
meta-node**, holding the N element results as inline entries (with per-entry,
path-granular CFC labels) in the one container the pattern already returns.
Per-element documents and scheduler nodes are gone; the interpreter recomputes
an element only when that element's inputs change; expensive element results
may be *checkpointed* back into documents (a memoization tier) so a restart
does not recompute a million-row pipeline from scratch. The target document /
node footprint scales with **observed output + checkpoints**, not with **N**
(the persistent *read-index* still scales with distinct external reads —
[05](./05-baselines.md) §5).

## 4. Goals and non-goals

### Goals

- **G1 — Footprint tracks output, not intermediate size.** The steady-state
  document and scheduler-node count of a ROG instance is `O(externally
  referenced outputs + checkpoints)`, not `O(intermediate nodes × elements)`.
  (The persistent read-index remains `O(distinct external reads)`; see
  [05](./05-baselines.md) §5 and the scoped-collection caveat,
  [01](./01-requirements.md) §9 open question 1.)
- **G2 — Incremental cost tracks change.** Recompute on a change is
  `O(affected inner operations)`, and the already-`O(1)` edit is preserved.
- **G3 — Same observable semantics; CFC soundness preserved.** Authored patterns
  produce identical results, reactive behavior, and externally-visible documents
  (for cells that remain external). The interpreter's per-output labels are a
  sound over-approximation of today's per-element-transaction labels
  (§[03-cfc.md](./03-cfc.md)). **This is a tradeoff, not a security improvement:**
  today's collection operators get pointwise precision *structurally* (the
  preferred mechanism, CFC §8.5.4.3) by paying the per-element-transaction cost;
  the interpreter deliberately stops paying it and therefore **re-incurs** a
  trusted flow-precision-claim obligation (CFC §8.9.1) that decomposition
  currently discharges for free. The justification is the measured footprint
  win, not CFC.
- **G4 — Formalizable.** Every load-bearing interpreter operation gets normative
  pseudocode in the CFC spec, structured to map onto Lean. The soundness story
  is **new proof work** — a fresh operational model of ROG evaluation plus a
  labeled decomposed reference semantics and a refinement theorem
  (~10 obligations, ~5 new model surfaces; [03-cfc.md](./03-cfc.md) §8,
  [06](./06-migration-plan.md) §6). It is *not* a reduction onto an existing
  theorem.
- **G5 — Default execution model, staged.** The interpreter becomes how
  patterns run; per-node materialization is retired incrementally, not
  forked permanently.

### Non-goals

- **NG1 — Finer-grained leaves.** `lift` / `computed` / `handler` bodies stay
  opaque sandboxed JS with coarse "all inputs taint all outputs" labels. Pushing
  IFC *inside* leaf bodies is explicitly out of scope (future work; noted in
  [01](./01-requirements.md) §6).
- **NG2 — A new trust root.** The transformer remains *not* a trust boundary
  (NG-001). Nothing the transformer emits is trusted; the interpreter is the
  trust boundary and recomputes labels from real runtime data
  (§[03-cfc.md](./03-cfc.md) §3).
- **NG3 — Interpreting arbitrary JS.** The interpreter executes only the closed
  reactive dialect (ROG node kinds). Anything outside it is already a `lift` and
  runs in the sandbox unchanged.
- **NG4 — A second propagation channel.** The interpreter's internal
  incrementalism must not become the in-process side-channel scheduler-v2
  deleted (P1). It is the *interior of one node*, driven from the one storage
  notification channel (§[02-design.md](./02-design.md) §5).
- **NG5 — Preserving internal-cell identity across the migration.** Internal
  (derived) cells may change or disappear; only user state (Writables, changed
  pattern arguments) and externally-referenced outputs are preserved
  (§[06-migration-plan.md](./06-migration-plan.md)).

## 5. Document map

| Doc | Contents |
| --- | --- |
| [01-requirements.md](./01-requirements.md) | Precise requirements (R-*) for the ROG, the interpreter, and supporting subsystems; invariants (I-*); the hardest inherited constraints; the open questions. |
| [02-design.md](./02-design.md) | The ROG format; the interpreter architecture — evaluation, incrementality, the materialization boundary, the checkpoint/memoization tier, persistence/resume — with pseudocode. |
| [03-cfc.md](./03-cfc.md) | The CFC trust model: interpreter as a trusted flow-precision claimant; the integrity-meet vs view-union distinction; read isolation; pointwise vs filter/flatMap; fail-closed; the prerequisite trust gate; correspondence to the formal spec and the new proof obligations. |
| [04-scheduler-and-transformer-deltas.md](./04-scheduler-and-transformer-deltas.md) | Prerequisites (unbuilt machinery), and exact deltas to scheduler-v2 (node kind, write surface, demand, read-set, idempotency, persistence, convergence signalling) and to the transformer. |
| [05-baselines.md](./05-baselines.md) | The measured baseline numbers (pinned), the cost model, and the scoped target numbers. |
| [06-migration-plan.md](./06-migration-plan.md) | Phased plan with work-orders, the differential oracle (the permanent correctness gate), the formal-proof obligations, data migration, and risks. |

## 6. Relationship to in-flight work

- **scheduler-v2** (`docs/specs/scheduler-v2/`): the interpreter is a new node
  *kind* in the v2 model and a generalization of the **materializer envelope**
  (v2 §4.3) — the existing sanctioned "one node, broad write surface."
  [04](./04-scheduler-and-transformer-deltas.md) states every delta, including
  the ones that genuinely extend v2 (multi-output write surface, interior
  non-convergence signalling, an idempotency-recheck hook).
- **content-addressed-action-identity** / **pattern-id-retirement**: the
  interpreter reuses the existing `{identity, symbol}` content-addressed
  identity for ROG leaves and externally-referenced outputs; for internal cells
  reached by a retained deep link, ids stay **causal to their inputs** (e.g. a
  `map` output is causal to the input list's id) by carrying the cause
  derivation through ([01](./01-requirements.md) R-MAT-3).
- **ts-transformer** target language: the ROG is the data form of the existing
  lowering. Emitting a ROG instead of executable builder calls is a genuine
  *extension* of the lowering contract (the §3.1–3.9 semantic obligations still
  hold); it is argued on its merits in
  [04](./04-scheduler-and-transformer-deltas.md) §7, not by appeal to the
  contract's internal phase-ordering clause.
- **CFC spec** (`~/src/specs/cfc`): the interpreter is a new runtime
  implementation profile that must conform to §8.9 runtime propagation and
  reproduce §8.5 pointwise/collection semantics. Its soundness is new proof
  work ([03-cfc.md](./03-cfc.md) §8).
