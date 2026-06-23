# Requirements

This document states the precise requirements for the Reactive Operation Graph
(ROG), the Reactive Interpreter, and the supporting subsystem changes, plus the
invariants the design must hold and the inherited constraints it must satisfy or
explicitly supersede.

Requirements are normative (`MUST` / `SHOULD` / `MAY`). They are referenced from
the design ([02](./02-design.md)), CFC ([03](./03-cfc.md)), and deltas
([04](./04-scheduler-and-transformer-deltas.md)) docs.

---

## 1. The Reactive Operation Graph (ROG)

The ROG is the runtime IR the interpreter executes. It is data, not executable
builder calls.

- **R-ROG-1 (closed vocabulary).** The ROG MUST consist only of nodes drawn from
  a small closed set of *operation kinds*:
  - `leaf` — an opaque computation: a `lift` / `computed` body, referenced by
    content-addressed implementation identity, with declared input and output
    schemas. The interpreter does not look inside a `leaf`.
  - `pattern` — a (possibly nested) ROG invoked with bound inputs.
  - `collection` — `map` / `filter` / `flatMap` over a reactive list, applying a
    sub-ROG (the element op) per element.
  - `control` — `ifElse` / `when` / `unless`: a predicate selecting among
    sub-ROG branches.
  - `access` — structural navigation: `key(path)` / element access over a
    reactive value.
  - `construct` — building object / array values from sub-results (the
    object-property and array-element lowering sites).
  - `effect` — a sink (UI render, `pull`) or a handler stream binding (the
    demand sources / event surface).

  Any authored construct outside this vocabulary MUST already have been lowered
  by the transformer into a `leaf` (the existing "stop / whole-wrap" rule). The
  interpreter MUST NOT attempt to interpret arbitrary JavaScript.

- **R-ROG-2 (schema-annotated boundaries).** Every node MUST carry the
  argument/result JSON Schemas (with `asCell` capability tags and any `ifc`
  annotations) the transformer already emits. These schemas are the interpreter's
  contract for traversal, capability, and label structure.

- **R-ROG-3 (explicit, minimal captures).** Inputs MUST be explicit, minimal
  reference trees (the existing `{ state: { x: argument.key("x") } }` capture
  form). The interpreter MUST NOT rely on hidden lexical capture.

- **R-ROG-4 (content-addressed identity).** Every `leaf` and `pattern` MUST be
  referenced by the existing `{ identity, symbol }` content-addressed handle
  (`$implRef` / `$patternRef`), resolvable through the session implementation
  index. The ROG MUST NOT introduce a new identity scheme.

- **R-ROG-5 (serializable & self-contained).** A ROG MUST be serializable as a
  value (a successor to the deferred `GraphSnapshotV1` / a normalized form of the
  existing `Pattern` object) and self-contained given the implementation index —
  i.e. interpretable without re-running the builder.

- **R-ROG-6 (semantic fidelity).** Executing a ROG MUST preserve the authored
  semantics the lowering contract requires (control-flow/short-circuit/
  parenthesization, context boundaries, capture minimality, sparse-array
  behavior, per-builtin scope narrowing). The ROG is a faithful encoding of the
  same operations, not a re-derivation.

## 2. The interpreter — execution

- **R-EXEC-1 (single trusted node).** The interpreter MUST present to the
  scheduler as **one node** with verified implementation identity
  (`kind: "builtin"`). All work for a ROG instance happens inside that node's
  runs.

- **R-EXEC-2 (incremental recompute).** On an input change, the interpreter
  MUST recompute only the inner operations whose inputs that change actually
  affected (value-accurately), plus their downstream closure within the ROG. A
  whole-ROG re-evaluation MUST NOT be required for a localized change. (This is
  the property full-node re-runs lack today — R-EXEC-2 is the core performance
  requirement.)

- **R-EXEC-3 (cached invariant work).** For a fixed ROG, the inner topological
  order and the *structure* of label propagation (which input flows to which
  output) do not change run-to-run and MUST be computed at most once per ROG
  shape (and MAY be supplied as a transform-time hint, subject to R-CFC-2).
  Work that *does* vary with data (which control-flow branch is live, which list
  elements exist) MUST be recomputed when the data it depends on changes
  (R-EXEC-5).

