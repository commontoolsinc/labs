# Reactive Interpreter — Decision Log

Running log of design/implementation decisions and divergences. Append with a
date + the evidence. This replaces ad-hoc tracking in agent memory.

## Resolved (carried from the design phase)

- **D-R1 — Scoped cells.** No per-scope interior keying; an interpreter run is in
  one runtime scope context, interior is implicitly that scope's data. Carry the
  narrowest scope read through to each output's effective scope (R-SCOPE).
- **D-R2 — Write surface = top outputs.** Static ROG structure drives only the
  initial topo sort; thereafter actual reads. Materialize the egress-reachable
  top outputs; over-approximation/tier-3 envelope deferred to imperative
  side-writes.
- **D-R3 — Identity by causal carry-through.** Materialize the egress-reachable
  closure; retained deep links resolve via ids causal to inputs, threaded
  through. (The reload id-churn class is fixed; not a live concern.)
- **D-R5 — Interior non-convergence: scheduler API.** `tx.markSelfInvalid()` /
  `fn` "not-done" signal so pass-level backoff applies (Delta E), not a private
  in-`fn` loop.
- **D-R6 — Interpreter is in the TCB.** Per-interpreter trust; no per-ROG-hash.
  Soundness rests on interpreter correctness (the formal obligations), and trusting
  it does not require trusting the ROG.

## D-OQ4-FINDING — pointwise and O(1) footprint are incompatible without new CFC machinery (W2, 2026-06-23)

The W2 implement+review workflow (coordinator-verified green: oracle batch SMEAR
/ isolated POINTWISE `[alice]`,`[bob]`,`[]`,`[]` / sibling-bug CAUGHT; cfc-flow
suite green; **no CFC core changed**) established the decisive result:

- **A single inline-value container CANNOT carry pointwise `derived` (content)
  labels.** A container `[]`/array write prefixes and **clears every child slot's
  `derived` entry** under it, so the per-element content label cannot survive on
  the container. (Demonstrated; rooted in how `prepare.ts` stamps `derived`.)
- **Pointwise therefore requires a per-element result DOCUMENT** (each element's
  label lives on its own doc, which a container re-write never clears) — i.e.
  per-element transaction decomposition, exactly how legacy `map` gets pointwise.
- The interpreter's structural win that REMAINS available with pointwise: drop
  per-element child **patterns** (legacy `3 docs + 4 nodes`/element) for a
  per-element **scheduled effect + 1 result doc**/element. That is a ~3× doc
  reduction and a node reduction, but still **O(N) docs**, NOT the O(1)
  inline-container dream.
- **So the O(1) footprint win and pointwise CFC precision are in fundamental
  tension under current CFC machinery.** Having BOTH requires building a new
  trusted **per-path content-label emit that survives container writes**
  (R-SEAM-3) — which was *not* built (no CFC core changed) and is real CFC-core
  work.

This reframes the collection (W3) decision into three options — **a user
decision (D-W3-PRECISION, below)**:
- **A (buildable now): pointwise via per-element docs** — `~1 doc + 1 effect`/
  element (vs legacy `3 docs + 4 nodes`); sound, pointwise, ~3× win, still O(N).
- **B (the O(1) dream): build the new per-path content-label emit** — O(1)
  inline container + pointwise; needs new CFC-core machinery, more work + review.
- **C: inline container + coarse (smeared) labels** — O(1) docs but a precision
  regression vs legacy (rejected earlier in D-SEQ as precision-first).

## D-W3-PRECISION — RESOLVED = A (user, 2026-06-23)

Decision: **Option A — pointwise via per-element docs, built now.** Collections
drop per-element child PATTERNS but keep one result doc + one scheduled effect
per element (read-isolated → structurally pointwise), container holds links. ~3×
fewer docs + fewer nodes than legacy (`~1+N` vs `~3N` docs), still O(N), sound,
pointwise, no CFC-core risk. **Option B** (the new per-path emit for O(1)+pointwise)
is a deferred follow-on if the O(1) footprint becomes worth the CFC-core cost.
This supersedes D-SEQ's assumption that OQ-4 delivers O(1)+pointwise together.

W3 mechanism = generalize the W2 prototype's "isolated" mode (per-element
scheduled effect, own tx reading only element i, own result doc, no child
pattern) from a hardcoded leaf to the element **ROG** evaluated via `evalRog`
(reusing W1b-bridge leaf resolution). Acceptance: differential oracle — output
parity with legacy `map` AND pointwise label parity, with the footprint measured
(`~1+N` docs vs legacy `~3N`).

