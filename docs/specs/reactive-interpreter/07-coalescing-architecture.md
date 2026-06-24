# 07 — Coalescing architecture: the interpreter as a pure-region coalescing pass

> **Status**: design revision (2026-06-24). Supersedes the **all-or-nothing
> eligibility** model of [02-design.md](./02-design.md) / the landed
> implementation, in which a pattern containing *any* interpreter-ineligible op
> (an I/O builtin, an effect, a handler) falls back to legacy **in its entirety**.
> See [implementation/DECISIONS.md](./implementation/DECISIONS.md)
> §D-COALESCE for the decision record. This is a design proposal, not yet
> implemented.

## 1. The flaw this fixes

The landed dispatch is **all-or-nothing per pattern**: `buildInterpreterPattern`
extracts the whole pattern to a ROG and, if **any** op is not in
`{leaf, access, construct, control}` (plus the single-`map` collection case),
throws `NotInterpretedHere` and the **entire pattern-instantiation** falls back
to legacy per-node materialization.

That is fatal in practice, because the ineligible ops are not edge cases — they
are the substrate of real patterns: `fetchData` / `fetchProgram`, `llm` /
`generateText` / `generateObject` / `llmDialog`, `sqliteQuery` / `sqliteDatabase`,
`wish`, `compileAndRun`, and **handlers** (every interactive control). A single
such builtin anywhere in a pattern body disqualifies *all* of that pattern's pure
computation — its `computed`s, `lift`s, `map`s, `ifElse`s — even though those
nodes are individually interpreter-eligible.

Measured consequence (see implementation/PROGRESS bench rows): on lunch-poll only
~18% of pattern instantiations interpret, and at the **node** level the
interpreter collapses only ~4% of the graph, because the node-heavy
`PollOptionCard` (~90% pure computation) falls back wholesale on account of a
handful of co-located `fetchData`/`generateText`/handler ops. The pure nodes are
not ineligible — they are **trapped** beside a few effects.

**Measured (static partition prototype, `packages/patterns/tools/coalescing-partition-probe.ts`,
over 7 real fall-back-today patterns):** boundaries are only **6.7%** of ops
(100/1496); **93.3%** are pure and would coalesce into **33 segments**; projected
**node** footprint **133 vs 246 legacy = 45.9% reduction**. The marquee trapped
case — lunch-poll's `PollOptionCard` — is **166/180 ops pure → 15 vs 50 nodes
(70% collapse)**, versus **0%** interpreted under today's all-or-nothing gate.
(Node reduction is the validated claim; see §4.3 / §4.8 on the separate, gated
doc-win.)

## 2. The reframe

**The interpreter must not execute the I/O builtins.** They are — and must remain
— real scheduler nodes with real input/output documents: a fetch result, a query
result, a generated value, a handler's event stream all need to *persist* and to
be *scheduled* (re-run on input change; fire on event). Trying to absorb them into
the interpreter would mean re-implementing I/O, effect scheduling, and event
dispatch inside the interpreter — a vast, wrong lift.

Instead, the interpreter's job is to **coalesce the pure computation *around*
them**. Concretely, the interpreter stops being "one trusted meta-node per
eligible pattern" and becomes a **pure-region coalescing pass** over the pattern
graph:

> Replace each maximal connected subgraph of pure ops
> (`leaf`/`access`/`construct`/`control`, and pure `map`/`filter`/`flatMap`) with
> a **single interpreter segment node**, and **preserve every I/O / effect /
> handler node** as a scheduling-and-materialization **boundary**. Hand the
> resulting coarser DAG to the existing scheduler unchanged.

Eligibility flips from *"is the whole pattern pure?"* (almost never) to *"can the
pattern be partitioned into pure regions and boundary nodes?"* (almost always
yes). The interpreter starts helping nearly every real pattern.

## 3. Why split segments (Option 2), not one node + scheduler ordering (Option 1)

Two implementations were considered.

**Option 1 — one interpreter node + give the scheduler the topo order.** Keep a
single interpreter node spanning all the pure computation, with the builtins as
real nodes, and teach the scheduler the intra-node order.

This does not work as stated, and the reason is a **cycle**. Consider
`a = computed(args); d = fetch(a); b = computed(d); return b`. One node computing
both `a` and `b` *produces* `a` (consumed by `fetch`) **and** *consumes* `d`
(produced by `fetch`): `interp ⇄ fetch` — a 2-cycle, which the scheduler cannot
topologically order. "Give the scheduler the topo sort from the interpreter"
means the scheduler must run the node **in stages** — compute `a`, yield, run
`fetch`, resume to compute `b`. But staging a single node *is* splitting it. So
Option 1, done correctly, **is** Option 2 with a shared node identity — plus it
forces:

