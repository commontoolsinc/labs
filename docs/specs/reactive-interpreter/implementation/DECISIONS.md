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
