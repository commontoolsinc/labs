# Scheduler v2 — Performance Investigation Addenda

On the multi-user cfc-group-chat benchmark, scheduler-v2 is a stable ~16% slower
than main. This folder records the findings from the 2026-06/07 investigation
informing PR #4288: the root cause (demand-driven node multiplication that
becomes cross-runtime commit/push amplification), a transaction census pinning
the redundancy to shared, space-scoped derivations re-run independently by each
runtime, the cheap fixes and coalescing levers that were refuted or measured
neutral, what genuine cross-runtime adoption would require, and the tractable
remediation direction (coalesce/dedup rather than version-skip).

## Addenda

| Addendum | Status | One-line finding |
| --- | --- | --- |
| [A1](01-headline-and-node-multiplication.md) | Confirmed root cause | Stable ~16% regression traces to commit `1263d95e9` deleting main's run-to-observe dependency-collection pass, so v2 commits ~2.2x the discrete scheduler nodes for the same workload. |
| [A2](02-multi-runtime-amplification-and-commit-cost.md) | Confirmed mechanism | The multiplication is benign single-runtime; it becomes the +16% only under multi-runtime, where each committed intermediate is a cross-runtime push carrying a high per-commit CPU cost (~2.78 ms vs ~0.74 ms), and commits are fire-and-forget. |
| [A3](03-transaction-census.md) | Confirmed mechanism + value-level measured | A 157-commit census found 31 multi-write cells, 18 written by both runtimes (shared, space-scoped, cross-runtime-duplicated). A follow-up non-perturbing digest measurement: 60% of result-writes repeat a value the same runtime already produced and 63% of distinct values are computed by both runtimes — a legitimate value progression computed redundantly, not same-value churn; the one true flip-flop is the apex render. |
| [A4](04-refuted-free-fixes.md) | Refuted hypothesis | Neither the declared read-sets (faithful, not over/under-specified) nor asCell read-depth (already shallow for the relevant modes) is over-reading; there is no schema-level knob that reclaims the +16%. |
| [A5](05-serialized-scheduler-state-is-reload-only.md) | Refuted hypothesis | The serialized/persistent scheduler state is a reload-only, address-only, dirtiness-propagating rehydration record (default-OFF, not in the benchmark) — it cannot skip a re-derivation by adopting a peer's result. |
| [A6](06-cross-runtime-adoption-what-would-be-needed.md) | Design proposal (not implemented) | Cross-runtime adoption would remove the redundancy at its source but requires three new capabilities — per-read basis stamp, a settle-time adopt gate, and a trust/provenance CFC design (the hard part). |
| [A7](07-pull-side-gate-no-go.md) | Structural NO-GO | A pull-side read-set gate cannot fire where the redundancy is: ~half the hot apex's re-runs have no scheduler-registered upstream writer (driven by direct sync-apply cell writes); prototype was neutral (Stage 1) then regressed (Stage 2). |
| [A8](08-effect-defer-neutral.md) | Measured neutral | Deferring effects to once-per-wave was measured ~neutral; the redundant work lives in the shared-cell derivations upstream of effects, not in the effect layer. Flagged off, likely-delete. |
| [A9](09-remediation-direction.md) | Synthesis / recommendation | The tractable lever is to coalesce/dedup the redundant cross-runtime re-derivations (closure-memo, value-aware-bound, refcount-prune) — not version-skip (A5), not a pull-side gate (A7), not effect-defer alone (A8); cross-runtime adoption (A6) is the ambitious lever gated on a CFC/provenance model. |

## Reading order

Root cause (A1) -> why it's a regression (A2) -> census (A3) -> refuted cheap
fixes (A4, A5) -> what real adoption needs (A6) -> tried-and-rejected levers
(A7, A8) -> remediation (A9).
