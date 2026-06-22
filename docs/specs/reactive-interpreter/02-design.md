# Design

This document specifies the Reactive Operation Graph (ROG) and the architecture
of the Reactive Interpreter. Pseudocode is written to be precise enough to map
onto the CFC formal model (see [03-cfc.md](./03-cfc.md) §8 for the
correspondence); it is illustrative of structure, not a frozen implementation.

---

## 1. The Reactive Operation Graph

### 1.1 Shape

The ROG is the data form of the operation graph the transformer already builds.
It reuses the existing serialized `Pattern` shape
(`{ argumentSchema, resultSchema, result, nodes }`) and normalizes it into a
flat, typed graph over the closed vocabulary of R-ROG-1.

```text
ROG := {
  argumentSchema : SchemaHandle           // canonicalized, hashed
  resultSchema   : SchemaHandle
  result         : ValueRef               // the returned value (root of materialization)
  ops            : Op[]                    // topologically sortable; the "AST"
}

ValueRef :=                                 // a reference into the graph's value space
  | Argument(path)                          // input.key(path...)
  | OpOut(opId, path)                       // an op's output, navigated
  | Const(value)                            // an inlined literal
  | Internal(name, path)                    // a named internal (Writable / derived)

Op := {
  id        : OpId
  kind      : leaf | pattern | collection | control | access | construct | effect
  impl      : ImplRef?                      // {identity, symbol} for leaf/pattern; absent otherwise
  inputs    : ValueRef[]                    // explicit, minimal
  outSchema : SchemaHandle                  // result schema of this op
  detail    : KindDetail                    // kind-specific (below)
}

KindDetail :=
  | Leaf      {}                                      // opaque JS, run via harness
  | Pattern   { rog: ImplRef }                        // nested ROG by identity
  | Collection{ op: "map"|"filter"|"flatMap", elementRog: ImplRef, listInput: ValueRef }
  | Control   { op: "ifElse"|"when"|"unless", pred: ValueRef, branches: ValueRef[] }
  | Access    { path: PathStep[] }                    // key / element navigation
  | Construct { template: ObjectOrArrayTemplate }     // value assembly from inputs
  | Effect    { sink: "render"|"pull"|"handler", link?: StreamRef }
```

Notes:

- `Op.impl` for `leaf` / `pattern` / `collection.elementRog` is the existing
  content-addressed `{ identity, symbol }`; the interpreter resolves it through
  the session implementation index (no new identity, R-ROG-4).
- `Construct` is what lets `map`'s result live as one inline array instead of N
  documents: the container's value is `[OpOut(elem_0), OpOut(elem_1), …]` held
  inside the interpreter, not N linked documents.
- A `collection`'s `elementRog` is itself a ROG: the interpreter recurses, it
  does **not** call `runtime.runner.run` to instantiate a child pattern
  (contrast `map.ts:258-273`).

### 1.2 Where the ROG comes from

The transformer emits the ROG as a serialized artifact alongside the compiled
module ([04](./04-scheduler-and-transformer-deltas.md) §5). It is in the same
spirit as the "normalized authored graph" the CFC formalization's
authored-graph→operation-graph bridge models (`~/src/specs/cfc/formal/`): the
"trusted extraction step from builder/runtime artifacts into the normalized
authored graph" that the operation-graph normalization proposal leaves open is
the transformer→ROG emission. **Caveat:** the Lean type literally named
`ReactiveOperationGraph` is a *different*, audience-delivery abstraction, and no
existing theorem covers the interpreter's evaluation semantics — connecting the
ROG and the interpreter to a formal model is new proof work
([03](./03-cfc.md) §8), not a reduction onto a proven surface.

The ROG is **untrusted data**. The interpreter does not trust its asserted
structure for label *values*; it uses structure only for scheduling/ordering and
re-derives or verifies anything that affects soundness (R-CFC-2,
[03](./03-cfc.md) §3).