## Open / load-bearing

- **D-OQ4 — Per-path content-label emit (the one open soundness gap).** The CFC
  oracle spike confirmed (code-level): a single batched-tx coordinator can only
  produce one `derived` (content) label per tx, stamped on all writes (smear);
  carried label-views are link-only; the `structure` (membership) channel is the
  only per-path channel today. So pointwise content labels need a **new trusted
  per-path content-label emit** for a batched node (extend §8.9.1 to write per-path
  `derived` labels from isolated per-element reads), or per-element label-isolated
  sub-transactions. This is W3. Status: design open; the oracle's read-isolated +
  sibling-bug cases are the executable acceptance test.

## D-PROD-PATH — shortest path to the production seam + what "run the full suite" means (recon, 2026-06-23)

User directive: "shortest path to production-path so we can run the full suite,
then close gaps to get it green." Recon (`wr3vqtz8m`, 2 parallel readers +
synthesis, cited to landed code) established:

- **Honest framing.** With the interpreter feature-complete only for a subset
  (leaf/access/construct/control + Option-A `map`), the ONLY short path to a
  green full suite is **interpreter-on-the-prod-path WITH legacy fallback behind
  a default-off flag**: the suite stays green because anything unsupported falls
  back to legacy. "Green via fallback" = no regression; "green with zero
  fallback" = the multi-milestone endpoint. The real progress metric is the
  **fallback rate**, not a binary green.
- **Wiring seam = `instantiatePattern`** in `RecipeManager.startCore`
  (`packages/runner/src/runner.ts:1173-1212`) — the single choke point all three
  start paths funnel through. Fallback is a try/catch on `NotInterpretedHere` →
  the byte-for-byte unchanged legacy `for (const node of pattern.nodes)` loop.
  Materialize into the `$result` derived-internal cell (`runner.ts:1099-1115`).
- **Flag = `experimentalInterpreter`** added to `ExperimentalOptions`
  (`runtime.ts:160-167`, propagated `:329-333`), mirroring the
  `cfcEnforcementMode` precedent (`:190`/`:406`). **Default OFF.**
- **HARD INVARIANT (no leak): pure extract + `evalRog` probe BEFORE any tx
  write.** Never partially materialize then fall back. The pure evaluator
  (`interpret.ts:5-10`) is decoupled from the runtime, so the dry probe is cheap.
- **Census via instrumentation (better than a synthetic corpus).** Instrument
  `runViaInterpreter` to count `{interpreted_ok, fallback_by_reason}`; then a
  **flag-on full runner-suite run becomes the real corpus census** across 316
  test files of actual patterns. (The synthetic corpus-gap-map agent delivered
  formatting-only — no real tally — so this replaces it.)
- **Runnable suite reality.** Runner unit suite (316 files) is feasible headless:
  `cd packages/runner && deno task test`. `scheduler-events.test.ts` type-checks
  clean on this branch (the old `Timeout` `--no-check` gotcha does NOT reproduce
  here). Full cross-package = feasible but long. **Integration/browser tier needs
  the local dev stack → out of this environment** (beware the stale `:8000`
  toolshed version-skew gotcha). So "run the full suite" here = runner unit suite
  green flag-off (== baseline) + flag-on census; cross-package when time allows;
  browser/integration deferred to the dev stack.
- **Staged gap-closing order** (raise interpreter coverage, each behind the same
  flag + fallback, zero default-path risk): (1) `collection` beyond Option-A map
  (`filter`/`flatMap`), (2) nested `pattern` instantiation (W5), (3)
  `effect`/serialized-`$implRef` SES leaf invocation (W1b production leaf path).
  R-SEAM-2 (per-trigger delta) and R-SEAM-3 (per-path label emit / OQ-4) ride
  along with whichever gap first needs correct incremental reactive re-eval.

Step 1 (flagged dispatch for the non-collection subset + instrumentation +
differential/reactivity/fallback test) is delegated as workflow `wjvg8vak9`
(impl + perspective-diverse safety/correctness review); coordinator gates on the
full flag-off suite (== baseline) + the flag-on census run + a runner.ts diff
audit before committing.

