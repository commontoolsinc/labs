---
status: historical
created: 2026-07-01
archived: 2026-07-09
reason: "Scheduler-v2 A/B investigation record: the headline regression root-caused to demand-driven node multiplication."
---

# Addendum A1 — Headline regression and its root cause — node multiplication

> **Status**: Confirmed root cause
> **Context**: multi-user cfc-group-chat scheduler-v2 vs main slowness investigation (2026-06/07), informing PR #4288.
> **Companion**: [scheduler-v2 README](../../../../specs/scheduler-v2/README.md); sibling addenda in this folder.

## Finding

On the multi-user cfc-group-chat benchmark, scheduler-v2 (v2) is a **stable ~16% slower** than main. The proximate cause is that v2 commits **~2.2x as many discrete scheduler nodes** as main for the same workload. This traces directly to commit `1263d95e9` ("refactor(runner): delete dependency collection (scheduler-v2 4.2)"), which removed main's run-to-observe dependency-collection pass. Work that main performed **inline-and-discarded** during that pass, v2 performs as **discrete demanded-and-committed nodes**.

## Evidence

- **MEASURED (headline):** 7 alternating warm runs. v2 settle ~5630 vs main ~4854 on the harness "internal" metric; ranges non-overlapping; delta stable ~+16%. The alternating-run design refutes the earlier "magnitude is noise-prone" caveat (recorded in v2 as decision 17, commit `893037972` "headline ms is STABLE +16% (7 alternating runs)").
- **MEASURED (node count):** v2 commits ~2.2x the discrete scheduler nodes of main for the same workload.
- **main's mechanism (confirmed by reading):** `packages/runner/src/scheduler/dependency-collection.ts` — `resolveDependencyLog` / the `populateDependencies` path (~L80–L106) opens `depTx = state.runtime.edit()`, calls `populateDependencies(depTx)` to **observe** the computation's reads, extracts the log via `txToReactivityLog(depTx)`, then `depTx.abort()` (~L104). Nested per-row computeds are materialized **inline** during this observation pass: no commit, no counted scheduler run — the whole transaction is discarded by the abort.
- **v2's mechanism (confirmed by reading):** commit `1263d95e9` DELETED `packages/runner/src/scheduler/dependency-collection.ts` entirely (`git show --stat`: file removed, -110 lines; also strips `dependency-graph.ts`, `execution.ts` run-to-observe paths, and prunes `facade.ts`). On the v2 branch the file is **absent**. v2 instead uses declared reads plus pure demand: every nested computed is demanded, run in its **own** transaction, and committed to its **own** per-computation internal/result cell — the #3911 "one committed internal/result cell per computation" model.
- **Net:** main's inline-and-discarded intermediates become v2's demanded-and-committed discrete nodes → the observed ~2.2x.

## What it means

The multiplication is **not a bug**; it is the intended demand-driven design of scheduler-v2. main hid the cost of nested per-row computeds inside a throwaway observation transaction that never committed and never counted as a scheduler run. v2 makes every intermediate a first-class, committed node with a durable internal cell. That cost is **benign single-runtime** (see A2 — single-runtime v2 is flat-to-faster). It only becomes the +16% regression on this workload because each committed intermediate becomes a **cross-runtime push**: the extra commits fan out to other runtimes as sync work. The node multiplication is the mechanism; the multi-runtime amplification (A2) is what converts it into wall-clock regression.

## Status & open questions

- **Settled:** Root cause confirmed by code reading (`1263d95e9` diff + the deleted `dependency-collection.ts` on main) and by measurement (stable +16%, ~2.2x nodes).
- **Blocked/open:** Whether the extra re-derivations **flip-flop in VALUE** (i.e., whether the committed intermediates actually change, forcing genuine downstream work, versus re-committing identical values) remained blocked by instrumentation — see A3.

## Related

- [`02-multi-runtime-amplification-and-commit-cost.md`](02-multi-runtime-amplification-and-commit-cost.md) — why the benign single-runtime multiplication becomes a regression under cross-runtime commit/push cost.
- [`03-transaction-census.md`](03-transaction-census.md) — a census of the extra commits that the 2.2x produces.
- [`09-remediation-direction.md`](09-remediation-direction.md) — the direction taken to reduce the surplus.
