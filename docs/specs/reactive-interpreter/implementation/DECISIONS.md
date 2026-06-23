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