## D-COALESCE — interpreter = pure-region coalescing pass; all-or-nothing eligibility superseded (2026-06-24)

**Decision (user-directed):** the all-or-nothing eligibility model is a
fundamental flaw — I/O builtins (`fetch*`/`llm`/`generate*`/`sqlite*`/`wish`) and
handlers are ubiquitous, so "contains any ineligible op → fall back the whole
pattern" makes the interpreter help almost nothing real (measured: lunch-poll
~18% of instances, ~4% of nodes). Redesign: the interpreter becomes a **pure-region
coalescing pass** — replace each maximal pure subgraph with one interpreter
**segment** node, and **preserve every I/O/effect/handler node as a boundary**
(real scheduler node + real I/O docs, which they need anyway). Eligibility flips
from "is the whole pattern pure?" to "can it be partitioned?" (≈ always yes). Full
design: [../07-coalescing-architecture.md](../07-coalescing-architecture.md).

- **Option 2 (split into segment nodes) chosen over Option 1 (one node + give the
  scheduler the topo order).** Option 1 is unschedulable as stated — one node
  spanning computation on both sides of a builtin forms a 2-cycle with it
  (`interp ⇄ fetch`); "stage the node from the interpreter's topo sort" *is*
  splitting, and additionally needs a scheduler change + a re-entrant node +
  re-implementing per-node invalidation/CFC/materialization inside the
  interpreter. Option 2 is a clean DAG the existing scheduler runs **unchanged**,
  with precise per-segment/per-boundary re-execution.
- **Handlers need NO execution support** — a handler is a boundary node (already
  real in legacy); coalescing un-traps the pure nodes beside it. This dissolves
  the "event-driven handler execution" lift and matches the node-breakdown
  (handlers = 0 durable nodes; their only cost was trapping pure nodes).
- **CFC gets finer** (per-segment flow join, not a whole-pattern smear) — a
  precision gain. The VNODE-DOC-FRAGMENTATION fix folds into the segment-output
  write.
- The landed work is the **K-segment special cases**: pure non-collection = one
  segment; pure `map`/nested = pure ops within a segment. Migration replaces the
  all-or-nothing gate with the partitioner + multi-node emission; keeps `evalRog`
  + the collection mechanism + the legacy `instantiateNode` path for boundaries.
- Status: design landed + independently adversarially reviewed → **GO-WITH-FIXES**
  (07-*.md §8). Reframe sound; corrections folded in. **F1 (blocker): the ROG
  drops boundary input edges** (`extract.ts` gives inputs only to leaf ops), so
  the partition has nothing to cut on for I/O boundaries AND the first prototype
  over-counted coalescing — numbers being re-baselined with boundary edges. **F2:
  "no scheduler change" corrected** — a segment feeding >1 boundary needs
  R-SEAM-1 fan-out (or a container-of-links). **F3: CFC** — legacy is per-node
  (segments ≈ legacy, not finer); + a real boundary→boundary under-label hazard
  → labeled read-through invariant. **F4 (open):** handler write-back can form
  `S→handler→S`; the partition must cut on boundary write-back edges too. F5 (§5
  honest re multi-segment machinery), F6 (cause-naming), F7 (R-SEAM-3 dep). The
  highest-risk pre-implementation item is F1.

## D-VNODE-DOC-FRAGMENTATION — the collection doc-win is element-RESULT-SHAPE-dependent (bench finding, 2026-06-24)

The default-app notes bench measured the interpreter ADDING docs on a `map` whose
element renders a VNode (+~50%/element), contradicting the W3 controlled test
(legacy `mapWithPattern` 3 docs/el → interp 1, a win). A skeptical reconciliation
(clean-room in-process `attachDocRecorder`, the SAME method as W3 — it reproduces
3→1 for a scalar element AND measures 4→6 for the VNode element, so NOT a
commit-tap counting artifact) established the cause and the corrected thesis:

- **Per-element doc accounting (N=1):**
  - Legacy = **4 docs/el**: 1 child-pattern argument doc + 2 lift-output docs +
    **1 *consolidated* VNode result doc** (the whole `<tr>` subtree in one doc).
  - Interp = **6 docs/el**: **6 *fragmented* VNode docs** (tr/td/vstack/3×span,
    each its own linked doc), 0 arg doc, 0 lift docs (inlined).
