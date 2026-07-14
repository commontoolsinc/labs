---
status: historical
created: 2026-07-01
archived: 2026-07-09
reason: "Scheduler-v2 A/B investigation record: multi-runtime commit/push amplification and per-commit cost."
---

# Addendum A2 — Multi-runtime amplification and per-commit cost

> **Status**: Confirmed mechanism
> **Context**: multi-user cfc-group-chat scheduler-v2 vs main slowness investigation (2026-06/07), informing PR #4288.
> **Companion**: [scheduler-v2 README](../../../../specs/scheduler-v2/README.md); sibling addenda in this folder.

## Finding

The ~16% scheduler-v2 regression on cfc-group-chat is a *multi-runtime* phenomenon, not an intrinsic cost of v2's extra nodes/commits. Single-runtime, v2 is essentially at parity with main despite committing more intermediate cells. The regression only appears under multi-runtime, where every committed intermediate is a cross-runtime push that the peer pulls, re-processes, and itself re-derives+commits — inflating *both* runtimes' commit counts ~2.2x. Multiplied by a high per-commit CPU cost (CFC label prep under enforce-explicit), that amplification is the +16%.

## Evidence

- **Single-runtime control (decisive)**: the +12-16% *vanishes* when the benchmark runs single-runtime — v2 ≈ main — even though v2 still emits more nodes and commits in that configuration. The extra nodes are therefore not intrinsically expensive; the cross-runtime amplification is what costs.
- **Amplification**: each of v2's committed internal cells syncs cross-runtime; the peer pulls it, re-processes, and re-derives+commits the same shared cell, duplicating the work on both sides. The transaction census (A3) counted 18 cells written by *both* runtimes.
- **Per-commit cost (measured)**: ~2.78 ms/commit on v2 vs ~0.74 ms on main. The extra cost is CFC-label work — `prepareCfc` plus canonicalization over VNode subtrees — performed under enforce-explicit. See `packages/runner/src/runtime.ts`, `Runtime.prepareTxForCommit` (~L806-834), which computes flow-label / sink-ceiling relevance and calls `tx.prepareCfc()` when the tx is relevant and unprepared.
- **Commits are fire-and-forget** (this *corrects* an earlier, wrong "blocking on sync round-trips" framing): in `packages/runner/src/scheduler/run.ts`, `startReactiveActionCommit` (~L88-100) closes the `scheduler/run/commit` timer (~L98) *before* returning the `commitPromise`, and never awaits it. `watchReactiveActionCommit` (~L102-178) only attaches a `.then` to the commit promise, and awaits a `readyToRetry` promise *solely on the reject path* (retry gate). The scheduler never blocks on the commit ack. The cost is therefore CPU-per-commit (`prepareCfc`/canonicalize) × the amplified commit count — not latency spent waiting on round-trips.

## What it means

The lever is not "make commit acks faster" — commits do not block the scheduler. The lever is "commit fewer redundant cross-runtime intermediates." Reducing the number of committed internal cells (dedup / coalesce, A9) directly shrinks both the amplified commit count and the aggregate `prepareCfc` bill. Cross-runtime adoption (A6) attacks the same duplication from the other side: if a peer adopts an already-derived shared cell instead of re-deriving and re-committing it, the ~2.2x inflation collapses.

## Status & open questions

Mechanism confirmed by the single-runtime control experiment plus per-commit profiling; the fire-and-forget commit path is confirmed by reading `run.ts` on v2. Open: which specific intermediates are the profitable dedup/coalesce targets (A9), and whether cross-runtime adoption (A6) is reachable without weakening CFC provenance guarantees.

## Related

- `01-headline-and-node-multiplication.md` — the headline +16% and where v2's extra nodes/commits come from.
- `03-transaction-census.md` — the 18-cells-written-by-both-runtimes census underpinning the amplification claim.
- `06-cross-runtime-adoption-what-would-be-needed.md` — adoption as the direct attack on the duplication.
- `09-remediation-direction.md` — synthesizes dedup/coalesce (A9) vs adoption (A6) as the chosen levers.
