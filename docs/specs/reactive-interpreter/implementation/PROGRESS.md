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
| W3 — collections (Option A: per-element docs, pointwise) | ✅ done | #4298 | element-evaluator.ts (per element → evalRog over element ROG, no child pattern) + mapInterpreted prototype. Coordinator-verified: suite 7/16 green; **footprint legacy slope 3 docs/el → interpreter 1/el (2.6× fewer @N=20)**; output parity (deep-eq, N=5/20); pointwise labels match legacy element-for-element. Honest: O(N) per-element docs (Option A), not O(1) (= Option B, deferred). Remaining: filter/flatMap (only map prototyped), serialized-$implRef element graphs (resolver hook added, SES wiring pending). |
| PROD-WIRE — flagged dispatch into instantiatePattern (non-collection subset) | ✅ landed (default-off) | #4298 (`beee3b200`) | `experimentalInterpreter` flag (default OFF) + pure-probe-then-fallback dispatch at instantiatePattern; census counters. Coordinator-gated: full flag-off suite **658 passed / 0 failed** (legacy path byte-unchanged), reactive-interpreter slice **670/0** incl. prod-wire differential/reactivity/fallback. Structured leaf inputs now LOSSLESS-OR-FAIL-CLOSED (multi-input `add({a,b})` → keyed construct); fail-closed contract holds universally (malformed/$alias-mixed/non-zero-`defer`/malformed-output all recorded → fallback; aligned to `isLegacyAlias`; `scope` stays eligible). Two adversarial review rounds caught + fixed a silent-wrong-result admission bug before landing. |
| CORPUS gap-map (measurement) | ✅ landed | #4298 (`4a44dae48`) | Static MATCH/DIVERGE/UNHANDLED table over a representative corpus. First run **matched=7, diverged=5, unhandled=3**. **Ranked gap backlog:** (1) **`unless`/`when` control-semantics bug** — DIVERGE, eligible-vocab silent-wrong (extraction reads ifTrue/ifFalse but builtins use `{condition,value}`/`{condition,fallback}` with else-returns-condition semantics) → FIX NEXT; (2) collections map/filter/flatMap — W3 mechanism not wired into dispatch (falls back); (3) nested pattern (W5); (4) handler/effect; (5) UI vnode. |
| FIX control semantics (when/unless/ifElse both branches) | 🟡 in progress | #4298 | Align extraction + interpret with the real builtins; red-green via the prod-wire differential oracle (both branches). Delegated. |
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
