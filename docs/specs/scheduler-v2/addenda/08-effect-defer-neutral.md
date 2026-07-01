# Addendum A8 — Effect-defer (per-wave effect coalescing) — measured neutral

> **Status**: Measured neutral
> **Context**: multi-user cfc-group-chat scheduler-v2 vs main slowness investigation (2026-06/07), informing PR #4288.
> **Companion**: [scheduler-v2 README](../README.md); sibling addenda in this folder.

## Finding

Deferring effects to the end of a settle wave — so an effect fires once per wave
instead of once per intermediate value — was built behind a flag and measured
**~neutral** on the multi-user cfc-group-chat benchmark. It does not move the
stable ~16% scheduler-v2-vs-main gap. It is retained behind the flag but is a
likely-delete pending the coalescing work at the computation layer (A9).

## Evidence

- **Rationale.** A group-chat handler writes its whole effect in a single
  transaction, and the standard push-pull model already coalesces effects: an
  effect that is downstream of an invalid computation is placed *after* that
  computation in the pass so it runs at most once per wave rather than per
  intermediate value. This is the "clean effect ordering" behavior described in
  the scheduler-v2 README (`docs/specs/scheduler-v2/README.md`, §7.3 ordering,
  ~L482–486: *"a clean effect downstream of an invalid computation is placed
  after … effects run at most once per wave"*). The effect-defer option makes
  that per-wave firing the enforced behavior behind a flag.
- **Measured ~neutral.** With the flag on, there is no material change to the
  ~16% surplus on the multi-user cfc-group-chat benchmark. Recorded as decision
  **D4 of this investigation** (the investigation's own decision numbering; note
  the spec's own README §3 also uses the label "D4" for the unrelated
  "nodes create nodes" invariant — these are distinct).
- **Consistent with A7.** The surplus is dominated by cross-runtime
  re-derivation of shared cells, not by an effect firing on intermediates.
  Per-wave effect coalescing removes duplicate *effect* invocations, but the
  effect layer is not where the redundant work lives, so the win does not
  materialize.

## What it means

Coalescing at the **effect** layer alone is insufficient to close the +16%. The
redundant work is upstream of the effects: it is the shared-cell
re-derivations that each runtime repeats after a cross-runtime sync apply
(A3). An effect that already fires once per wave still sits atop a fan-out of
computations that each re-run per sync-applied write. Removing a handful of
redundant sink/render invocations does not touch that fan-out, which is why the
measurement lands neutral. The lever, if there is one, has to target the
**computations/derivations** (A9) — and even there the crux is the
cross-runtime duplication, not intra-wave repetition.

## Status & open questions

- **Settled.** Effect-defer is measured neutral on the target benchmark. It is
  correct (per-wave firing is already the intended push-pull semantics) but
  value-neutral, so it earns its keep only as a latent option.
- **Disposition.** Flagged off; likely-delete. It should be removed rather than
  carried indefinitely unless the coalescing work at the computation layer (A9)
  finds a reason to reuse the per-wave boundary machinery.
- **Open.** Whether a computation-layer coalescer (A9) can recover the surplus
  is unresolved; the cross-runtime re-derivation duplication (A3/A7) is the
  binding constraint either way.

## Related

- `07-pull-side-gate-no-go.md` — the pull-side gate lever, also measured
  ~neutral / structural NO-GO on this workload; same shape of result (a
  coalescing lever that does not reach the cross-runtime work).
- `09-remediation-direction.md` — the synthesis that points remediation at the
  computation/derivation layer and the cross-runtime duplication rather than at
  effects.
