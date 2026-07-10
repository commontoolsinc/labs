---
status: historical
created: 2026-07-01
archived: 2026-07-09
reason: "Scheduler-v2 investigation record: what cross-runtime derivation adoption would require."
---

# Addendum A6 — Cross-runtime derivation adoption — what would be needed

> **Status**: Design proposal (not implemented)
> **Context**: multi-user cfc-group-chat scheduler-v2 vs main slowness investigation (2026-06/07), informing PR #4288.
> **Companion**: [scheduler-v2 README](../../../../specs/scheduler-v2/README.md); sibling addenda in this folder.

## Finding

The one mechanism that would directly remove the cross-runtime shared-derivation
redundancy documented in A2/A3 is **cross-runtime adoption**: when a peer runtime
has already committed a shared derived cell, a local runtime *skips* re-deriving
it and instead adopts the committed value — provided the peer derived it over the
same input basis the local action would read. Adoption does not exist today
(A5): a peer's committed shared cell arrives as a reader-dirty trigger and the
local runtime unconditionally re-runs. Building adoption requires three things,
of which the third (trust/provenance) is a substantial CFC design effort.

## Evidence

- **No basis is persisted per read.** v2: `persistent-observation.ts:SchedulerActionObservation`
  (~L21) stores `reads: IMemorySpaceAddress[]` — bare addresses — plus a single
  whole-observation `observedAtSeq` (~L31). There is no per-read seq, so nothing
  durably records "this derived value = f(inputs at *these* versions)". The
  commit envelope carries per-read seqs transiently, but the persisted
  observation flattens them away.
- **The settle gate keys on status, not value/basis.** v2:
  `settle.ts:isInvalidOrNeverRan` (~L239) returns true when
  `record.status === "invalid" || record.status === "never-ran"`, and
  `isRunnableSchedulingSeed` (~L224) runs a node purely on that predicate plus
  liveness/throttle. A peer commit that dirties a reader flips it to a runnable
  state and it *runs*; there is no comparison of the local read-basis against
  the peer commit's basis.
- **Duplication magnitude** (A2/A3): shared derivations are re-computed
  ~2.2x across peers on cfc-group-chat; this is the ~16% v2-vs-main gap's source
  region.

## What it means

Adoption attacks the +16% at its root instead of trimming its symptoms. To make
it sound, three capabilities must be added:

**(a) Per-read basis stamp.** Record, per read, the version/seq of the input at
read time, and durably bind the produced derived value to `f(inputs @ those
versions)`. This is the enabling data structure; without it adoption cannot be
decided soundly (you cannot tell whether the peer's basis matches yours).

**(b) Settle-time adopt gate.** On arrival of a peer's freshly committed shared
cell (today a reader-dirty trigger), the gate compares the local action's
read-basis to the peer commit's basis. If the peer derived the value over the
same inputs-at-versions, **adopt** the committed value and mark the node clean
instead of running it. This is a new value/basis-aware path alongside the
status-only path in `settle.ts`.

**(c) Trust / provenance handling — the hard part.** Consuming a peer's derived
result without local re-derivation crosses a CFC boundary. The adopted value's
integrity/confidentiality labels and provenance must be verifiable: the local
runtime is trusting both that the peer computed `f` correctly *and* that the
result's classification is sound. Under enforce-explicit, naive adoption could
launder labels. This needs a dedicated CFC design and should not ship without one.

## Status & open questions

- **Settled precondition (the key enabler).** Soundness leans on a
  *no-pending-local-changes* condition. Because user actions are serialized, when
  a local runtime processes a peer write it is at a settled basis with no local
  divergence from the peer's basis — exactly when adoption is safe. Detecting it:
  the local scheduler is idle/settled and the node's read-basis is unshadowed by
  any local uncommitted write to those addresses. Adoption should be *declined*
  (fall back to re-run) whenever this cannot be established.
- **Interaction with P2 value-gated invalidation:** complementary, not
  redundant. Value-gating suppresses downstream propagation on equal values
  *within* a runtime; adoption suppresses redundant *derivation across* runtimes.
- **Interaction with conflict/revert:** an adopted value must be revertable like
  any committed value; the basis stamps from (a) must survive revert so a
  reverted adoption re-decides correctly rather than re-adopting stale state.
- **Why the serialized state cannot simply be flipped to do this (A5):** reads
  are address-only (cannot express basis); serialized state is reload-only
  consumption; the decision is presence-of-dirty (a peer message dirties → run);
  cross-space dirtiness propagation forces recompute. None of these can express
  "same basis ⇒ adopt" without the new (a)/(b) machinery.

**Recommendation:** treat adoption as the *ambitious* lever. Pursue the tractable
coalescing/dedup lever first (A9). Prototype adoption behind a flag only after
the CFC model for (c) is worked out; do not merge (a)+(b) without it, or the
system risk-shifts a correctness/labeling hole in exchange for the speedup.

## Related

- [05-serialized-scheduler-state-is-reload-only.md](05-serialized-scheduler-state-is-reload-only.md) — why the existing serialized mechanism structurally cannot do adoption.
- [02-multi-runtime-amplification-and-commit-cost.md](02-multi-runtime-amplification-and-commit-cost.md) / [03-transaction-census.md](03-transaction-census.md) — the cross-runtime shared-derivation redundancy (~2.2x) that adoption targets.
- [09-remediation-direction.md](09-remediation-direction.md) — the tractable coalescing/dedup alternative to pursue first.