- The interpreter genuinely saves the child-pattern arg doc + inlines the lift
  outputs, **but `$ri-collection-map` writes the element-result VNode tree as one
  doc per nested VNode node**, whereas legacy's child-pattern render emits the
  subtree as one consolidated document. The 1→6 fragmentation more than offsets
  the savings → net **+2 docs/element**.
- **Corrected thesis:** the "~1+N vs ~3N docs" win holds for **scalar/object**
  element results (W3) but **INVERTS for VNode/render element results** — which is
  the common real-UI `.map`. **Scheduler nodes still drop ~20%** (dropping the
  child pattern), so docs and nodes diverge: a node win paid for with VNode-doc
  fragmentation.
- **Fix direction (open):** the interpreter's per-element result write should
  consolidate a VNode subtree into one doc like legacy (don't split per VNode
  node). Until then, the collection footprint win is real on value-result maps,
  not on rendered-element maps. (This also strengthens the case for re-measuring /
  Option B before any default-on for rendered collections.)
- Supersedes the notes-bench commit's "inline-value vs cell-link element"
  explanation, which was wrong (the real variable is element RESULT shape:
  scalar vs VNode-tree, not element provenance).

## D-SEAM — scheduler/runtime seam, re-verified against landed code (W0.5, 2026-06-23)

From the `reverify-scheduler-seam` workflow (4 parallel readers + synthesis,
cited to landed `packages/runner/src`):

- **Scheduler reality: pure v2 (pull-based) — the only scheduler in the tree.**
  No v1/v2 hedge; the interpreter builds on v2 as-is.
- **The interpreter builtin node CAN, today:** hold persistent closure state
  across runs (like `map.ts`'s `elementRuns`); do per-element reads whose
  read-set is address-granular, with whole-node re-run on a single element
  change; mint cells deterministically; output a container-of-links (one doc);
  spawn + tear down child work (`addCancel`); register async sub-work via
  `settled()` / `trackAsyncWork`.
- **It CANNOT, today (net-new runtime work):**
  - **R-SEAM-1** native multi-value fan-out through `sendResult` — one node emits
    one output value (a container-of-links is fine; N separate output docs is
    not). *Mitigation: the inline-container approach (the spike) sidesteps this —
    no multi-doc fan-out needed for the win.*
  - **R-SEAM-2** a **per-trigger delta** — a run cannot see *which* address
    invalidated it (only that it was → whole-node re-run). Incremental per-element
    recompute (W1/W3) must re-derive what changed from its inputs, or this delta
    surface is added.
  - **R-SEAM-3** a **write-side per-path CFC label primitive** — labeling is
    schema-`ifc`-driven; there is **no imperative ambient-meta channel** for a
    node to stamp a per-path `derived` content label. **This is the W2/OQ-4 gap,
    independently confirmed: the biggest net-new piece.**
  - **R-SEAM-4** read-side flow scoping for genuine value reads (needed for
    R-CFC-ISO read isolation).
- **Divergences (now reconciled in the work orders):** D1 static write surface
  (matches P4); D2 legacy `map` is per-element fan-out, not one-node-broad-write;
  D3 no CFC exemption for reading element content; D4 = R-SEAM-2; D5 no
  auto-pruning of node state (R-MAT-5 must be implemented, not assumed).

Net: the win is reachable with existing seam capabilities (inline container +
persistent state + per-element reads); the genuine runtime additions are
R-SEAM-2 (incremental delta) and R-SEAM-3 (per-path label emit = W2). Full
report: workflow `wmbkm0782`.

## Resolved (kickoff, 2026-06-23)

- **D-SEQ — OQ-4 precision parity FIRST (decided).** The interpreter must not
  regress CFC precision vs legacy, so the trusted per-path content-label emit
  (OQ-4) is built **before** the collection interpreter — collections land
  pointwise from day one, never with an interim coarse-label phase. This moves
  the per-path label-emit ahead of collections in the work-order sequence (it
  becomes W2; collections becomes W3, depending on it). Implication: the footprint
  win is gated on solving OQ-4 first; no coarse-but-sound interim ships.
- **D-PR — #4298 stays the umbrella (decided).** Implementation lands as branches
  **stacked onto #4298**, merged once as a unit (not a merge-the-spec-then-
  separate-PRs split). Each stacked branch still updates `PROGRESS.md`. The PR
  grows large; that is accepted in exchange for one coherent landing.