- **R-EXEC-4 (idempotent result).** The result of incremental evaluation MUST
  equal the result of evaluating the ROG from scratch against **the same pre-run
  inputs**. The interpreter run as a whole MUST satisfy the scheduler idempotency
  contract. Because the inline validator (`diagnosis.ts:275`) blindly re-invokes
  the node and `InterpreterState` is mutated in place, validating this requires a
  new recheck hook (`node.evalFromScratch`) running `evalFull` against a
  **throwaway state clone** and a **pre-run input snapshot** (not post-commit
  state), and/or the **differential oracle** as the permanent correctness gate
  (see [04](./04-scheduler-and-transformer-deltas.md) §4,
  [06](./06-migration-plan.md) §4). The naive "re-invoke and diff" cannot witness
  interpreter incrementalism bugs.

- **R-EXEC-5 (data-dependent graph shape).** The interpreter MUST handle the
  reactive graph rewiring through data: `control` nodes change which branch's
  read-set is live run-to-run; `collection` nodes change which elements exist;
  `access` over links changes the traversal target. A cached order MUST be
  invalidated when the link-shaped reads that determine it change. (Inherits
  scheduler-v2 D3/D4.)

- **R-EXEC-6 (bounded convergence).** The interpreter MUST inherit the
  scheduler's convergence bounds (per-pass iteration cap, per-node run budget,
  escalating backoff) for its own internal iteration. A non-converging ROG MUST
  degrade to rate-limited retries without starving the rest of the system, and
  MUST NOT violate the `idle()` / `settled()` contract.

- **R-EXEC-7 (leaves unchanged).** `leaf` evaluation MUST run the existing
  sandboxed JS implementation through the existing harness, with the existing
  coarse label treatment (NG1). The interpreter orchestrates leaves; it does not
  re-implement them.

## 3. The interpreter — materialization boundary

- **R-MAT-1 (reachable-from-egress).** The interpreter MUST materialize as
  documents exactly the cells reachable, transitively through links, from any
  **externally-observable egress** — the pattern's **return** value, the **render
  tree** (`[UI]`), **effect sink** inputs (fetch/llm/mail), and the cells
  **handlers write** that the UI subscribes to — **plus** user state (Writables
  and changed pattern arguments) and checkpointed results (R-MAT-4). Keying on the
  return value alone would mis-classify render-read and handler-written cells as
  internal (MA-8). All other internal state (intermediate operation results,
  per-element scaffolding, argument/process cells not reachable from an egress)
  MUST remain inside the interpreter and MUST NOT be materialized.

- **R-MAT-2 (outermost owns persistence).** For nested patterns
  (patterns-calling-patterns), only the **outermost** pattern's return
  reachability determines what persists. An inner pattern's internals are
  internal to the interpreter unless reachable from the outermost return.

- **R-MAT-3 (causal ids; materialize the reachable closure).** Materializing the
  full egress-reachable closure (R-MAT-1) handles the common case directly. For
  the residual case where something external retains a **deep link** into interior
  structure, output ids MUST stay **causal and stable**: an output's id is causal
  to its inputs (e.g. a `map` output is causal to the input list's id; scope is
  excluded from the cause), and the interpreter MUST **carry that causal
  derivation through** (input-id → output-id) so retained deep links resolve
  identically across runs and reloads. This is the existing cause-derivation
  mechanism threaded through the interpreter — not a new identity scheme.

- **R-SCOPE (carry effective scope to outputs).** The interpreter run executes in
  one runtime scope context (one user/session); its interior state is
  non-serialized and therefore implicitly that scope's data — no per-scope
  interior keying is required. The load-bearing requirement is **dynamic scope
  carry-through**: the interpreter MUST track the **narrowest scope actually read**
  while computing each output and stamp the output's effective scope accordingly
  (`scoped-cell-instances.md` computation rule: effective output scope = narrower
  of result-schema scope and narrowest scope read). Static schema scope only clips
  a maximum; the actual scope is data-determined. This is what lets one stable
  output link resolve to each reader's per-scope instance.

- **R-MAT-4 (checkpoint tier).** The interpreter MUST be able to *checkpoint*
  selected expensive internal results as documents that behave like outputs:
  they are stored, and scheduler/interpreter state records what they are derived
  from so they can be invalidated and recomputed incrementally rather than
  recomputed from scratch on restart. Checkpoint selection MUST default to an
  automatic cost/size heuristic and MUST support an author override
  (force/forbid). A checkpoint MUST never change observable semantics — it is a
  cache, not a result.