## 2. The interpreter as one scheduler node

The interpreter instance for a ROG presents to the scheduler as a single node
(R-EXEC-1) — a generalization of the materializer-envelope node
([04](./04-scheduler-and-transformer-deltas.md) §2). Its `fn(tx)` evaluates the
ROG and writes the materialized outputs into the one transaction.

```text
interpreterNode(rog, resultCell):
  state := InterpreterState(rog)            // persistent across runs, in-memory
  return (tx) => state.run(tx, resultCell)
```

`InterpreterState` holds the interior that today is spread across N child
patterns and documents, but in memory:

```text
InterpreterState := {
  rog          : ROG
  order        : OpId[]                 // cached inner topo order (R-EXEC-3)
  values       : Map<OpId, Value>       // last computed value per op
  labels       : Map<OpId, LabelView>   // last computed path-granular label per op
  reads        : Map<OpId, ReadSet>     // per-op read set (drives the internal index)
  index        : InternalTriggerIndex   // projection of the outer reader index over op reads
  elementState : Map<OpId, Map<ElemKey, ElementSlot>>  // per-collection element interior
  externals    : Map<ValueRef, DocumentRef>            // materialized external cells
  checkpoints  : Map<OpId|ElemKey, CheckpointRef>      // R-MAT-4
}
```

This is the same idea as `map.ts`'s in-memory `elementRuns` Map today — interior
state of a single coordinator node — generalized to the whole ROG. It is **not**
a second durable propagation channel (NG4): it is rebuilt deterministically from
the node's inputs and lives only as long as the node.

## 3. Evaluation

### 3.1 Full evaluation (from scratch)

Evaluation walks the cached order, evaluating each op against the current
transaction and recording its value, label, and read-set.

```text
evalFull(state, tx):
  for opId in state.order:
    op := state.rog.ops[opId]
    ins := [ resolve(state, tx, ref) for ref in op.inputs ]   // values + labels + reads
    (val, lbl, reads) := evalOp(state, tx, op, ins)
    state.values[opId] := val
    state.labels[opId] := lbl
    state.reads[opId]  := reads
  materialize(state, tx, state.rog.result)                    // §4
```

`evalOp` dispatches on kind:

```text
evalOp(state, tx, op, ins):
  case op.kind of
    leaf:        runSandboxedLeaf(op.impl, ins)        // unchanged JS, coarse label (R-EXEC-7)
    access:      navigate(ins[0], op.detail.path)      // pure structural, label rebased to path
    construct:   assemble(op.detail.template, ins)     // value + per-field label view
    control:     evalControl(state, tx, op, ins)       // §3.3
    collection:  evalCollection(state, tx, op, ins)    // §3.4 — the important one
    pattern:     evalNested(state, tx, op.detail.rog, ins)
    effect:      evalEffect(state, tx, op, ins)        // demand source / sink / handler
```

Label computation for each op is specified in [03-cfc.md](./03-cfc.md) §4; the
interpreter joins the labels of the inputs that actually flowed to each output,
path-granularly, using the existing `mergeCfcLabelViews` / `rebaseCfcLabelView`.

### 3.2 Incremental evaluation (the point)

On re-run, the interpreter is handed the set of changed addresses (the scheduler
already accumulates these as `invalidCauses`; see
[04](./04-scheduler-and-transformer-deltas.md) §3). It maps them to the affected
ops via the internal trigger index and recomputes only those plus their
downstream closure within the ROG (R-EXEC-2).

