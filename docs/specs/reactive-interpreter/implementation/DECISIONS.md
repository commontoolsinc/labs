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

## Proposed — confirm before W0

- **D-SEQ — Footprint-win-first (coarse-but-sound), OQ-4 as the precision gate.**
  Proposed: land W1→W2 (the footprint win) with sound *coarse* labels first
  (smearing over-taints — the safe direction), and treat W3 (OQ-4 per-path
  precision) as the gate before flipping default-on in CFC-*enforcing* spaces.
  Rationale: coarse is sound; CFC enforce-explicit is still rolling out, so a
  precision regression is not yet user-visible by default; shipping the win early
  de-risks the big change. Alternative: OQ-4 first (precision parity before any
  cutover) if CFC enforcement is already load-bearing in target deployments.
  **CONFIRM.**
- **D-PR — PR structure.** Proposed: merge #4298 (spec + tracker + throwaway
  spikes) as the design baseline, then land W0–W6 as **stacked implementation
  PRs**, one per work order, each updating `PROGRESS.md` (the scheduler-v2
  pattern). Alternative: keep #4298 as a long-lived umbrella PR and stack onto it.
  **CONFIRM.**
