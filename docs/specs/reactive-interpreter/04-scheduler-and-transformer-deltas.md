# Prerequisites, scheduler-v2 deltas, and transformer deltas

The interpreter is hosted by the scheduler-v2 node model and fed by the
transformer. This document lists the machinery that must be **built first**
(prerequisites that do not exist today), then states exactly what scheduler-v2
and the transformer must add or change. It is written against scheduler-v2
(`docs/specs/scheduler-v2/README.md`); where v2's merge train has not fully
landed, re-verify against landed code at implementation time (the inventory
itself flags some README/code drift).

---

## 0. Prerequisites (unbuilt machinery this design depends on)

These are not hooks into existing code; they are components to build before or
alongside the interpreter. The design's correctness is conditional on them.

- **P-0.1 — The §8.9.1 trust gate.** `isTrustedForConcept`, the
  `flow-taint-precision` concept, concept-trust delegation (CFC §4.8), the
  acting-user trust closure, implementation-identity → concept resolution, and
  `deriveLabelWithTrustGate` do **not** exist in `packages/runner/src/` (zero
  occurrences). They are CFC-spec pseudocode plus a single-`Label` Lean
  definition. All must be built ([03](./03-cfc.md) §3).
- **P-0.2 — Path-granular precision gate.** The gate must be generalized from a
  single `Label` to a path-granular `LabelView`, and must enforce the
  integrity-meet vs view-union distinction ([03](./03-cfc.md) §4). New work.
- **P-0.3 — Read-isolation capability.** A per-element read-scoped evaluation
  view that makes cross-element reads *impossible* ([03](./03-cfc.md) §5.2). No
  such scoping exists for in-memory interior evaluation today.
- **P-0.4 — Interior non-convergence signal.** A scheduler-v2 mechanism for one
  node to report "I did not reach interior fixpoint" so pass-level backoff
  applies (Delta E). Does not exist (self-suppression hides a partial commit).
- **P-0.5 — Idempotency-recheck hook.** Either a validator hook
  (`node.evalFromScratch(tx)`) or an explicit decision to drop inline recheck for
  the interpreter and make the differential oracle the permanent gate (Delta C).

## 1. Where the interpreter plugs in

The interpreter is a **new node kind** and a **generalization of the materializer
envelope** (v2 §4.3) — already the sanctioned "one node, broad/dynamic write
surface." The envelope gives the write-surface registration; it does **not** give
per-output labels or interior incrementality, which are this design's new work.

| v2 mechanism | Interpreter use |
| --- | --- |
| One node, one `fn(tx)` (§4.1) | The interpreter instance is one node; `fn` evaluates the ROG. |
| Materializer envelope (§4.3): standing demand at idle, promotion under demand, **envelope edges ordering-only, never marking readers invalid** | The interpreter's dynamic/lazily-promoted outputs ride the **tier-3 envelope** (not tier-2), so data-dependent reachability does not require a static writer map (Delta A). |
| Value-accurate invalidation + trigger index (§6.1) | Delivers changed addresses to the node; the interpreter routes them internally (Delta B). |
| `invalidCauses` / `addCfcTriggerReads` (§10) | Consumed as the trigger set ([03](./03-cfc.md) §5.4). |
| `tx.nodeId` self-suppression (P5) | The interpreter's interior writes are self-suppressed as one node's writes. |
| Persistent observation (§9) | Extended to carry the interface read-set + a checkpoint/read-closure manifest (Delta D). |

## 2. Delta A — write surface: static over-approximation + tier-3 envelope

The interpreter's externally-materialized set is **data-dependent**:
`control` flips and collection growth change what is reachable from the egress
boundary ([03](./03-cfc.md) / [02](./02-design.md) §3.3–3.4), and lazy promotion
(R-MAT-3) materializes a cell *because a reader appeared at runtime* — which is
exactly the write-set *discovery* P4 forbids for the static writer map. So the
naïve "declare N static outputs (tier-2)" framing is wrong.

- **A1 — static over-approximation.** At registration the interpreter MUST
  compute a **static over-approximation** of its write surface from the ROG: the
  union over *all* control branches plus an *element-position template* for
  collections (one templated output family per `collection` op), independent of
  which branch is live or how many elements exist. The dynamic reachable set MUST
  always be a subset of this over-approximation (formal obligation 8,
  [03](./03-cfc.md) §8).
- **A2 — tier-3, not tier-2.** Outputs that are not statically pinned (collection
  elements at runtime positions, lazily-promoted internal cells) ride the **tier-3
  materializer envelope**: standing demand at idle, promotion under demand,
  **envelope edges contribute ordering only and never mark readers invalid** —
  only the cell's *actual committed change* does (v2 §4.3 rule 3). Do **not**
  cite tier-2 "additional output documents" for the dynamic case.
- **A3 — re-derivable writer map.** Because reachability is data-dependent, the
  concrete writer map (which document the interpreter will write for a given
  external reference) MUST be re-derivable on read-delta, within the static
  over-approximation. This is a genuine delta against P4's "static writer map"
  assumption and MUST be called out as such in the v2 reconciliation.