```text
evalIncremental(state, tx, changedAddresses):
  dirty := { op : op.reads overlaps some changed address }   // value-accurate, via state.index
  if dirty is empty: return                                   // nothing to do — the common case
  worklist := topoClosure(state.order, dirty)                 // dirty ∪ downstream-in-ROG
  for opId in worklist:                                       // in cached order
    op := state.rog.ops[opId]
    ins := [ resolve(state, tx, ref) for ref in op.inputs ]
    (val, lbl, reads) := evalOp(state, tx, op, ins)
    if val == state.values[opId] and lbl == state.labels[opId]:
      prune(worklist, opId)                                    // value-gated: stop propagation (P2)
    else:
      state.values[opId] := val; state.labels[opId] := lbl
    applyReadDelta(state.index, opId, state.reads[opId], reads)  // P6 delta, not re-subscribe
    state.reads[opId] := reads
  rematerializeAffected(state, tx, worklist)                   // only re-write changed externals
```

Two properties matter:

- **Value-gated propagation (P2).** An op whose recomputed value and label are
  unchanged stops the wavefront — exactly the scheduler's value-accurate
  invalidation, applied *inside* the node. This is why an `access` on an
  unchanged sub-path, or a `leaf` whose inputs didn't actually change, costs
  nothing downstream. **Caveat (trigger labels):** the value-unchanged early
  return MUST NOT skip a required trigger-read label join — a re-run can leave
  values identical yet still need a `pc`/label update from a new trigger
  ([03](./03-cfc.md) §5.4). Value-gating prunes *value* propagation, not the
  trigger-label obligation.
- **Read-delta maintenance (P6).** Per-op read sets are updated by diffing the
  new run's reads against the registered ones, mirroring the scheduler's read
  delta, so the common case (reads unchanged) is a no-op. The interior
  `overlaps` test MUST reuse the exact `trigger-index.ts` match semantics, not an
  approximation ([04](./04-scheduler-and-transformer-deltas.md) Delta B2).
- **Single-pass soundness.** A stale cached `order` in one topo pass could commit
  a *wrong* result, not merely cost an iteration. The interpreter MUST therefore
  run its interior to fixpoint within one `fn(tx)` (or prove the cached order is
  always valid for the live graph), treating budget exhaustion as a **hard
  reject**, never a partial self-suppressed commit
  ([04](./04-scheduler-and-transformer-deltas.md) Delta E /
  [03](./03-cfc.md)).

> **Recheck note.** Because evaluation mutates `InterpreterState` in place, the
> from-scratch idempotency recheck ([04](./04-scheduler-and-transformer-deltas.md)
> Delta C1) MUST run `evalFull` against a **throwaway clone** of the state and a
> **pre-run input snapshot**, never the live state against post-commit data.

### 3.3 Control flow

`control` recomputes its predicate; only the live branch's ops are evaluated.
When the predicate flips, the previously-live branch's ops are released and the
newly-live branch's ops enter the worklist; the read-set changes (D3) and the
cached order's branch membership updates accordingly. The predicate's label
joins onto the selected output (PC confidentiality, §8.9.2) — branch selection
*is* a flow-path dependency.

### 3.4 Collections — the per-element interior

This is where the `~3 docs + ~4 nodes per element` cost is removed.

```text
evalCollection(state, tx, op, ins):
  if isScoped(op):                                 // PerUser/PerSession element results
    return materializeScopedFallback(state, tx, op, ins)   // see "Scoped collections" below
  list      := ins[op.detail.listInput]            // identity-only: links/positions, no element content
  elemState := state.elementState[op.id]
  result    := []                                  // inline array, lives in state.values[op.id]
  for (slot, i) in enumerate(list):                // identity keying as in map.ts:236-239
    key := elementKey(slot, i)
    es  := elemState.get(key) ?? freshElementSlot(op.detail.elementRog)
    if es.dirty(changedAddresses) or es.isNew:
      // READ-ISOLATED: scopedView can observe ONLY element i (cross-read = error, not silent join)
      (val, lbl) := evalElement(scopedReadView(state, key), tx, es, slot, i)
      es.value := val; es.label := lbl
    result[i] := es.value
    writeElementLabelMetadata(op, container, i, es.label)   // §[03] §5.1: derived/structure component, WITH origin
  writeStructuralLabelMetadata(op, container, structuralLabelOf(list))  // membership/order, §8.5.6
  releaseAbsent(elemState, presentKeys); gcCheckpointsFor(absentKeys)   // R-MAT-5 + MN-8: no orphan/leak
  return (result, unionReads(elemState))
```