- **R-MAT-5 (no orphan growth).** Internal state that is no longer reachable
  (e.g. an element removed from a list) MUST be releasable. The current `map`
  leak (unbounded `elementRuns` growth, `map.ts:285-291`) MUST NOT be
  reproduced.

## 4. The interpreter — persistence & resume

- **R-PERSIST-1 (interface-level resume state).** The interpreter MUST persist
  resume state that is predominantly about its **interface** — its external
  read-set (what it reads), its outputs, gate configuration, status/fingerprints
  — as a (richer) scheduler observation. It MUST NOT persist the full interior
  operation-by-operation state.

- **R-PERSIST-2 (checkpoint-anchored interior).** On resume, the interpreter MUST
  rehydrate from its checkpoints (R-MAT-4) plus its external inputs, and
  recompute only the interior that is not checkpointed and is demanded. Resuming
  MUST NOT recompute checkpointed sub-results whose inputs are unchanged, and
  MUST NOT require recomputing a large `collection` from scratch when its element
  results were checkpointed.

- **R-PERSIST-3 (inactive-piece dirtying).** Not materializing internal state
  MUST NOT blind cross-piece dirty propagation. The interpreter MUST persist (or
  expose) enough of its external read/write index that another piece's commit can
  still dirty it through the persistent indexes (inherits the
  persistent-scheduler-state correctness invariants: missing/invalid observations
  are never treated as clean; writes are over-approximated when uncertain).

- **R-PERSIST-4 (restart equivalence).** Resuming a piece whose observations and
  checkpoints validate MUST yield the same set of future runs and the same
  outputs as a process that stayed alive (modulo durable-dirty markers). Resuming
  with invalid/missing state MUST degrade to recompute, never to incorrect
  cleanliness.

## 5. CFC requirements

These are summarized here and specified in full in [03-cfc.md](./03-cfc.md).

- **R-CFC-1 (interpreter is the trust boundary; correct join).** Label values
  MUST be derived by the interpreter from the labels of the data it actually reads
  at runtime. The interpreter runs under verified implementation identity; nothing
  the transformer emits is trusted for label values. Deriving an output label MUST
  use the **flow join** (confidentiality union + class-aware integrity **meet**,
  `deriveFlowJoin` semantics), NOT `mergeCfcLabelViews`/`mergeLabel`, which union
  *both* axes and would raise integrity (the unsound dual direction,
  [03](./03-cfc.md) §4). View accumulation (union) is only for *carrying* labels
  at distinct paths, never for deriving one.

- **R-CFC-2 (structure is an untrusted hint).** The transformer MAY emit the
  *structure* of label propagation (which input flows to which output) and a
  precomputed inner order. The interpreter MUST treat these as hints: either
  re-derive them from the ROG, or verify them cheaply, and MUST fail closed to
  the conservative computation if a hint is absent or fails verification. A hint
  MUST NOT be able to *narrow* (make less restrictive) a label without passing
  the §8.9.1 trust gate.

- **R-CFC-3 (collection precision as a trusted claim, split by operator).** Where
  the interpreter replaces per-element-transaction decomposition with batched
  evaluation, it MUST assert the appropriate flow-precision claim as a **trusted
  claim** under its TCB implementation identity (R-6: the interpreter is in the
  trusted computing base; no per-ROG-hash trust), gated through the §8.9.1
  mechanism (which must be **built**, R-CFC-GATE), failing closed otherwise. The claim differs by operator: `map` asserts
  `PointwisePresencePreserved` + `PointwiseWriteDependency`; `filter` / `flatMap`
  assert `ElementLocalExpansion` + `StableRelativeOrder` and additionally taint
  the **container structural** label with membership/order/multiplicity
  ([03](./03-cfc.md) §5.3). Per-output labels MUST be a sound over-approximation
  of the per-element-transaction labels. This is a **net increase in
  trusted-claim surface** relative to today's structural decomposition, not a
  security improvement (G3).

- **R-CFC-ISO (read isolation is enforced, not asserted).** Per-element evaluation
  MUST run against a read-scoped view in which observing another element's data is
  *impossible* (a cross-element read is a runtime error, not a silent join),
  factoring element evaluation through `(i, xs[i])`. The pointwise claim is sound
  *only* under this enforcement; the differential oracle MUST fail closed on any
  element label below that element's isolated-read flow join
  ([03](./03-cfc.md) §5.2). This is the load-bearing soundness obligation.