- **A4 — idempotency.** All outputs satisfy the §4 idempotency contract: writes
  are a pure function of inputs.

## 3. Delta B — read-set and incremental routing

- **B1 — union read-set.** The interpreter registers a read-set that
  over-approximates **every external read of every interior op transitively
  reachable from any output** (checkpointed or inline — see Delta D / MA-6), so
  the scheduler invalidates it on any relevant change. This is the same read-set
  discovery v2 already does, applied to the over-approximating union.
- **B2 — interior routing reuses exact trigger-index semantics.** When the
  scheduler delivers changed addresses, the interpreter routes them to interior
  ops via its in-memory index. That index's `overlaps` test MUST reuse the
  **exact** `trigger-index.ts` match semantics (deep `deepEqual` at the registered
  path with reachability transitions; shallow same/ancestor/new-key-child), not a
  hand-rolled approximation — otherwise it will over- or under-invalidate. This is
  **new trusted complexity reproducing v2 §6.1 interiorly**, and the spec states
  it as such; it is not free.
- **B3 — interior per-op liveness.** The interpreter MUST track interior per-op
  liveness so an op feeding only an unobserved output is not recomputed
  (mirroring v2 demand, interiorly). Without it, incremental recompute is not
  demand-gated inside the node.
- **B4 — read-delta application (P6).** The interpreter updates its registered
  union read-set by diffing each run's external reads, as a normal node does.
  Interior per-op read deltas are interior and do not touch the scheduler.
- **B5 — no second channel (NG4).** B1–B4 are interior bookkeeping of one node,
  consuming the scheduler's single change delivery; they are not a second durable
  propagation system ([02](./02-design.md) §5).

## 4. Delta C — idempotency recheck for an incremental node

v2 keeps the inline idempotency validator
(`runIdempotencyRecheck` → `diagnosis.ts:275` re-invokes `action(tx2)` blindly,
no mode parameter; `tx2.abort()` does **not** roll back in-memory state). Two
problems make the earlier "expose an `evalFull` mode" plan unworkable as written:

1. there is no hook for a node to expose an alternate evaluation mode to the
   validator;
2. even a working `evalFull` re-runs against **post-commit** state, so it would
   validate *fixpoint stability*, not the property we care about (incremental ==
   from-scratch against the **same pre-run inputs**, R-EXEC-4); and a naïve
   `evalFull` would corrupt live `InterpreterState`.

Resolution (choose and specify; this spec recommends both C1 and C3):

- **C1 — recheck hook + state clone (scheduler-v2 delta).** Add a validator hook
  `node.evalFromScratch(tx)` (a new, explicit scheduler-v2 delta on the node
  interface) that evaluates the ROG via `evalFull` against a **throwaway clone**
  of `InterpreterState` so it cannot corrupt live interior state, and against a
  **snapshot of the pre-run inputs** (not post-commit state) so it actually tests
  R-EXEC-4. Diff its materialized writes against the incremental run's.
- **C3 — the differential oracle is the permanent gate.** Because the inline
  validator structurally cannot witness interpreter incrementalism bugs without
  C1, and even with C1 is bounded, the **differential oracle**
  ([06](./06-migration-plan.md) §4) is elevated from a migration aid to the
  **permanent, hard correctness gate** for interpreter incrementalism — running
  interpreter vs the legacy materialized model on a corpus, on values *and*
  labels (including the integrity direction and the isolated-read lower bound).

## 5. Delta D — persistence (D8)

