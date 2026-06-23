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
| W0 — substrate & instrument | ⬜ not started | — | — |
| W1 — leaf/access/construct/control | ⬜ not started | — | — |
| W2 — OQ-4 per-path content-label emit (precision mechanism, long pole) | ⬜ not started | — | — |
| W3 — collections (the win, pointwise) | ⬜ not started | — | — |
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