- **R-CFC-GATE (the trust gate is a prerequisite, not existing infra).** The
  §8.9.1 trust gate (`isTrustedForConcept`, `flow-taint-precision`, concept-trust
  delegation, `deriveLabelWithTrustGate`) does **not** exist in the runner today
  and MUST be built, generalized to path-granular `LabelView`s, before the
  interpreter's precision claims are sound ([04](./04-scheduler-and-transformer-deltas.md) §0).

- **R-CFC-4 (trigger reads).** The interpreter MUST honor trigger reads: the
  addresses whose changes caused a run MUST join the run's labels even if the
  re-run's branch does not re-read them (§8.9.2; scheduler `invalidCauses`).
  Self-suppressed changes (the interpreter's own writes) MUST NOT taint it.

- **R-CFC-5 (fail-closed chokepoints).** The interpreter MUST fail closed on
  label-read errors and unresolved refs, and MUST route all egress through the
  existing sink-ceiling chokepoints. It MUST NOT bypass the `["cfc"]` /
  `requiredIntegrity` / `maxConfidentiality` boundary validation.

- **R-CFC-6 (label persistence as stored metadata).** The interpreter's per-output
  labels MUST be persisted as the same stored CFC metadata components (with
  origin: `derived`/`structure`) that a per-element transaction writes via
  `prepareBoundaryCommit` (`prepare.ts:3119-3127`), so they are covered by the
  existing metadata machinery. There is **no commit-digest / receipt mechanism in
  the runner** to bind into ([03](./03-cfc.md) §6); the present correctness gate is
  the differential oracle. (A receipt envelope is a forward-looking dependency,
  [03](./03-cfc.md) §7.)

## 6. Out of scope (future work)

- **Finer-grained leaves (NG1).** Pushing IFC inside `lift` bodies (per-output
  labels from the inputs each output actually used) is a separable, larger effort
  requiring transformer analysis into leaf bodies and a larger trust surface. It
  is *not* in this spec. If pursued, it would extend the same ROG with finer leaf
  decomposition; nothing here precludes it.
- **Multi-handler dispatch, receipt layering** and other scheduler-v2 open
  questions are inherited unchanged.

## 7. Invariants

The interpreter and its integration MUST preserve these invariants.

- **I1 — Output equivalence.** For every cell that remains external, the value
  and the path-granular CFC label the interpreter produces equal (value) or
  soundly over-approximate (label) what the materialized model produces.
- **I2 — Footprint.** The steady-state **document and scheduler-node** count for a
  ROG instance, **per scope context**, is `O(externally referenced outputs +
  checkpoints)`, independent of the count of internal operations and (for
  unchecked elements) of `N`. The persistent **read-index** remains `O(distinct
  external reads)` (still `O(N)` for per-element external reads, but cheaper rows —
  no value, no conflict domain, no revision chain). For scoped data, genuinely
  scope-varying *outputs* exist per observed scope (intrinsic to scoping — per-user
  data is per-user); the scaffolding and scope-invariant work never multiply by
  scope (R-SCOPE, §9 R-1).
- **I3 — Incremental cost.** A change to one input causes recompute of
  `O(operations actually affected)`, not `O(|ROG|)` and not `O(N)`.
- **I4 — One change channel.** All invalidation of the interpreter flows from the
  storage notification channel (P1). The interpreter's internal index is
  ephemeral interior state of one node, deterministically derived from that
  node's inputs; it is not a second durable propagation system (NG4).
- **I5 — Label soundness.** Every external output **confidentiality ⊇** the union
  of the confidentiality of the inputs that flowed to it, and every output
  **integrity ⊆** the class-aware meet of those inputs' integrity (never a
  superset — no integrity raised without endorsement); no label is narrowed
  without a passing §8.9.1 trust gate.
- **I6 — Trust attribution.** Every label the interpreter asserts is attributable
  to its verified implementation identity (incorporating the ROG content hash) and
  persisted as stored metadata components (there is no commit digest to bind into,
  R-CFC-6).
- **I7 — Restart equivalence.** (R-PERSIST-4.)
- **I8 — Bounded non-convergence.** (R-EXEC-6.)

## 8. Hardest inherited constraints

These come from committed/in-flight specs; the design must satisfy or explicitly
supersede each. Cross-referenced where they are addressed.