- a real scheduler change (interleave sub-node execution with builtin runs);
- a **re-entrant / resumable** interpreter node;
- re-implementing, *inside* the interpreter node, the machinery the scheduler
  already provides per node — sub-node invalidation, sub-node CFC labels,
  sub-node materialization;
- coarse re-execution: any input change re-runs the *whole* pure computation
  (and risks re-firing effects), versus re-running only the affected region.

**Option 2 — distinct segment nodes.** Emit `seg0 → builtin1 → seg1 → builtin2 →
…` as a clean DAG of first-class scheduler nodes. The scheduler runs it
**unchanged** — normal reads/writes/invalidation per node — and each segment and
each builtin re-runs only when *its* inputs change. Every segment is a first-class
node, so it inherits the scheduler's invalidation, CFC, and materialization for
free.

**Decision: Option 2.** Option 1 is either unschedulable (the cycle) or
degenerates into Option 2 with extra machinery one would have to build by hand.

## 4. The architecture

### 4.1 Boundary nodes vs pure regions

Classify every ROG op:

- **Boundary** = anything the interpreter does not evaluate purely: I/O/async ref
  builtins (`fetch*`, `llm`/`generate*`, `sqlite*`, `wish`, `compileAndRun`),
  effects, **handlers**, serialized `$patternRef`/`$implRef` it cannot resolve,
  scoped-cell writes it does not model, and (initially) `filter`/`flatMap`.
- **Pure** = `leaf`/`access`/`construct`/`control` and a pure `map` whose element
  is itself fully pure.

Boundary nodes are kept as **legacy-instantiated scheduler nodes** (the existing
`instantiateNode` path), with their real input and output documents. Pure ops are
coalesced.

### 4.2 The partition

Given the pattern's ROG with the boundary set marked:

1. Build the data-flow DAG over all ops (a well-formed pattern is acyclic).
2. **Cut** at every boundary node: a boundary node's inputs come *from* an
   upstream segment (or pattern args); its output feeds *downstream* segments.
3. **Layer** the pure ops: assign each pure op to the earliest segment such that
   all of its inputs are available — i.e. `segment(op) = max over inputs of
   (segment in which the input becomes available)`, where a boundary output
   becomes available in the segment *after* that boundary runs. Pure ops reachable
   only from pattern args land in `seg0`; ops transitively dependent on
   `builtinₖ`'s output land in a segment after `builtinₖ`.
