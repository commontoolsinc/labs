# Addendum A9 — Remediation direction — coalesce/dedup, not version-skip

> **Status**: Synthesis / recommendation
> **Context**: multi-user cfc-group-chat scheduler-v2 vs main slowness investigation (2026-06/07), informing PR #4288.
> **Companion**: [scheduler-v2 README](../README.md); sibling addenda in this folder.

## Finding

The tractable lever for the stable ~16% multi-user regression is to **coalesce/dedup the redundant cross-runtime re-derivations of shared cells** — not to short-circuit re-derivation via a version-skip read of the serialized scheduler state (A5, refuted), not a pull-side read-set gate (A7, structural NO-GO on this workload), and not effect-defer in isolation (A8, measured neutral). Cross-runtime adoption (A6) is the ambitious lever that removes the same redundancy at its source, but it carries a CFC/provenance cost that must be designed before it is prototyped. The single coherent story: the cost is each runtime independently re-deriving the same space-scoped cells; remove the redundancy, and the gap closes.

## Evidence

- Cross-runtime duplication of shared derivations is confirmed (A3): both runtimes independently recompute the same space-scoped cells — 18 of 31 multi-writes are the same derivation run twice across runtimes. v2 already has P2 value-accurate invalidation (`docs/specs/scheduler-v2/README.md` §"P2 — Value-accurate invalidation", ~L99), so the *invalidation* is already value-gated; what remains redundant is the *derivation itself* being executed in both runtimes.
- Commits are fire-and-forget (A2), so the win is **fewer committed intermediates**, not faster acknowledgements — a coalescing lever that reduces the number of committed re-derivations attacks the actual cost, whereas any lever aimed at ack latency does not.
- Coalescing/dedup directions carried over from the scheduler-v2 benchmark work:
  - **closure-memo** — memoize the per-pass work-set closure so a wide-fan-out hub (a list cell aggregating N rows) does not recompute its closure on every pass.
  - **value-aware-bound** — bound re-derivation using committed-value equality, extending P2 value-gated invalidation from the invalidation edge to the derivation body.
  - **refcount-prune** — the `hasInvalidUpstream` inverted-reachability work-set pruning, already prototyped: `packages/runner/src/scheduler/event-preflight-dependencies.ts` seeds from the maintained invalid-node set and walks *down* to the closure (v2, ~L70–95, decision 15), shrinking the maintained work-set rather than walking the closure's upstream cone.

## What it means

The three refuted/neutral levers (A5, A7, A8) all tried to *avoid* work by reading around it — skipping via serialized state, gating on the read-set, or deferring effects — and none moved the multi-user number in the right direction. The redundancy identified in A3 is not avoidable by any single such shortcut because it is genuine duplicated computation across two independent runtimes, each of which must currently produce its own committed value for the shared cell. The only durable win is to make that computation happen **once** (coalesce within a runtime; dedup/adopt across runtimes), which is exactly what closure-memo, value-aware-bound, and refcount-prune move toward — and, at the limit, what cross-runtime adoption (A6) achieves.

## Status & open questions

Recommendation, not a landed fix. Prototypes partly exist (refcount-prune is real code on v2; closure-memo and value-aware-bound are directions, not implementations).

Recommended order:
1. **Near-term** — pursue coalescing/dedup (closure-memo + value-aware-bound), measured on the multi-user cfc-group-chat, judging on *fewer committed intermediates* (A2), not ack latency.
2. **Medium-term** — prototype cross-runtime adoption (A6) behind a flag, with the CFC/provenance model (A6 requirement c) designed **first**.
3. **Do NOT** — flip the persistent-scheduler-state flag expecting a steady-state version-skip (A5); retry the pull-side gate on this workload (A7).

Open: none of the near-term prototypes has yet been measured end-to-end on this benchmark; the adoption provenance model is unspecified.

## Related

- [03-transaction-census.md](03-transaction-census.md) — the confirmed redundancy this recommendation removes (18/31 multi-writes duplicated).
- [05-serialized-scheduler-state-is-reload-only.md](05-serialized-scheduler-state-is-reload-only.md) — refuted: serialized-state version-skip does not yield a steady-state skip.
- [06-cross-runtime-adoption-what-would-be-needed.md](06-cross-runtime-adoption-what-would-be-needed.md) — the medium-term root-cause lever, gated on a CFC/provenance model.
- [07-pull-side-gate-no-go.md](07-pull-side-gate-no-go.md) — structural NO-GO on this workload; do not retry.
- [08-effect-defer-neutral.md](08-effect-defer-neutral.md) — measured neutral; not the lever.
- [02-multi-runtime-amplification-and-commit-cost.md](02-multi-runtime-amplification-and-commit-cost.md) — why the win is fewer committed intermediates, not faster acks.