1. **NG-001 / SES trust boundary** (ts-transformer goals; sandboxing). The
   transformer is not a trust boundary; the interpreter is. → R-CFC-1/2,
   [03](./03-cfc.md) §3.
2. **One node, one static write surface (P4) + idempotency (§4.2)**
   (scheduler-v2). → R-EXEC-1/4, [04](./04-scheduler-and-transformer-deltas.md)
   §2–4 (the interpreter owns *many* outputs via a generalized materializer
   envelope; idempotency recheck redefined for interpretation).
3. **Verified content-addressed identity** (content-addressed-action-identity;
   pattern-id-retirement). → R-ROG-4, R-MAT-3.
4. **CFC trigger-read join (D9 / §10).** → R-CFC-4.
5. **One change channel (P1) + value-accurate invalidation (P2)**
   (scheduler-v2 §14). → I4, NG4, [02](./02-design.md) §5.
6. **Persistent observations + inactive-piece dirtying (D8).** → R-PERSIST-1/3.
7. **Runs-are-transactions + receipt envelope (D6).** → [03](./03-cfc.md) §7
   (how many internal operations map onto one commit/receipt).
8. **Lowering-contract fidelity + dynamic graph rewiring (D3/D4).** → R-ROG-6,
   R-EXEC-5.
9. **Deterministic, reproducible causes** (cause-derivation: outputs causal to
   inputs, carried through). → R-MAT-3.
10. **Bounding contracts (`idle()` / `settled()`).** → R-EXEC-6, I8. Note
    `settled()` is a post-v2 *runtime* method (`runtime.ts:494-509`), not a
    scheduler-v2 surface.

## 9. Open design questions

One genuinely open; the rest resolved (decisions recorded for the record).

### Open

- **OQ-4 — Read-isolation enforcement mechanism (load-bearing).** R-CFC-ISO
  requires *structural* enforcement (a per-element, per-scope read-scoped view in
  which observing another element's or another scope's data is impossible). The
  concrete mechanism for in-memory interior evaluation does not exist yet
  ([04](./04-scheduler-and-transformer-deltas.md) P-0.3); this is the load-bearing
  open soundness question and the gate for G3.

### Resolved

- **R-1 — Scoped cells: per-running-scope interior + scope carry-through.** No
  per-scope interior keying is needed: an interpreter run is in one runtime scope
  context and its non-serialized interior is implicitly that scope's data. The
  requirement is dynamic carry-through of the narrowest scope read to each
  output's effective scope (R-SCOPE). Scoped collections are supported (container +
  scope-invariant work get the win; only scope-varying outputs exist per observed
  scope, which is intrinsic to scoping). One residual sub-detail: how a single
  scheduler node serves multiple reader scopes (analogous to `cell.pull()` in a
  scope context) — an integration choice, not a soundness one.
- **R-2 — Write surface = top outputs.** The static ROG structure feeds only the
  *initial topological sort*; thereafter actual reads drive invalidation. The
  materialized write surface is the egress-reachable **top outputs**, not the
  interior links; for the expression-only scope this is statically known from the
  result shape and is sufficient (Delta A). Broader over-approximation / envelope
  treatment is deferred until imperative side-writes or lazy promotion are added.
- **R-3 — Identity by causal carry-through.** Materialize the egress-reachable
  closure; for retained deep links, keep ids causal to inputs and thread the cause
  through (R-MAT-3). (The reload id-churn class is fixed and is not a live concern.)
- **R-5 — Interior non-convergence: scheduler API route.** Non-convergence is a
  scheduler responsibility moving inward, so it is exposed via a scheduler-v2 API
  (`tx.markSelfInvalid()` / an `fn` "not-done" signal) so pass-level backoff
  applies — not a bespoke interior hard-reject ([04](./04-scheduler-and-transformer-deltas.md)
  Delta E).
- **R-6 — Interpreter is in the TCB.** The interpreter is trusted runtime code in
  the trusted computing base; per-interpreter trust suffices for the §8.9.1 gate.
  No per-ROG-hash trust granularity ([03](./03-cfc.md) §2).

**Also settled:** the interpreter does **not** "close S11" (S11 is already closed
structurally; the interpreter *re-incurs* the claim, G3); NG4 holds (only the
"precedent is exact" framing was wrong, [02](./02-design.md) §5); `settled()` is a
runtime method, not a v2 surface.
