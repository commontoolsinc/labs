# Reactive Interpreter — Progress

Living status tracker. Update on every landed work order (see
[`00-README.md`](./00-README.md) "How to update tracking"). One line per change,
newest at the bottom of each section.

## Status

| Work order | Status | PR | Measured outcome |
| --- | --- | --- | --- |
| Spec + design (umbrella) | ✅ merged-pending | [#4298](https://github.com/commontoolsinc/labs/pull/4298) | requirements + design + plan; reviewed (5 blockers fixed); open questions resolved except OQ-4 |
| Spike: footprint win | ✅ done (throwaway) | #4298 | docs 3N→0, comp-nodes N→1, ~11× load, edit O(1); falsifier disproven |
| Spike: CFC oracle | ✅ done (throwaway) | #4298 | naive batch SMEARS (sound but coarse); OQ-4 sharpened |
| W0 — substrate & instrument | ✅ done | #4298 | harness + baseline (legacy law docSlope=3/nodeSlope=4 pinned); ROG type + Pattern→ROG extraction (representative map/control/leaf patterns 100% classify, nested recursion, object-results→constructs, no unrecognized aliases); seam re-verified = pure v2, gaps R-SEAM-1..4 identified |
| W1 — leaf/access/construct/control | 🟡 in progress | #4298 | W1a evaluator (6/6) ✅; W1b node-parity slice (hand-built ROG == legacy) ✅; W1b-bridge ✅ — a REAL extracted non-collection ROG (extract→internalToOp→leaf-resolve→evalRog) matches legacy output (sub-agent impl+review, coordinator-verified 5/11 green). Remaining W1b: serialized-$implRef/SES leaf invocation, label + materialization + scheduler-delta integration as the production path. |
| W2 — OQ-4 per-path content-label emit | 🟡 finding landed | #4298 | **Key result (D-OQ4-FINDING, coordinator-verified):** an inline container CANNOT carry pointwise `derived` labels (container write clears child derived entries) → pointwise REQUIRES per-element docs. Prototype (oracle isolated→pointwise + sibling-bug→caught, green, no CFC core changed) proves pointwise via per-element scheduled effects + 1 doc/element (drops child patterns: ~3× vs legacy, still O(N)). O(1)+pointwise needs a NEW trusted per-path emit (R-SEAM-3, unbuilt). |
| W3 — collections (Option A: per-element docs, pointwise) | 🟡 in progress | #4298 | Decision = A (D-W3-PRECISION). Generalize the W2 isolated-effect prototype to the element ROG via evalRog. Acceptance: oracle output-parity + pointwise-parity with legacy map, footprint ~1+N docs (vs legacy ~3N). |
| W4 — checkpoint tier | ⬜ not started | — | — |
| W5 — nested patterns + addressability | ⬜ not started | — | — |
| W6 — default-on & retire materialization | ⬜ not started | — | — |

Legend: ⬜ not started · 🟡 in progress · ✅ done · ⛔ blocked.

## Targets to beat (from the W0 bench; see ../05-baselines.md)

- Documents per non-scoped ROG instance: `O(1)` (was `~5 + 3N`).
- Computation nodes: `O(1)` (was `~8 + 4N`); read-index stays `O(distinct
  external reads)`.
- Edit: stays `O(1)` (preserve), path-scoped container patch.
- CFC (W3): per-index labels match legacy (conf ⊇, integrity ⊆); zero
  unauthorized narrowing; isolated-read lower bound holds.

## Log

- (seed) Spec + two spikes landed on #4298. Footprint win measured; CFC smear
  measured; OQ-4 is the one open soundness gap. Implementation work orders W0–W6
  defined in 00-README.
- (kickoff 2026-06-23) Decisions: **D-SEQ = OQ-4 precision parity first** (W2 =
  per-path label-emit, before W3 collections — no coarse interim) and **D-PR =
  #4298 umbrella** (stacked branches roll up, merge once). W2 (OQ-4) is the long
  pole; its acceptance test is the skipped oracle cases in
  `spike-cfc-oracle.test.ts`.
- (W0 done 2026-06-23) Landed: `test/support/interpreter-measure.ts` (harness),
  `test/reactive-interpreter/baseline.test.ts` (legacy law pinned),
  `src/reactive-interpreter/rog.ts` (IR type) + `extract.ts` (Pattern→ROG
  first-pass) + `test/reactive-interpreter/extract.test.ts` (coverage). Seam
  re-verified (D-SEAM): pure v2; net-new runtime gaps = R-SEAM-2 (trigger delta)
  and R-SEAM-3 (per-path label emit = W2). Next: W1.
