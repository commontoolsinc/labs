# Addendum A3 — Transaction census — what the extra commits actually are

> **Status**: Confirmed mechanism + value-level characterized (non-perturbing digest measurement, 2026-07-01)
> **Context**: multi-user cfc-group-chat scheduler-v2 vs main slowness investigation (2026-06/07), informing PR #4288.
> **Companion**: [scheduler-v2 README](../README.md); sibling addenda in this folder.

## Finding

The extra commits scheduler-v2 pays on multi-user cfc-group-chat are **per-SPACE shared cells re-derived by both runtimes** — cross-runtime duplication of a shared derivation — not per-user or per-session view fan-out. A census of 157 commit records from one two-user run found 31 distinct cells written multiple times (2–6×), 18 of which were written by **both** runtimes (the same cell address produced independently by Alice's runtime and Bob's runtime). A follow-up **non-perturbing digest measurement** (2026-07-01) then answered the value-level question: the duplicate re-derivations are **neither pure same-value redundancy nor oscillation — they are a legitimate value *progression* (driven by the message-add events) that is *computed redundantly* two ways at once**: each value is produced ~2× in a row within a runtime (60% of result-writes are repeats) *and* the same value is computed independently by both runtimes (63% of distinct values). The one genuine oscillation is localised to the apex whole-state render, which flip-flops through superseded intermediate states as cross-runtime notifications arrive. All measured re-derivations are **space-scoped** — none user or session.

## Evidence

- **Instrumentation**: a temporary commit hook (`tx-instrument.ts`, since **reverted** — not in-tree) recorded 157 transaction records during one multi-user group-chat run.
- **Multi-write cells**: 31 cells written 2–6×; **18 of them written by both runtimes** — the same cell address committed by Alice's and Bob's runtime independently.
- **Scope breakdown**: space-scoped 101 / user-scoped 51 / session-scoped 5. The multi-writes concentrate in **space** (shared) scope — consistent with cross-runtime duplication, inconsistent with per-user divergence.
- **Trigger breakdown**: demand 143 / remote-sync-apply 14. (Most writes are locally demanded recomputation, not applying a peer's synced result.)
- **Sites**: `raw:map` 41, test-harness module (`1CEYG7`) 28, `ifElse` 8, plus per-row computeds. Per-row computeds show the same shared cell attributed to both runtimes, e.g. `alice:1, bob:2` — both runtimes producing the same derivation.
- **BLOCKED — value-level flip-flop**: reading the written value at commit via `readOrThrow` re-invalidated the prepared CFC digest. `readOrThrow` (packages/runner/src/storage/extended-storage-transaction.ts:`readOrThrow` ~L687) calls `invalidateCfc("read-after-prepare")` when `cfcState.prepare.status === "prepared"` (same guard at ~L681). Materializing the value also forced VNode subtree materialization; the instrumentation hung / timed out.
- **Clean path (now done — the non-perturbing digest measurement)**: rather than reading committed values back (which perturbs CFC), tap the value **where it is already in hand** — at `Runner.writeJavaScriptActionResult` (packages/runner/src/runner.ts ~L2859), whose `outputs: FabricValue` argument *is* the computed result. A temporary hook (env-gated, since reverted) recorded, per result-write, a content digest of `outputs` (a self-contained FNV-1a hash of its serialization — no `hashStringOf`/CFC traversal), tagged by participant via the Web Worker's `self.name` (`cf-test:alice` / `cf-test:bob`). The test passed 12/12 at 5661 ms (in-band with the +16%).
- **Digest measurement result** (one two-user run, 196 result-writes = 104 Alice + 92 Bob, **all space-scoped**):
  - **60% redundant**: 78 of 196 writes produced a value never-before-seen for that cell in that runtime; **118 (60%) repeated a value the same cell+runtime had already produced.**
  - **63% cross-runtime duplicated**: of 48 distinct `(cell, value)` pairs, **30 were produced by *both* runtimes** (byte-identical digest) — each computed twice, once per runtime; only 18 were single-runtime.
  - **Per-stream shape**: 16 streams are *progression + consecutive-duplicate* (each new state computed ~2× in a row), 3 are *oscillation*, 2 are *all-same*.
  - **Apex oscillation, directly observed**: the whole-state render (`main.tsx:309`) runs a clean 7-step progression (each value doubled) then **flip-flops between two digests `908f7b ⇄ 3b27a3` for ~4 cycles** — re-rendering superseded intermediate states as cross-runtime notifications land (matches the diamond-apex re-render mechanism in the [README](../README.md) decision-17).
  - **Per-row CFC label** (`trusted.tsx:955`): clean progression, each of 7 values computed **exactly twice consecutively** — legitimate new states, double-computed.

## What it means

This pins the +16% redundancy to **cross-runtime duplication of shared derivations**, not per-user view fan-out. Every runtime in the session re-derives the same space-scoped cells from the same synced inputs and re-commits them — 18 confirmed collision addresses in a single 157-commit window. That is precisely the work that cross-runtime **adoption** (A6) would eliminate (adopt a peer's already-committed derivation instead of recomputing) or that **coalescing** (A9) would fold. It rules out remediations aimed at per-user isolation, which would touch the wrong 51 user-scoped commits and leave the shared duplication intact.

## Status & open questions

- **Settled — structure**: shared, space-scoped, cross-runtime-duplicated, demand-driven.
- **Settled — value level** (was blocked, now measured): the duplicate re-derivations are a **legitimate value progression, computed redundantly**, not same-value churn and not (mostly) oscillation. Two compounding redundancies: within-runtime **double-compute** (~2× consecutive, 60% of writes) and cross-runtime **duplication** (63% of distinct values computed by both runtimes). So the "different results that require transactions" are genuinely different *because shared state advances* — the waste is that each shared value is materialised ~4× (2 runtimes × ~2 consecutive) where main folds it inline ~once. The one true flip-flop is the **apex render**, which re-renders through superseded intermediate states.
- **Implication for remediation**: because the values are a real progression (not stale churn), a naive same-value gate reclaims little; the leverage is (a) **cross-runtime adoption** of the 63% both-runtimes-duplicated values (A6), (b) **coalescing** the within-runtime double-compute and the apex oscillation (A9). The apex oscillation is the only strictly-wasteful component (it renders states that are immediately superseded).
- **Residual caveat**: single run, two users; the digest is FNV-1a over `JSON.stringify(outputs)` (stable within a run for equal values, adequate for identity but not a cryptographic guarantee). Re-run for N>2 users would show whether the cross-runtime-duplication fraction scales with participant count (expected: yes).

## Related

- [02-multi-runtime-amplification-and-commit-cost.md](./02-multi-runtime-amplification-and-commit-cost.md) — quantifies the per-commit cost this census enumerates.
- [06-cross-runtime-adoption-what-would-be-needed.md](./06-cross-runtime-adoption-what-would-be-needed.md) — the remediation that would remove the 18 confirmed cross-runtime duplicate derivations.
- [09-remediation-direction.md](./09-remediation-direction.md) — synthesis that weighs adoption vs coalescing against this evidence.