Key points:

- The element op runs **in the interpreter**, recursing the element ROG against
  the element's inputs. It does **not** instantiate a child pattern, mint a
  per-element result/argument/process document, or register per-element scheduler
  nodes. The N element *values* live as inline entries in the one container the
  pattern returns (`Construct`).
- **Read isolation is enforced, not asserted.** `evalElement` runs against a
  `scopedReadView` that makes observing another element's data *impossible*; a
  cross-element read is a runtime error. This factors element evaluation through
  `(i, xs[i])`, reproducing the per-element journal *structurally* — the
  load-bearing soundness obligation ([03](./03-cfc.md) §5.2). The differential
  oracle is fail-closed on any element label below its isolated-read join.
- **Per-element labels are written as stored metadata components with origin**
  (`derived`/`structure`), at path `[i]` — *not* assembled into a component-blind
  `CfcLabelView` (which cannot carry the `structure` origin discipline,
  [03](./03-cfc.md) §4 / MA-10). This is the same representation a per-element
  transaction writes.
- **`map` is pointwise; `filter`/`flatMap` are not.** `map` has index identity
  (claims `PointwisePresencePreserved` + `PointwiseWriteDependency`). `filter`
  contributes membership/order/multiplicity confidentiality to the **container
  structural** label and its outputs are `ElementLocalExpansion` +
  `StableRelativeOrder`; `flatMap` lands element `i`'s sub-array at a
  runtime-variable offset, so its labels attach to element-local content and
  re-derive on upstream length change, never pinned to absolute indices
  ([03](./03-cfc.md) §5.3).
- An element is recomputed only when its own inputs change (the existing edit is
  already `O(1)`; this preserves that). Element identity keying is the existing
  scheme (cell-link identity stable across position; inline-value identity by
  position).