4. Each layer's pure ops become interpreter segment(s) evaluating their sub-ROG
   via `evalRog`. **Segment granularity (decide before implementation, ties to
   OQ-C4):** a single layer may contain *disconnected* pure regions (one feeding
   boundary A, another feeding boundary B). Two choices: **(i) one segment per
   layer** (coarser — simpler, but a change to A's inputs may spuriously re-run
   B's computation in the same node), or **(ii) one segment per maximal connected
   component within a layer** (finer read/write-sets → tighter value-accurate
   invalidation, more nodes). Default to **(ii)** unless the node-count cost
   outweighs the invalidation precision; the prototype (`coalescing-partition-probe.ts`)
   counts under **(i)** (layer = segment), so its segment counts are an upper
   bound on coalescing and a lower bound on segment count under (ii).

The partition is computed **statically at extract/transform time** — the
interpreter has the full ROG and the boundary set, so this is a one-pass layered
topological assignment, cached with the pattern.

### 4.3 Document wiring at boundaries

The pure values *inside* a segment are never materialized (the footprint win). The
**boundaries** get real docs, which they need anyway:

- A segment writes the **input doc(s)** for each downstream boundary node it
  feeds (the boundary's input is a normal cell the boundary reads).
- A boundary node writes its **output doc** (fetch/query/generated result); the
  next segment reads it.
- The pattern's **external outputs** (egress-reachable, per R-MAT-1/2) are
  materialized by whichever segment produces them.

So total materialization = boundary I/O docs (unavoidable real I/O) + external
outputs + (segment outputs that are themselves boundary inputs). Every *internal*
pure intermediate stays un-materialized.

**Scope of the doc-win (important — do not over-claim).** Eliminating internal
pure intermediates is the doc-win for **scalar/object segment results**. It does
**not** currently hold for **VNode/render element results**: per
[DECISIONS §D-VNODE-DOC-FRAGMENTATION](./implementation/DECISIONS.md), the
per-element result write today *fragments* a rendered VNode subtree into one doc
per node, where legacy emits the subtree as one consolidated doc — a measured
*doc regression* (+~2/element) on exactly the rendered `.map` shape coalescing
most wants to help. So **the validated, safe claim of this architecture is the
NODE reduction; the doc reduction is conditional on the VNode-consolidation
precondition in §4.8** and must not be communicated as a doc-win for UI `.map`s
until that lands and is oracle-verified.

### 4.4 Scheduling — no scheduler change

The emitted graph is a DAG of segment nodes and boundary nodes. The scheduler sees
ordinary nodes with ordinary read/write sets:

- a segment node reads pattern args + the upstream boundary outputs it consumes,
  and writes its boundary-input/external-output docs;
- a boundary node reads its input doc and writes its output doc (legacy
  behavior).

Value-accurate invalidation (scheduler-v2 P2) then gives **precise re-execution**:
a change to a pattern arg re-runs only the segment(s) that read it; a boundary
re-runs only when *its* input value actually changes — so a `fetch` does not
re-fire because an unrelated pure value changed. This is strictly finer than the
landed single-node interpreter (which re-runs the whole pure computation on any
input change). **No new scheduler primitive is required** — this is the decisive
advantage over Option 1.

### 4.5 CFC — finer, not coarser

Each segment is one transaction, so it carries **one flow-join over its own
reads** (`deriveFlowJoin`: confidentiality ∪, integrity meet), stamped on its
writes. Because segments are cut at boundaries, a public-args segment stays
public; only the segment that reads `builtinₖ`'s output inherits that builtin's
label (e.g. `fetch`/`llm` results are `LlmDerived`/untrusted, `sqlite` carries its
own). This is **finer-grained than the landed whole-pattern label** (which would
union every input across all boundaries into one smear) — a precision *gain*. The
boundary docs carry the builtin's intrinsic label; downstream segments join it.
Per-element collection labels (the pointwise mechanism from
[03-cfc.md](./03-cfc.md)) compose unchanged within a segment.

### 4.6 Handlers and effects — preserved, never executed

A **handler** is just a boundary node. In legacy it is already a real node: it
materializes a stream link at instantiation (the UI binds to it) and runs its
body per event in its own transaction, writing back into state. The coalescing
pass **keeps the handler node exactly as legacy builds it** and coalesces the pure
computation that feeds it (its bound state) and that consumes its writes
(downstream segments re-run reactively on the handler's writes). **No
handler-execution support is added to the interpreter.** This dissolves the
"event-driven handler execution" lift entirely — and it matches the node-breakdown
finding that handlers are 0 durable nodes; their only cost was trapping the pure
nodes beside them, which coalescing un-traps.

Effects (`fetch`/`llm`/`sqlite`/…) are handled identically: real boundary nodes,
real I/O docs, pure computation coalesced around them.

### 4.7 Collections and control flow (recursion)

- **`map` with a pure element** → a pure op (the existing `$ri-collection-map`),
  lives inside a segment.
- **`map` with an element that contains a boundary** (e.g. a `PollOptionCard`
  with a `fetch`) → the **element ROG is itself partitioned** by the same pass:
  the per-element graph becomes element-segments + element-boundary nodes. This
  is the recursion that un-traps lunch-poll's option cards. (Open question OQ-C2
  below: per-element boundary scheduling.)
- **`control` (`ifElse`/`when`/`unless`)** stays pure *within* a segment when its
  branches are pure. A branch that contains a boundary makes the control op a
  segment-cut point (the boundary in the taken branch is a real node; the pure
  parts of each branch coalesce). Branch selection that gates a boundary is the
  main subtlety — see OQ-C3.

### 4.8 VNode results — a GATING PRECONDITION for the doc-win

The per-segment / per-element output write must **consolidate a VNode subtree into
one document** (not fragment it per node — see DECISIONS
§D-VNODE-DOC-FRAGMENTATION). This is **not a footnote: it is a gating precondition
for the doc-win on rendered collections.** Today the interpreter's per-element
result write fragments a rendered VNode subtree into one doc per node, a measured
+~2-docs/element regression. **Success criterion:** a rendered-element `.map`
must, under coalescing, write each element result as a *single* consolidated VNode
doc, and the differential oracle must show the coalesced doc count ≤ legacy on a
rendered-element corpus pattern. Until this lands and is oracle-verified,
coalescing is a **node win only** on rendered collections (the doc count can
regress), and default-on for rendered collections is **blocked on this fix**.

## 5. The landed implementation is the K-segment special cases

This generalizes, rather than discards, what is built:

- A fully-pure non-collection pattern = **one segment, no boundaries** = today's
  single synthetic interpreter node.
- A top-level pure `map` = today's `$ri-collection-map`, now a pure op inside a
  segment.
- A pure nested pattern (W5a) = inlined into a segment.
- The **new** capability is patterns with boundaries: today they fall back; under
  coalescing they become *multi-segment*.

So the migration is additive: keep the segment evaluator (`evalRog`) and the
collection mechanism; replace the all-or-nothing `buildInterpreterPattern` gate
with the **partition** + multi-node emission; keep the legacy `instantiateNode`
path for boundary nodes.

## 6. Open questions / risks

- **OQ-C1 — partition correctness gate.** The partition must be sound: a pure op
  must never be coalesced across a boundary it actually depends on, and a boundary
  must never be misclassified as pure (the existing `byKind`/classifier work +
  the `unresolved_leaf` net already give the boundary set; reuse it). Fail-closed:
  any op the partitioner cannot place → legacy-instantiate it as its own node.
- **OQ-C2 — per-element boundary scheduling.** A `map` element containing a
  boundary needs per-element boundary nodes + per-element segments. This is the
  per-element-effect machinery (W3) generalized; cost is one boundary node per
  element per boundary (same as legacy already pays), with the pure element
  computation coalesced.
- **OQ-C3 — control flow gating a boundary (DECIDE BEFORE IMPLEMENTATION).** An
  `ifElse` whose branch contains a boundary: is the boundary instantiated
  unconditionally or gated (does a non-taken branch's `fetch` fire)? This is a
  real semantic question, not an implementation detail — **pin it to legacy
  semantics as a decided pre-implementation invariant** (mirror exactly what the
  legacy child-pattern/node does for a conditional builtin), don't leave it to be
  discovered during coding.
- **OQ-C4 — segment read/write-set precision (THE primary implementation risk —
  a correctness gate, not the scheduler).** The scheduler claim (§4.4) is sound
  given landed value-accurate invalidation; the real danger is **over-broad
  segment read-sets** that defeat that invalidation (a segment re-runs when an
  input it doesn't actually use changes) or **under-broad write-sets** (a
  consumer misses an update). The ROG partition gives exact per-segment
  input/output sets — make this an **oracle gate**: assert *segment re-runs ⊆
  legacy re-runs* (no spurious re-execution) and outputs == legacy on every
  corpus pattern under input mutation.
- **OQ-C5 — incremental re-partition on edit.** When a pattern's graph changes
  (rare; pattern args change, not structure), the partition is static per pattern
  identity, so this is a non-issue unless structure is dynamic.
- **OQ-C6 — materialization identity across segments.** Causal carry-through ids
  (R-MAT-3) for retained deep links must hold across segment boundaries; the
  boundary docs already have stable ids, so segment outputs should key causally to
  inputs as today.

## 7. Migration

1. **Partition + multi-segment emission** behind the existing default-off flag:
   replace the all-or-nothing gate with the partitioner; emit segment nodes +
   preserve boundary nodes; wire boundary docs. Reuse `evalRog` per segment.
2. **Differential oracle** as the gate (unchanged discipline): for each corpus
   pattern, the coalesced graph must produce outputs == legacy, with the boundary
   nodes behaving identically. **Gate the two wins separately:** (a) **node
   reduction** + coverage — validated by the static prototype (45.9% corpus,
   70% on `PollOptionCard`), safe to gate on now; (b) **doc reduction** — gate
   *separately and only after* the §4.8 VNode-consolidation fix, and do not claim
   it for rendered collections until the oracle shows coalesced docs ≤ legacy on a
   rendered-element pattern. Also add the OQ-C4 invalidation gate (segment re-runs
   ⊆ legacy re-runs under input mutation).
3. **VNode consolidation** fix folded into the segment-output write.
4. **Per-segment CFC** parity on the oracle (per-segment join ⊇ legacy per-node;
   no under-label).
5. Validate on the trapped real shapes first — lunch-poll `PollOptionCard`, the
   default-app notes element — where all-or-nothing fell back.

The win to measure: on a pattern with `B` boundaries and `N` pure ops, legacy
materializes `~N + B` nodes; coalescing emits `~(B+1) segments + B boundary
nodes`, collapsing the `N` pure ops into a handful of segments while preserving
exactly the I/O nodes that must exist anyway.
