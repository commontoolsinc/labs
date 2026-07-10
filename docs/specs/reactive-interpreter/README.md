# The Reactive Interpreter

> **Status**: Implemented behind the default-off `experimentalInterpreter`
> flag (`CF_EXPERIMENTAL_INTERPRETER=1`), in review as
> [PR #4514](https://github.com/commontoolsinc/labs/pull/4514). Flag-off is
> the production path and is unchanged. This document is the complete
> specification of the interpreter as built; the decisions behind it and the
> lessons from building it live in the adjacent
> [design-history.md](./design-history.md), which the spec does not require
> you to read.

---

## 1. What it is

A Common Fabric pattern is a graph of reactive **nodes** — one scheduler
action per `lift`/`computed`, per control builtin, per handler, per list
builtin. Most of those nodes are *pure*: a small piece of arithmetic or string
work whose only job is to read some inputs and write a derived value. Each such
node costs a document and a scheduler action, and the count grows linearly with
the pattern (and, for lists, per element).

The reactive interpreter is a **graph-compression pass**. It collapses each
maximal connected region of pure nodes into a single synthetic **segment**
action that evaluates that region's computation *in memory* — one action, and
(for result-tree-only outputs) zero extra documents — while leaving every
effectful, handler, and list-coordinator node exactly as the legacy builder
produced it. Control ops (`ifElse`/`when`/`unless`) fuse into segments too,
with demand-driven branch evaluation that preserves their conditional
subscription exactly (§7.1).

The single most important property: **it is not a new execution model.** The
scheduler remains the reactive engine. A segment is an ordinary scheduler node;
it inherits invalidation, reactivity, CFC labelling, and materialization for
free, because it reads and writes through the *same document aliases* the
legacy nodes it replaced would have used. There is no second propagation
channel, no container-of-links fan-out primitive, no read-through machinery —
"the original alias topology **is** the document wiring."

Everything is gated by the default-off `experimentalInterpreter` flag. With the
flag off, the interpreter's data structures are built but never consulted, and
execution is byte-identical to today. This equivalence is enforced by a
**differential oracle**: for every covered pattern, the flag-on and flag-off
runs must produce byte-equal results and byte-equal reactive updates.

---

## 2. Architecture at a glance

```
pattern(fn)                          // builder runs fn once at module load
    │  builds legacy nodes  ──────────────────────────────►  serialized graph
    │  (also) records a ROG in a WeakMap side-table            (identity-neutral)
    ▼
instantiatePattern(pattern)          // runner, per instantiation
    │
    ├─ flag OFF ─────────────────►  instantiate pattern.nodes verbatim (legacy)
    │
    └─ flag ON: planInterpreterDispatch(pattern)
            │  strict getBuiltRog → ROG (or fall back to legacy)
            │  partition into pure segments around verbatim boundaries
            │  cost gate
            ▼
        instantiate the plan: N segment raw-nodes + the boundary nodes verbatim
            │
            └─ each segment action: evalRog(subRog) → write ops' original aliases
```

Three subsystems, described in the sections that follow:

- **The ROG** (§4) — a flat intermediate representation of a pattern's
  computation, built by the builder (§5) as it constructs the pattern.
- **Dispatch** (§6–§9) — deciding what to interpret, partitioning into
  segments around preserved boundaries, and emitting the plan.
- **Evaluation** (§10) — running a segment's sub-ROG in memory, and the
  special handling for collections (§11) and scopes (§12).

---

## 3. The flag and the runner seam

`experimentalInterpreter` is an `ExperimentalOptions` flag on `Runtime`
([runtime.ts](../../../packages/runner/src/runtime.ts)); the env var
`CF_EXPERIMENTAL_INTERPRETER=1` sets it when no caller value was passed
(materialized only when enabled, so ambient env doesn't spam subprocess
stderr). Overrides log to **stderr** (never stdout — the CLI's stdout-JSON
pipeline must stay clean).

The runner seam is deliberately small: a ~15-line branch in
`instantiatePattern` ([runner.ts](../../../packages/runner/src/runner.ts))
calls `planInterpreterDispatch`. If the result is `{ kind: "interpret" }`, the
runner instantiates the returned synthetic node list instead of
`pattern.nodes`; otherwise it takes the legacy path. Synthetic segment nodes
are ordinary `{ type: "raw" }` modules; they flow through the existing
`instantiateRawNode` path with two opt-in markers (`ri2ThreadNarrowestReadScope`
for scope threading, §12). Nothing about flag-off instantiation changes.

---

## 4. The ROG (Reactive Operation Graph)

The ROG is a flat, topologically-orderable list of **ops** over a closed
vocabulary, defined in
[rog.ts](../../../packages/runner/src/reactive-interpreter/rog.ts).

### 4.1 Ops

`Op { id, kind, inputs: ValueRef[], outSchema: SchemaHandle, detail }`. Op ids
are dense array indices. Every ref an op reads is surfaced through one
producer-edge view (`inputsOf`), so partition, topological sort, and CFC need
no per-kind special cases (structural detail refs — a collection's `listInput`,
a control's branches, a construct's template leaves — are unioned in). Ops are
**pure by construction** except `effect`. Op kinds:

| Kind | Meaning |
| --- | --- |
| `leaf` | An opaque JavaScript function (a `lift`/`computed` body), run by reference to its live implementation. Takes one structured input, returns one value. |
| `interpolate` | A native template-literal join (`` str`a=${x}` ``): static string segments interleaved with value refs. No opaque body, no SES. |
| `expr` | A native JS operator over a closed allow-list (arithmetic, comparison, bitwise, shift; unary `-`/`+`/`~`/`!`). *Defined and evaluable; not yet emitted* — see §14. |
| `construct` | Builds an object/array literal from a template of value refs (a lifted input tree or result subtree). No legacy alias — recomputed wherever referenced. |
| `access` | Member access on a value (`.key(...)` chains lowered to a path). |
| `control` | `ifElse`/`when`/`unless`, with tagged branches (§4.3). |
| `collection` | `map`/`filter`/`flatMap` over a list, carrying its element graph inline (§4.4). |
| `pattern` | A nested pattern invocation, carrying the child ROG inline when known. |
| `effect` | A boundary: handler, render, `pull`, or I/O builtin. Carries its data `inputs` and `writeTargets`. |
| `call` | A helper-function or stdlib-method invocation. *Defined; not yet emitted* — see §14. |

### 4.2 ValueRefs

A `ValueRef` names a value in the ROG's value space:

- `argument` — a path into the pattern's argument (`{ kind: "argument", path }`).
- `opOut` — the output of another op, by id, at a path.
- `const` — an inline constant. Gated to **doc-normalization fixed points**
  (§5.3).
- `internal` — an internal cell (handler-written `cell(...)` state, derived
  internal defaults), by index into the ROG's `internals` table.
- `external` — an externally-identified cell, by index into the ROG's
  `externals` table (the exact serialized reference legacy writes).
- `result` — a self-reference to an egress root (a result subtree that feeds
  the pattern's own computation).

Tables (`internals`, `externals`) are indexed, not string-keyed; nested ROGs
carry their own tables, so frames fall out structurally.

### 4.3 Control is tagged, not positional

`Control { op, pred, then: ValueRef | "pred", else: ValueRef | "pred" }`. The
asymmetric "else returns the predicate value" semantics of `when`/`unless` are
explicit in the IR via the literal `"pred"` sentinel, so the evaluator has one
rule (`truthy(pred) ? then : else`) and never guesses per builtin. `ifElse`:
`{then: a, else: b}`; `when(c, v)`: `{then: v, else: "pred"}`; `unless(c, f)`:
`{then: "pred", else: f}`.

### 4.4 Collections carry their element graph inline

`Collection { op: "map"|"filter"|"flatMap", listInput, params?, element? }`.
The element computation is an **inline child ROG** built once at construction —
never re-parsed from pattern bytes at runtime. The op also captures a `params`
ref (the second argument of `mapWithPattern`/etc.) for the segment-resident
evaluation path (§11).

### 4.5 Schemas are interned

Ops carry `SchemaHandle`s into a per-ROG intern table rather than full
`JSONSchema` inline. This keeps ops small and feeds the runtime's existing
schema-hash caches (schema-identity churn was historically a hot-path
regression class).

### 4.6 Egress

The ROG's `result` value ref records the pattern's egress root — the observable
result tree — so materialization never re-derives "what is observable" from a
runtime walk.

---

## 5. Builder-born construction

The ROG is **not** emitted by the transformer and **not** serialized into the
pattern JSON. It is recorded by the builder at `pattern()` finalization, from
the live builder objects, in a WeakMap side-table.

### 5.1 Why the builder

Compiled patterns are constructed by *executing* the pattern factory once at
module load (`pattern(fn)` pushes a frame, runs `fn`, collects nodes). The
transformer emits ordinary builder calls (`lift(...)`, `ifElse(...)`, `str`…),
so by the time finalization runs, the builder holds the **live semantic call**:
`ifElse` knows its branches, `str` knows its static template, a builtin ref
classifies by name. There is nothing to *recognize* — construction is direct
mapping from live NodeRefs (live modules, live input/output cells) to ops. This
covers compiled *and* hand-built patterns with one front-end and no transformer
change.

`from-builder.ts`
([from-builder.ts](../../../packages/runner/src/reactive-interpreter/from-builder.ts))
runs at finalization and produces a `BuiltRog`: the `Rog`, plus live side-car
state that is never serialized — `leafImpls` (op id → the live function, so the
interpreter needs no `$implRef`/SES resolution), `children` (inlined nested
ROGs), `leafArgSchemas`, and `collectionElements` (live element factories).

### 5.2 Identity-neutral, always-on, fail-closed

- **Side-table, not a serialized field.** Pattern identity is content-addressed
  from serialized bytes; any new serialized field would break identity
  stability for every existing pattern. The ROG rides in a WeakMap keyed on the
  factory/pattern objects — identity-neutral by construction.
- **A pattern with no live factory has no ROG.** A pattern that arrives as
  plain JSON (with no live builder factory) simply has no side-table entry →
  legacy instantiation. The census tracks how often this occurs.
- **Construction is always-on**; the flag gates *dispatch* only. Building the
  ROG is cheap and its data is inert flag-off.
- **Fail-closed.** Any builder shape the front-end cannot represent marks the
  ROG `incomplete` with a census reason (→ legacy dispatch), rather than
  throwing. Construction never throws into the builder.

### 5.3 Constants must be doc-normalization fixed points

Legacy leaf bodies read their static inputs *after* a document round-trip (the
JSON data model); the interpreter feeds `const` refs to leaf functions
*directly*. So a `const` is admitted only if it is a value the doc round-trip
cannot change: finite numbers, strings, booleans, `null`, and plain containers
of the same (via `isPlainObject`; `undefined` is allowed as an object property
where legacy drops the key, but refused in an array slot where JSON would null
it). `NaN`/`±Infinity` (→ `null`), `Date`/`Map`/typed arrays, sparse holes, and
`bigint` refuse with `non_fixed_point_const` → the whole pattern runs legacy.

### 5.4 Template literals

`` str`…` `` is a framework builtin whose body is marked in a WeakSet at builder
time (`markStrInterpolation`); the front-end recognizes the mark and lowers it
to a native `interpolate` op rather than an opaque leaf — no SES for string
interpolation. (The end-state is direct transformer emission of `interpolate`;
the WeakSet mark is the current, serialization-safe interim — see §14.)

---

## 6. Dispatch

`planInterpreterDispatch(pattern, options)`
([dispatch.ts](../../../packages/runner/src/reactive-interpreter/dispatch.ts))
is a pure decision + closure construction — no runtime side effects. It returns
either `{ kind: "interpret", nodes }` or `{ kind: "fallback", reason }`.

### 6.1 The strict lookup, and why there is no recovery path

Dispatch uses the **strict** `getBuiltRog` (direct WeakMap key). The ROG's op
ids are positional against *this exact object's* `pattern.nodes`; binding a
canonical ROG against a *different* object's nodes would mis-wire. On a miss, the
pattern simply runs legacy (`no_rog`).

Referenced patterns reach instantiation as their **live canonical**: an
authored sub-pattern passed as an input binds as a compact `{ $patternRef }`
sentinel that the binding machinery resolves back to the builder-keyed object
(so it is a strict hit), and a reloaded pattern re-runs its factory (also a
strict hit). The only thing that can arrive as a fresh derived *copy* is a
ref-less hand-built / bare-Engine pattern; it just runs legacy — a correct,
fail-safe fallback, not a wrong answer. (An earlier design recovered derived
copies via a validated canonical-ROG path; once patterns bind as `$patternRef`,
that path became unreachable and was removed — see design-history.)

### 6.2 Leaf trust and capability gates

Two per-leaf gates demote an op to a preserved boundary:

- **Trust** (security): a captured live leaf runs in the interpreter only if it
  passes the exact legacy `liveTrusted` test — module-eval provenance, or an
  entry-ref this runtime's engine resolves back to the same function. An
  untrusted callback demotes to a verbatim legacy node, where the SES fallback
  sandboxes it.
- **Capabilities**: `computeLeafCaps`
  ([leaf-caps.ts](../../../packages/runner/src/reactive-interpreter/leaf-caps.ts))
  scans a leaf for pattern instantiation, cell-context needs (schema + `.get`/
  `.sample`/`.for`), and input writes. A capability-bearing body stays a
  boundary (it needs handles / builder frames the legacy javascript action
  provides). Ungated capture-less computeds (`argumentSchema === false`) are
  exempt from the run-gate (§10).

### 6.3 Consumed-as-value analysis

`findValueConsumedOps` computes, to a fixpoint, which nested-`pattern` ops and
which `collection` ops are safe to evaluate *in-segment* rather than as
boundaries. A candidate is admitted iff its child/element ROG is fully inlinable
**and** its output is never *retained* — never referenced from the result tree,
an effect's inputs/writeTargets, another boundary op, or a transitively-retained
construct. Retention sites need an addressable *piece* (the launched-child
contract; a materialized coordinator passes element cells). The walk is a
fixpoint because an admitted candidate stops retaining its own inputs, so
chained pipelines (`items.filter(..).map(..)` feeding a lift) cascade to zero
documents (§11).

### 6.4 The plan

Dispatch partitions the ROG (§7), builds one segment node per pure region that
collapses ≥1 node-derived op (§8), and preserves every boundary op's **original
node verbatim** — except an eligible materialized `map`/`filter` boundary, which
swaps its coordinator for the inline one (§11). A **cost gate** refuses when
fewer than two node-actions would collapse and no collection inlined (1→1 is
neutral). It records an honest **census** (attempted / interpreted /
fallbackByReason / nodeOpsSeen / nodeOpsCollapsed / boundariesByKind /
transientCollections / controlsFused / controlOpsGated) so engagement is
measured, never assumed from "it didn't error."

---

## 7. Partition

`partition`
([partition.ts](../../../packages/runner/src/reactive-interpreter/partition.ts))
is a pure function: a layered topological assignment plus union-find over
same-layer pure↔pure edges.

- **Boundaries** (`boundaryKindOf`): `effect`; `control` unless admitted
  fused (§7.1); `collection` unless admitted transient (§11);
  `pattern` unless admitted value-consumed (§6.3); `unresolved-leaf` (missing
  impl); `gated-leaf` (untrusted or capability-bearing, §6.2). Everything else
  is pure.
- **Layering to a fixpoint**: an op's layer is `max(layer of producers)`; a
  boundary's output is available one layer later.
- **Segments**: a maximal connected component of pure ops within a layer
  (union-find over same-layer pure↔pure producer edges) — the tightest
  read/write sets.
- It recurses structurally into collection elements and inlinable pattern
  children. Unresolved refs are **errors** (fail-closed), never external inputs.

Write-back cut edges (a handler's `S → handler → S` footprint) are deliberately
**not** modelled in the first partition: naive edges create a false cycle (a
handler's input construct references the very cell it writes — a binding, not a
read-after-write), and under pull scheduling the hazard is re-run churn, not
value correctness. This stays an open, measured item (see design-history,
D-F4-DEFER).

### 7.1 Native control emission (fused controls)

`ifElse`/`when`/`unless` (and the ternaries that lower to them) exist to
provide **conditional subscription**: the legacy builtin depends on the
predicate only and forwards a *link* to the taken branch, so writes to the
untaken branch's inputs wake nothing. Fusing a control into a segment
preserves exactly that — the merge **branches**, it is never a flat
union-read region:

- **R-CONTROL-READS** (the invariant, oracle-enforced): a fused segment's
  run reads at most `predicate-inputs ∪ active-branch-inputs`. Because
  subscription is the committed reactivity log, the short-circuiting
  executor gets conditional subscription for free.
- **Demand-driven evaluation** (§10): a control-fused segment evaluates
  from its written aliases by memoized demand; a `control` op demands its
  predicate, then only the taken side. Branch-gated inputs are carved out
  of the eager input read into per-key lazy reads, and the argument is
  read **per path** — an untaken branch's argument link is never
  dereferenced.
- **Gated ops**: an op consumed only through fused-control branch positions
  (transitively — computed by a monotone forced/gated fixpoint over
  branch-tagged consumption edges) has its alias write **elided**: its
  documents vanish and it evaluates only when its side is taken. Everything
  externally consumed (result tree, effects, boundaries, other segments)
  stays forced.
- **Reference passthrough**: a retained fused control whose taken side is a
  bare ref (external cell, argument path, upstream alias, unproduced
  internal) forwards the resolved **link** via a live cell handle
  (identity-only resolution) — write-through and flip-retargeting behave
  exactly like the legacy builtin's branch link. Computed sides materialize
  by value.
- **Fail-closed admission** (`findFusableControls`): a control that
  declares static scope routing stays a boundary; a **possibly-retained**
  control whose branch value closure contains structured producers
  (construct / collection / pattern) stays a boundary — legacy writes a
  link-bearing tree there (per-position scope annotations, live sub-links)
  that a value write would flatten. Bare refs and scalar chains
  (leaf/expr/interpolate/access) are safe; value-consumed controls are
  exempt (their branch values live in memory only).
- Control ops also no longer disqualify collection **elements** or
  value-consumed children (eager both-sides evaluation there — value and
  error parity with the legacy child, whose branch lifts also both run),
  with one exception: the materialized inline **filter** refuses
  control-bearing predicates until its membership-taint machinery is
  calibrated for branched predicates.

Under pull scheduling legacy is *already* quiet on untaken-branch writes
(no demand flows into the unselected branch), so the win is documents and
action-count, not avoided recompute — and the trigger-count oracle's job is
guarding that fusion never regresses that quietness.

---

## 8. Segment emission

For each segment, `buildSegmentNode` assembles a **sub-ROG** — the segment's
node ops plus every construct op they transitively reference (constructs have
no legacy alias, so they are recomputed wherever needed; duplication across
segments is sound because they are pure) — and computes its exact I/O bindings:

- **Inputs.** The pattern argument (when read); externally-written internals by
  cause; upstream boundary/segment op outputs through their **original output
  aliases**; external cells by their exact serialized reference; and
  fully-external leaves' original input trees (bound through the leaf's own
  `argumentSchema` — legacy `readJavaScriptArgument` semantics, so a transiently
  partial upstream value resolves the way legacy resolves it instead of a raw
  deep-read that throws).
- **Outputs.** Each segment node op writes its **original output alias**. This
  is the whole trick: a segment feeding three boundaries just writes the three
  internal cells those boundaries already alias — no fan-out primitive, no
  container of links.

The segment's raw implementation (`makeSegmentImplementation`) runs inside a
pattern frame (the legacy `createPatternFrame`, giving leaf bodies the runtime
context and carrying the piece metadata the scheduler's error handler reads off
`error.frame`), resets the tx's narrowest read scope (§12), seeds the evaluator
with the bound external values, evaluates the sub-ROG, writes every collapsed
op's value through its original alias in one action, and — matching legacy
per-node error containment — surfaces the first isolated op error *after* the
writes land (writes survive; the throw notifies handlers).

---

## 9. Boundaries are preserved verbatim

A boundary op is instantiated from its **original serialized node**, unchanged.
This is what makes the alias topology self-wiring: handlers, effects, control
nodes, non-inlinable nested patterns, and materialized list coordinators keep
exactly the reads, writes, identities, and scopes the legacy builder gave them.
The interpreter only ever *replaces pure regions*; it never re-implements a
boundary's semantics.

Resumed-from-synced-state instantiation (the runner's
`awaitSyncBeforeInitialRun`) additionally refuses inline collection substitution
(§11): the resume/recovery machinery is the battle-tested legacy path, and a
degrade inside a synthetic wrapper is not byte-identical to a legacy node.

---

## 10. Evaluation

`evalRog(rog, ctx)`
([interpret.ts](../../../packages/runner/src/reactive-interpreter/interpret.ts))
evaluates a ROG to its result value, plus the per-op value map and the isolated
runtime errors (for scheduler `onError` parity).

- **Topological pass** with **per-op error isolation**: a throwing op yields
  `undefined` downstream and records an error, exactly matching legacy per-node
  containment. A structural "cannot interpret this here" (`NotInterpretedHere`)
  propagates to the dispatch → legacy fallback; it is never silently isolated.
- **Demand mode** (control-fused segments, §7.1): ops evaluate by memoized
  demand from the segment's written aliases (`demandRoots`); a `control` op
  demands its predicate plus the taken side only. Ops reachable only through
  an untaken side never run — no reads, no errors, no scope. Lazy input
  thunks and per-path argument reads land inside the demanding op's scope
  bracket. For control-free ROGs, demand over the topological order is
  byte-identical to the eager pass, which elements and probes stay on.
- **`resolve`** dereferences a `ValueRef`: `const` → its value; `argument` →
  navigate the argument; `opOut`/`internal`/`external` → navigate the produced/
  seeded value; `result` → the dispatch's materialized result cell.
- **Seeding.** A segment's refs may name producers *outside* the segment
  (upstream boundary/segment outputs, handler-written internals, external
  cells); the dispatch feeds those values via `seed` / `seedByInternal` /
  `seedByExternal`, and fully-external leaves via `leafInputOverrides`.
- **The leaf run-gate** (leaves only, legacy parity): a chained leaf whose input
  resolved to `undefined` (because an upstream op threw or hasn't produced) does
  **not** execute — unless `ungated` (the `argumentSchema === false` capture-less
  computed bypass). `interpolate`/`expr` are *not* run-gated (operator/`+`
  coercion must see `undefined`).
- **Probe mode** returns structural verdicts without invoking leaf bodies.
- **Children** (inlined nested patterns) recurse with their own live side-car.

Op evaluation is direct: `interpolate` is the byte-for-byte framework
`interpolatedString` body; `expr` applies the exact JS operator; `access`
navigates a path; `construct` builds the object/array; `control` applies the one
normalized rule; `collection` runs the transient path (§11); `pattern` inlines
the child ROG; `effect`/`call` are `NotInterpretedHere` (boundaries / future).

---

## 11. Collections

Two evaluation strategies, chosen by whether the collection's output is
retained.

### 11.1 Transient (segment-resident) — the zero-document path

A `map`/`filter`/`flatMap` whose output is **value-consumed** (admitted by
§6.3) evaluates **in memory inside its segment** via the `collection` case of
`evalRog`
([interpret.ts](../../../packages/runner/src/reactive-interpreter/interpret.ts)):
no container document, no per-element documents, no coordinator action. The
common chained case (`items.filter(..).map(..)` feeding a lift) collapses every
intermediate stage to zero documents, cascading through the retention fixpoint.

Semantics are pinned to legacy by differential tests, not assumed: `map`
preserves sparse holes; `filter` keeps the *original* item on a truthy
predicate; `flatMap` matches the legacy `contribute` rule (array → spread,
defined non-array → the value itself, `undefined` → nothing). An `undefined`
list yields `[]` (the container's seeded value a downstream leaf would read).

Notably `flatMap` is **unlocked** here: the reason it stays legacy when
materialized (below) is that its concat over per-element arrays re-keys
container slots on any element's length change; in memory there are no slots.
The reactive trade is deliberate — the segment's deep list read re-runs it
wholesale on any element change (in-memory recompute, no doc round-trips) vs the
materialized path's per-element incrementality.

### 11.2 Materialized (inline coordinators) — the incremental path

A retained `map`/`filter` output keeps a coordinator, but the interpreter swaps
the legacy child-pattern coordinator for an **inline** one
([collection-inline.ts](../../../packages/runner/src/reactive-interpreter/collection-inline.ts)):
per element, one read-isolated scheduled effect evaluates the element/predicate
ROG (the live child `BuiltRog`, no child pattern) and writes one per-element
document — roughly 1 doc + 1 effect per element, versus legacy's ~3 docs + ~4
nodes. Key properties:

- **Legacy-parity element identity**: runs are keyed by the element's resolved
  link identity + occurrence, and per-element causes match legacy's
  (`{map: result, elementKey}` / `{filter: result, elementKey}`) so a flag flip
  or a degrade mid-life resolves the same per-element cells. Element result
  writes consolidate a rendered VNode subtree into one document
  (`setRawUntyped(fabricFromNativeValue(convertCellsToLinks(out)))`) instead of
  fragmenting per node.
- **Read isolation**: each element effect reads only its slot, in its own tx →
  structurally pointwise CFC. The coordinator's own container reads are
  identity-only (link-resolution probes), keeping its flow-join empty.
- **`filter` membership taint (S16 structure-container contract)**: which
  elements survive is a secret, and the container's *shape* must carry the
  join of the selection **criteria** — even when the result is `[]`. The
  coordinator declares its container (`tx.recordCfcStructureContainer`), and
  the membership stamp re-derives from its per-tx join **every reconcile**
  (replace-from-criteria, decoupled from value writes — growth and no-write
  re-stamps land through the declaration). An element's **first** predicate
  evaluation runs inline in the coordinator's own tx so its genuine reads
  (element content only when the predicate consumes it) are the stamp;
  subsequent changes go through the pointwise per-element effects, whose
  predicate-result reads keep feeding the join. The list root read is
  value-class (never probe-marked — a followRef would join every element's
  per-slot link-origin label, the index-only over-taint).
- **Monotonic degrade**: scoped lists/elements, runtime op swaps, and resumed
  coordinators degrade to the *real* legacy builtin (identical signature +
  container cause, so the handoff is seamless). Once degraded, stay degraded.
- **`flatMap` materialized stays legacy** (a verbatim boundary; see §11.1 and
  design-history D-FLATMAP-LEGACY).

---

## 12. Scopes

Cell scope (`space` | `user` | `session`) narrows: a value derived from
session-scoped data is session-scoped even if its output slot was declared
`space`, and the write lands in the scoped instance with a redirect from the
space doc. Legacy already does this **per node action**, via the transaction's
narrowest read scope + `sendValueToBinding`'s scoped-instance-plus-redirect
write.

Because a segment collapses N legacy actions into one, the interpreter's
obligation is **granularity**: one tx-ambient scope would smear a scoped read
across sibling ops (a scoped-input computed *and* a plain sibling computed in
one segment). The segment therefore tracks the narrowest read scope **per op**
and threads it into each op's write (`ri2ThreadNarrowestReadScope`), which is
exactly legacy's per-action behaviour. Three properties make this correct:

1. **Lazy derefs**: leaf inputs are query-result proxies, so the scoped link's
   dereference happens inside the leaf *body*, not at seed read — the per-op run
   bracket is what attributes the scope.
2. **Journal invariance**: the segment's journaled read set drives its re-run
   reactivity and must stay byte-identical, so scope attribution uses bare
   `resolveLink` (self-exempt probes) + run brackets, never extra reads.
3. **Cache awareness**: the per-tx `Cell.get()` cache records each fill's
   narrowest scope and replays it on a hit, so scope tracking sees reads the
   cache would otherwise elide.

Static scope markers (`.asScope`/`.inSpace`, `PerUser`/`PerSession` schema
folds, cross-space routing) stay **legacy-owned**: raw-builtin output-binding
folds, pattern-node child scoping, and frame-result schema folds are all
boundary territory (verbatim instantiation). Value-consumed inlining refuses
scope-declaring children.

---

## 13. Contextual Flow Control (CFC)

The interpreter is in the trusted computing base (per-interpreter trust, no
per-ROG granularity); **the ROG is untrusted data**. Two invariants hold the
line:

- **R-CFC-1**: label *values* come only from what the interpreter actually reads
  at runtime, under structurally enforced read isolation — never from the IR. A
  wrong or adversarial ROG computes a wrong *value* (the author's own data)
  inside *correct* labels; it cannot induce an unsound label.
- **R-CFC-2**: structure is an untrusted hint; fail closed to the conservative
  join.

Consequences that fall out of the architecture:

- **Read isolation is enforced, not asserted**: per-element evaluation runs
  against a scoped view where a cross-element read is an error. A deliberately
  de-isolated interpreter must fail the pointwise oracle (a permanent CI gate).
- **Per-segment label granularity is COARSER than legacy (known gap).** Scope
  is attributed per op (§12, the `runScoped` brackets), but the CFC flow-join
  is one `deriveFlowJoin(tx)` per segment transaction, so a segment that
  collapses two *independent* mixed-label ops stamps **both** outputs with the
  join. Legacy runs each in its own tx and keeps them separate
  (`{fromSecret:[SECRET], fromPublic:[PUBLIC]}` legacy → `[PUBLIC,SECRET]` on
  both, flag-on). This is **fail-safe** (over-taint, never under-taint — no
  leak) but a real **precision regression**: under render-ceiling enforcement
  an over-tainted public output over-blocks. Zero impact flag-off; a
  **default-on blocker** for mixed-label patterns. The fix is per-op label
  attribution mirroring the per-op scope work (segment records per-op reads;
  `prepare` stamps each write-path with its op's read-join) — tracked, not yet
  built. Pinned by `control-emission`/label characterization tests in the
  fail-safe direction.
- **Boundary read-through by construction**: because the IR carries
  `effect.inputs`/`writeTargets`, every boundary-input document is produced by a
  labelled read-through as a property of emission — no "remember to extend
  extraction" precondition.
- **Flow join vs view accumulation**: output labels use confidentiality-union +
  class-aware integrity-meet (`deriveFlowJoin`); label *views* carry path labels
  but never derive them (the union-raises-integrity trap).
- **Materialized collections** get pointwise labels structurally (per-element
  tx); `filter` membership taint rides the S16 structure-container contract —
  the coordinator declares its container (`recordCfcStructureContainer`) and
  the membership stamp re-derives every reconcile from exactly the criteria
  reads in its per-tx join (the first-pass predicate evaluation reads element
  content only when the predicate consumes it; the list root read is
  value-class, never a followRef). Transient collections are sound by
  construction: the segment's journaled deep list read joins element labels
  into the per-tx join, and there is no materialized container shape to stamp.
- **Fused controls narrow soundly**: the untaken branch is never read, so its
  label never joins — the same join a legacy reader gets (the legacy result
  link dereferences into the taken branch only). Which branch was selected is
  covered by the predicate's label, read in the same bracket.

---

## 14. What is not built (and why it's safe that it isn't)

Every item here is a *further* optimization; none is a correctness gap, because
the missing case always falls back to legacy or to a preserved boundary.

- **Native `expr` op emission** (§4.1). `expr` is defined and the evaluator
  handles it, but nothing emits it yet: a JS operator expression in a pattern
  still lowers to a `lift`, which the interpreter runs as a `leaf`. The
  transformer increment that emits `expr` directly (the operator analogue of
  `interpolate`) is a hygiene/perf win — live leaf capture already removed SES
  from the trusted leaf path, so it only drops the wrapper. Same for the
  end-state of `str` → direct `interpolate` emission.
- **Function lowering** (`fn`/`call`, §4.1). Helper functions and a curated
  pure-method stdlib called from pattern code could lower to IR (interpreted
  natively, capability-gated, differential-oracle-verified); today they are
  opaque leaves. `call` is `NotInterpretedHere`.
- **Control-emission residuals** (§7.1). Native control emission is built;
  three refusal classes remain deliberately conservative: retained controls
  with structured (construct/collection/pattern) branch closures stay
  boundaries (a value write would flatten legacy's link-bearing tree);
  scope-declaring control nodes stay boundaries; and the materialized inline
  filter refuses control-bearing predicates pending membership-taint
  calibration. Each is a measured follow-up, not a correctness gap.
- **`flatMap` materialized inline** (§11.2) — stays legacy by decision.
- **Write-back (F4) partition edges** (§7) — deferred pending a measured
  conflict ratchet.
- **Per-path read-set deltas** — segments re-run wholesale on any read-set
  change; selective per-trigger recompute for large segments/collections is a
  future optimization, never a correctness dependency.

Known residual: under the flag, a specific resume-with-held-documents test path
leaves one pending async op at process exit (the test passes; flag-off is clean;
CI runs flag-off). Root-caused to the inline filter's build→resume interaction;
tracked as a storage-layer follow-up.

---

## 15. Non-goals

- **NG1 — IFC inside leaf bodies.** Opaque leaves keep coarse
  all-inputs-taint-all-outputs labels.
- **NG2 — a new trust root.** The builder/IR is not a trust boundary. The IR is
  untrusted data; labels derive from actual runtime reads under structural read
  isolation. Compiler/builder-emitted annotations are fail-closed hints — they
  can only cause a boundary or a fallback, never grant a capability.
- **NG3 — interpreting arbitrary JS.** The interpreted vocabulary is a closed,
  oracle-verified set; everything else is an opaque leaf decided at construction.
- **NG4 — a second propagation channel.** Segments and per-element effects are
  ordinary scheduler nodes driven by the one storage notification channel.
- **NG5 — preserving derived internal-cell identity.** User state and
  externally-referenced outputs are preserved across the flag; derived interior
  is not.

---

## 16. Results

Measured flag-on vs flag-off (the differential harness,
[measure.test.ts](../../../packages/runner/test/reactive-interpreter/measure.test.ts)
and `measure-map.test.ts`):

| Scenario | Metric | Off | On | Δ |
| --- | --- | --- | --- | --- |
| 6-lift chain + 2 `str` | scheduler nodes | 12 | 5 | −58% |
| | wall | ~49ms | ~15ms | −70% |
| `map`, N=10 | documents | 54 | 24 | −56% |
| | scheduler nodes | 46 | 26 | −43% |
| | wall | ~89ms | ~31ms | −65% |
| `((a+b)>0 ? c+d : e+f)*2` | actions per taken-branch write | 10 | 2 | −80% |
| (fused control, §7.1) | actions per predicate flip | 15 | 2 | −87% |
| | actions per untaken-branch write | 0 | 0 | parity |

Engagement on the authored corpus (the 87-file pattern-test run, flag-on):
224 interpret decisions with **60% of node-ops collapsed**, and control
emission engages broadly — **764 controls fused across 128 instantiations,
with 1,254 branch-gated ops** whose alias writes (documents) are elided.

**What the micro-benchmarks measure vs. what a real app sees.** The table's
per-scenario numbers (−56% documents on a pure `map`, −43%–58% nodes) are
*pure-computation* micro-benchmarks — the compressed docs *are* the whole
pattern. They do **not** generalize to a real app's document count. A
full-integration A/B (both realms uniform, see below) found the persisted
document count essentially flat (−2.2%, single noisy run) while **commits
dropped ~10%**. The reason: a real app's persisted store is dominated by
**boundary** documents — rendered VNodes (the plurality), result-tree and
handler docs, piece metadata — all of which the interpreter preserves by
design (NG5 + boundaries-verbatim). The documents it removes are *internal
pure-computation* cells, only a few percent of a rendered app's store, and a
rendered list's per-element outputs are materialized VNodes (boundaries),
not the transient zero-doc case. **So the interpreter's general lever is
action / commit reduction — roughly half the scheduler nodes and ~10% fewer
commits, i.e. less re-run churn, sync traffic, and conflict surface — not a
large drop in the document *count*.** The document-count win is real only
where pure computation dominates: non-rendered data-transform pipelines and
derived state.

**Realms must roll out uniformly.** A full-integration A/B where the
Deno-side runtime interpreted while the browser worker ran legacy produced a
20–38× slowdown on multi-runtime CFC tests — a **capability-skew artifact**
(divergent write/label behavior across realms → mutual conflict/re-run
churn), *not* interpreter cost. With the flag plumbed through the browser
worker so both realms interpret, the slowdown vanishes and wall-clock is at
**parity** with flag-off (420 s vs 429 s), the multi-runtime chat/CFC tests
run at flag-off speed, and there is no pull-amplification pathology (the
~226–270× timeouts an earlier meta-node design hit are absent). The
interpreter must therefore go default-on across *every* realm at once
(Deno + browser worker + in-process servers), never per-realm.

Outputs are asserted byte-equal to legacy across the differential, scope,
transient-collection, and coverage suites; the root test suite is green under
both flag states.

---

## 17. Code map

All under `packages/runner/src/reactive-interpreter/`:

| File | Role |
| --- | --- |
| `rog.ts` | The IR: op/ValueRef types, closed operator sets, `inputsOf`/`writesOf` helpers. |
| `from-builder.ts` | Builder-born ROG construction; the `BuiltRog` side-table; strict `getBuiltRog`. |
| `interpret.ts` | `evalRog` — the evaluator, including the transient-collection case. |
| `partition.ts` | Pure partition into segments + boundaries. |
| `dispatch.ts` | `planInterpreterDispatch` — trust/caps gates, consumed-as-value analysis, segment emission, census. |
| `collection-inline.ts` | The materialized inline `map`/`filter` coordinators. |
| `leaf-caps.ts` | Per-leaf capability scan. |
| `builtin-markers.ts` | `str`-interpolation and output-scope markers. |

Plus the ~15-line dispatch seam in `runner.ts`, the flag in `runtime.ts`, and
the `$patternRef` binding in `pattern-binding.ts`. Tests live in
`packages/runner/test/reactive-interpreter/` (unit + differential + measurement)
and top-level runner tests (`pattern-node-patternref`, scope, resume).