v2 attaches a per-node observation at commit (§9.3). The interpreter needs a
**richer** observation — still interface-level, but with a transitive read
closure so inactive-piece dirtying is not blinded (R-PERSIST-3; "missing
observations are never treated as clean", `persistent-scheduler-state.md`).

- **D1 — transitive read closure.** The persisted union read-set MUST
  over-approximate every external read of every interior op transitively
  reachable from *any* output (checkpointed or inline), not just the reads of
  checkpointed units. An interior op whose external read feeds only an inline
  container entry MUST still appear, or a cross-piece writer cannot dirty the
  interpreter (MA-6).
- **D2 — checkpoint manifest.** For each checkpoint: its document id and its
  `derivedFrom` = the **transitive external-read closure** of the checkpointed
  unit (not its direct interior reads). A checkpoint whose `derivedFrom` omits a
  transitive input is trusted-stale (violating R-PERSIST-4).
- **D3 — read-index cost is `O(distinct external reads)`.** This persistence is
  `O(distinct external addresses read)` `scheduler_read_index` rows — which is
  `O(N)` for a collection whose elements each read a distinct cross-piece cell
  (the importer case). This is **cheaper than `O(N)` documents** (a read-index row
  has no value, no separate conflict domain, no revision chain), but it is **not
  `O(1)`**; G1 / I2 are scoped accordingly ([05](./05-baselines.md) §5).
- **D4 — identity.** The interpreter node's durable identity is the existing
  scheme (owner space / branch / piece id / process generation / impl hash), with
  the **ROG content hash** as the impl component (also the basis for per-ROG trust
  granularity, [03](./03-cfc.md) §2). No new identity scheme.
- **D5 — resume.** Rehydrate from observation + checkpoints, install the union
  read-set, recompute only the demanded, non-checkpointed interior
  ([02](./02-design.md) §4.1). Missing/invalid ⇒ recompute, never clean.

## 6. Delta E — convergence and the interior non-convergence signal

Interior non-convergence does **not** surface today: P5 self-suppression
(`notifications.ts:133`) means the interpreter's own writes do not re-invalidate
it, and scheduler budgets count re-runs *between* `fn` calls, blind to iteration
*inside* one `fn(tx)`. A partial, non-converged interior commit would
self-suppress and let `idle()` / `settled()` resolve cleanly **with a wrong
value** (MA-4). This MUST be fixed by one of:

- **E1a — interior fixpoint with hard reject.** The interpreter MUST run its
  interior to fixpoint within one `fn(tx)`; budget exhaustion is a **hard
  reject** (no partial commit), surfaced via the error path, never a silent
  partial write. This also closes the single-pass-prune soundness gap (a stale
  cached order in a single topo pass can commit a *wrong* result, not just cost an
  iteration — [02](./02-design.md) §3.2 / R-EXEC-5): mandate the in-`fn` fixpoint
  loop, or prove the cached order is always topologically valid for the live
  graph.
- **E1b — self-invalidate signal (scheduler-v2 delta).** Alternatively add a node
  API (`tx.markSelfInvalid()` / an `fn` "not-done" return) so the scheduler
  applies pass-level iteration/backoff to the interpreter. Add the chosen API to
  the v2 node interface.

E1a is recommended (it keeps interior convergence an interior concern); E1b is
the fallback if interior fixpoint per `fn` is too coarse.

- **E2 — settled().** `settled()` is a post-v2 **runtime** method
  (`runtime.ts:494-509`), not a v2-spec surface; cite it as such. The interpreter
  is settled when its interior has reached fixpoint and its async leaf work
  (sqlite, fetch, llm) has drained via the existing `settled()` registration for
  the async builtins it invokes.

## 7. Transformer deltas

The transformer already emits the operation graph as hoisted, schema-annotated
builder calls + a serialized `Pattern`. The deltas make it emit the ROG as
*data*.

- **T1 — emit a ROG artifact.** Add a serialization mode that emits the
  normalized ROG (a successor to / normalization of the existing `Pattern`
  serialization and the deferred `GraphSnapshotV1`), self-contained given the
  implementation index (R-ROG-5). The existing `$implRef` / `$patternRef` refs and
  inlined schemas are reused verbatim; the new work is normalizing into the flat
  op vocabulary (R-ROG-1) and emitting it as a value rather than a graph-building
  program. **This is a genuine extension of the lowering contract** — argued on
  its merits, not by appeal to the contract's §3.10 phase-ordering clause (which
  is about internal compiler phase ordering, not data-vs-executable
  representation). The §3.1–3.9 semantic obligations still hold (R-ROG-6).
- **T2 — preserve schemas, captures, identity.** No change to schema emission,
  capture minimization, or content-addressed identity (R-ROG-2/3/4).
- **T3 — propagation-structure hint (optional, untrusted, prospective).** The
  transformer MAY emit, per op, the which-input-flows-to-which-output structure.
  The natural source is the S-007 capability-flow IR — but **S-007 is a proposed
  transformer delta (`ts_transformers_design_deltas.md`), not shipped**, so this
  is prospective ("if/when S-007 lands"). Per R-CFC-2 these are hints the
  interpreter re-derives or verifies, failing closed otherwise.
- **T4 — leaves unchanged.** `lift` / `computed` / `handler` bodies are emitted
  exactly as today (opaque sandboxed JS, coarse labels — NG1). The ROG references
  them by identity.
- **T5 — diagnostics.** The transformer MUST continue to diagnose non-lowerable
  constructs (lowering-contract §3.9). Anything that today becomes a whole-wrapped
  `lift` becomes a ROG `leaf` — no new diagnostic surface.

## 8. What is explicitly *not* changed

- The SES sandbox, leaf execution, and the harness — leaves run exactly as today.
- The CFC label-view machinery (`mergeCfcLabelViews`, `rebaseCfcLabelView`,
  `IFCLabel`, `deriveFlowJoin`, sink ceilings) — reused (with the integrity-meet
  vs view-union distinction respected, [03](./03-cfc.md) §4), not replaced.
- The content-addressed identity scheme and the implementation index.
- The storage/memory commit, conflict, and sync model — the interpreter writes
  fewer documents but writes them the same way.
- The event/handler dispatch, receipts, and lineage of scheduler-v2 §7.5–7.6 —
  inherited unchanged (handlers are still nodes/effects; the interpreter governs
  the reactive computation graph, not the event queue).
