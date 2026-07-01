# Addendum A3 — Transaction census — what the extra commits actually are

> **Status**: Confirmed mechanism (value-level flip-flop question: blocked/open)
> **Context**: multi-user cfc-group-chat scheduler-v2 vs main slowness investigation (2026-06/07), informing PR #4288.
> **Companion**: [scheduler-v2 README](../README.md); sibling addenda in this folder.

## Finding

The extra commits scheduler-v2 pays on multi-user cfc-group-chat are **per-SPACE shared cells re-derived by both runtimes** — cross-runtime duplication of a shared derivation — not per-user or per-session view fan-out. A census of 157 commit records from one two-user run found 31 distinct cells written multiple times (2–6×), 18 of which were written by **both** runtimes (the same cell address produced independently by Alice's runtime and Bob's runtime). The redundancy is structural and concentrated in space scope; the value-level question (are the duplicate writes same-value, progression, or oscillation?) is confirmed *unanswered* — the instrumentation that would have read the values perturbed the CFC prepare and hung.

## Evidence

- **Instrumentation**: a temporary commit hook (`tx-instrument.ts`, since **reverted** — not in-tree) recorded 157 transaction records during one multi-user group-chat run.
- **Multi-write cells**: 31 cells written 2–6×; **18 of them written by both runtimes** — the same cell address committed by Alice's and Bob's runtime independently.
- **Scope breakdown**: space-scoped 101 / user-scoped 51 / session-scoped 5. The multi-writes concentrate in **space** (shared) scope — consistent with cross-runtime duplication, inconsistent with per-user divergence.
- **Trigger breakdown**: demand 143 / remote-sync-apply 14. (Most writes are locally demanded recomputation, not applying a peer's synced result.)
- **Sites**: `raw:map` 41, test-harness module (`1CEYG7`) 28, `ifElse` 8, plus per-row computeds. Per-row computeds show the same shared cell attributed to both runtimes, e.g. `alice:1, bob:2` — both runtimes producing the same derivation.
- **BLOCKED — value-level flip-flop**: reading the written value at commit via `readOrThrow` re-invalidated the prepared CFC digest. `readOrThrow` (packages/runner/src/storage/extended-storage-transaction.ts:`readOrThrow` ~L687) calls `invalidateCfc("read-after-prepare")` when `cfcState.prepare.status === "prepared"` (same guard at ~L681). Materializing the value also forced VNode subtree materialization; the instrumentation hung / timed out.
- **Clean path (not yet done)**: capture the content digest the commit **already** computes — `preparedDigestFor(preparedInput)` (packages/runner/src/storage/extended-storage-transaction.ts:`prepare`/`commit` ~L550, re-checked at ~L989 against `cfcState.prepare.digest`) — instead of a perturbing `readOrThrow`. Comparing that already-computed digest across the duplicate writes answers same-value-vs-progression without touching CFC state. (The brief's `op_node_hash_update` names this digest step conceptually; the in-tree symbol is `preparedDigestFor`.)

## What it means

This pins the +16% redundancy to **cross-runtime duplication of shared derivations**, not per-user view fan-out. Every runtime in the session re-derives the same space-scoped cells from the same synced inputs and re-commits them — 18 confirmed collision addresses in a single 157-commit window. That is precisely the work that cross-runtime **adoption** (A6) would eliminate (adopt a peer's already-committed derivation instead of recomputing) or that **coalescing** (A9) would fold. It rules out remediations aimed at per-user isolation, which would touch the wrong 51 user-scoped commits and leave the shared duplication intact.

## Status & open questions

- **Settled**: the *structure* of the redundancy — shared, space-scoped, cross-runtime-duplicated, demand-driven. This is the confirmed mechanism.
- **Open (blocked by perturbation)**: the *value-level* characterization. We do not yet know whether the duplicate writes are byte-identical (pure redundant recompute), a genuine value progression (both runtimes advancing shared state), or oscillation (write-write ping-pong). The non-perturbing path is digest capture via `preparedDigestFor`; it has not been run. Until it is, do not claim the duplicates are same-value.

## Related

- [02-multi-runtime-amplification-and-commit-cost.md](./02-multi-runtime-amplification-and-commit-cost.md) — quantifies the per-commit cost this census enumerates.
- [06-cross-runtime-adoption-what-would-be-needed.md](./06-cross-runtime-adoption-what-would-be-needed.md) — the remediation that would remove the 18 confirmed cross-runtime duplicate derivations.
- [09-remediation-direction.md](./09-remediation-direction.md) — synthesis that weighs adoption vs coalescing against this evidence.