**Scoped collections (PerUser / PerSession) — known limitation.** A scope is an
addressing dimension: a PerUser/PerSession element result is a *distinct physical
storage instance per user/session* (`scoped-cell-instances.md`; `map.ts:174`
`scopedCell(...)`). An inline interior value has one interpreter identity and no
per-scope instance, so the `O(1)`-document win **does not apply** to scoped
collections. The interim design is `materializeScopedFallback`: scoped collection
results fall back to per-scope materialization (today's footprint). lunch-vote is
exactly this case. A future per-scope interior-state design (keying
`elementState` by effective scope and materializing only observed scopes) is an
open question ([01](./01-requirements.md) §9, open question 1). The footprint
targets ([05](./05-baselines.md) §5) are stated for the non-scoped case.

### 3.5 Nested patterns

`pattern` recursion evaluates the nested ROG against bound inputs **in the same
interpreter** (R-MAT-2): the nested pattern's internals are interior state, not
documents. Only values reachable from the *outermost* return are materialized.

## 4. The materialization boundary

After evaluation, the interpreter writes documents for exactly the
reachable-from-**egress** closure plus user state and checkpoints (R-MAT-1). The
boundary keys on every externally-observable egress, **not** the return value
alone — users also observe via render and via cells handlers write into, which
need not be reachable from the return (MA-8).

```text
materialize(state, tx, rog):
  egress    := { rog.result }                          // returned value
            ∪ renderReads(state)                       // [UI] render tree reads (an egress, not a return)
            ∪ effectSinkReads(state)                   // fetch/llm/mail sink inputs
            ∪ handlerWriteTargets(state)               // cells handlers write that the UI subscribes to
  reachable := closureThroughLinks(state, egress)
  for ref in reachable ∪ userState(state) ∪ checkpointed(state):
    doc := state.externals.get(ref) ?? allocExternalDoc(state, ref)   // id is NOT lazy — see below
    if doc.value != state.valueOf(ref) or doc.label != state.labelOf(ref):
      writeDoc(tx, doc, state.valueOf(ref), state.labelOf(ref))       // value + per-path label metadata
  releaseUnreferenced(state.externals, reachable ∪ userState ∪ checkpointed)
```

- **What becomes a document:** the egress closure (the returned value, the render
  tree, sink inputs, handler-written cells, and what they link to), Writables and
  changed pattern arguments (user state — which materialize as documents anyway,
  so the migration is nearly free, [06](./06-migration-plan.md) §3), and
  checkpoints.
- **What does not:** intermediate `leaf` results, `access`/`construct` interior,
  per-element scaffolding, argument/process cells *not* reachable from an egress.
  These were the bulk of the `~5 + 3N`. (Whether the footprint win survives once
  handler-written / render-read interior cells materialize is workload-dependent
  and must be measured, [05](./05-baselines.md) §6.)
- **The write surface is a static over-approximation** computed at registration
  (union over all control branches + an element-position template per
  `collection`), with the dynamic egress-reachable set always a subset; dynamic
  and lazily-promoted outputs ride the **tier-3 materializer envelope**, not a
  static writer map ([04](./04-scheduler-and-transformer-deltas.md) Delta A).
- **Identity is never lazy; only materialization is (R-MAT-3, corrected).** Every
  reachable-or-referenceable cell has a **deterministic id derivable at
  registration** from `{ resultCell entityId, static ROG position }`, computed
  *identically* by the linker and the interpreter, independent of run order, and
  anchored on a **position-based, program-independent** anchor (the CT-1623
  `outputSpot` discipline, `map.ts:153-167`) — **not** derived from the
  session-varying serialized ROG/Pattern (which churns ids across reloads). So
  another piece can wire a link to an internal cell's id *before* the interpreter
  first materializes it; the interpreter promotes the cell to a document on first
  external reference, but the id was always determined. This keeps cross-pattern
  links working and is "good enough for FUSE." (If a position-anchored derivation
  proves impossible for some op, R-MAT-3 is unimplementable for that op — see
  [01](./01-requirements.md) §9 open question 3.)

### 4.1 The checkpoint / memoization tier

Checkpointing turns a selected interior result into an output-like document so a
restart (or an eviction) does not recompute it from scratch (R-MAT-4). A
checkpoint is a *cache keyed by derivation*, not a result: it never changes
semantics.

```text
checkpointPolicy(state, opId | elemKey):
  if author marked force:   return true
  if author marked forbid:  return false
  return estimatedCost(opId) ≥ COST_THRESHOLD and resultSize(opId) ≥ SIZE_THRESHOLD

onCommit(state, tx):
  for unit in checkpointCandidates(state):
    if checkpointPolicy(state, unit):
      // derivedFrom = TRANSITIVE external-read closure of `unit`, not its direct interior reads
      writeCheckpoint(tx, unit, value=state.valueOf(unit), derivedFrom=transitiveExternalReads(state, unit))

onResume(state):
  for ckpt in loadCheckpoints(state):
    if ckpt.derivedFrom still valid (inputs unchanged per scheduler state):
      state.values[ckpt.unit] := ckpt.value          // trust the cache
    else:
      mark ckpt.unit dirty                            // recompute incrementally
```

- **Automatic default + author override** (the chosen control model): the
  interpreter checkpoints by a cost/size heuristic; an author marker can force or
  forbid checkpointing of a specific sub-result.
- **Derivation tracked by the TRANSITIVE external-read closure.** A checkpoint's
  `derivedFrom` MUST be the transitive closure of the external reads its computed
  value depends on — *not* its direct interior reads. If a transitive input is
  omitted, a cross-piece change leaves the checkpoint trusted-stale (violating
  R-PERSIST-4 / MA-6). Because the inputs may themselves be interior, staleness is
  tracked by walking the interior dependency edges down to their external reads,
  which become persisted `scheduler_read_index` rows
  ([04](./04-scheduler-and-transformer-deltas.md) Delta D2).
- **GC on element removal.** A checkpointed collection element that leaves the
  list MUST have its checkpoint document collected, or checkpointing re-creates
  the `map.ts:285-291` leak in document form (MN-8). `releaseAbsent` triggers
  `gcCheckpointsFor` (§3.4).
- **CFC:** a checkpoint document carries the same per-path label metadata as the
  value it caches; reading it back is a normal labeled read (no label is created
  or lost by caching).

This is the answer to "recomputing a giant `map` from scratch every time is
wrong, but persisting all state is also wrong": persist the *interface* always,
and persist *expensive* interior selectively, with derivation-tracked staleness.

## 5. Why this is not a second propagation channel (NG4 / P1)

scheduler-v2 deleted the in-process post-run propagation side-channel (P1: one
change channel). The interpreter must not reintroduce it. It does not:

1. **The interpreter is one node.** Its `index` and `elementState` are the
   *interior* of that node, not a registry of scheduler nodes. The scheduler sees
   one reader (the union of the ROG's external reads) and one writer (the
   materialized outputs).
2. **Invalidation comes from the one channel.** The scheduler delivers changed
   addresses to the node exactly as today; the interpreter's `evalIncremental`
   *consumes* that, it does not subscribe to a parallel stream. The internal
   trigger index is a deterministic projection of the node's own read-set used to
   route a change to the right interior op — pure interior bookkeeping,
   reconstructible from inputs.
3. **No durable interior subscriptions.** The interior index is in-memory and
   ephemeral; persistence is interface-level plus checkpoints (R-PERSIST-1).
   Nothing about interior incrementalism is a second *durable* propagation
   system.

`map.ts` is a partial precedent — **not an exact one**: it already maintains
in-memory `elementRuns` as the interior incremental state of one coordinator
node, which establishes that a single node may legitimately hold ephemeral
interior incremental state. But the interpreter's interior is **genuinely new
trusted machinery**: an internal trigger index that must reproduce
`trigger-index.ts` match semantics exactly and add interior per-op liveness
([04](./04-scheduler-and-transformer-deltas.md) Delta B) — far more than
`elementRuns`'s element-identity map. The argument above (it is one node's
interior, driven by the one channel, no durable interior subscriptions) is what
makes it NG4-compliant; the `map.ts` precedent supports only the "ephemeral
interior state of one node is legitimate" half. The interpreter
generalizes that interior from "elements of one map" to "all ops of the ROG,"
and removes the part of `map.ts` that escapes into the scheduler (the per-element
`runner.run` + documents).

## 6. The win, in one diagram

```text
TODAY:  map over N items (non-scoped)
  scheduler:  [coord] + N×[elem result] + N×[elem internal] + N×[elem effect] + …   (~8 + 4N nodes)
  memory:     result + arg + N×(process + arg + result)                              (~5 + 3N docs)
  read-index: O(distinct external reads)

PROPOSED:  same map
  scheduler:  [interpreter]                                                          (O(1) nodes)
  memory:     result container (N inline entries, per-entry label metadata)
              + user state + checkpoints(expensive elements only)                    (O(1 + checkpoints) docs)
  read-index: O(distinct external reads)   ← UNCHANGED: still O(N) for per-element external reads,
                                              but read-index rows are far cheaper than documents
  interior:   InterpreterState.elementState (in memory, read-isolated, released on removal)
```

The element *values* still exist (they are the output), but as inline,
path-labeled entries in the one container, recomputed per-element on change and
checkpointed only when expensive — instead of ~3 documents and ~4 scheduler
nodes each, forever. The document and node footprint drops to `O(1)`; the
persistent read-index stays `O(distinct external reads)` (cheaper rows, no
value/conflict/revision). **Scoped (PerUser/PerSession) collections are the
exception** and fall back to materialization (§3.4).
