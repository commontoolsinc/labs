# @commonfabric/spec-model

Executable mini-models of in-progress specs, checked by property tests over
explored schedules. NON-NORMATIVE: the spec documents govern; a disagreement
between a model and its spec is a finding against one of them, resolved in the
spec's ruling process — never silently in the model.

## server-execution

Models the **identity/commit machinery** of `docs/specs/server-side-execution/`
(the v2 spec, PR #5269) as ruled through 2026-08-03: commit classes and
envelopes, `firedAt` stamping and actor inheritance (uniform across run kinds —
LT6), same-space cascade carriage (LT1), delegated cross-space carriage and
stamping, the wave with commit splits, `eventWatermark` idempotency, the
crash-lossy process-local outbox, navigateTo's session-connection requirement
(LT3), the effect channel's enact/ack window (LT8), and `scope_key` push
filtering.

Why it exists: the scenario-trace and field-provenance instruments (see those
docs' §1 protocols) check hand-enumerated journeys and per-field chains; neither
explores SCHEDULES. The model does — small configurations, exhaustive
interleaving with fault injection — and it runs unattended (`deno task test`),
so every future ruling batch can be re-verified mechanically.

One test is a **characterization of open ledger item FP1**
(`field-provenance.md` §6): it asserts the lost-append crash trace IS reachable.
When the FP1 ruling lands a regeneration mechanism, model the mechanism and flip
that test to assert the trace set is empty.

Deliberately NOT modeled (extend when a question needs them):
scheduler/dirtiness internals, the basis index, CFC label ladders, scope
narrowing and fan-out, speculation values (only the enacted-nonce overlay
record), offline queues, quotas, `.inSpace` provisioning. Values are counters;
docs are key-value rows; one memory server hosts all spaces (the spec's
co-hosted assumption).

This package is the seed of `testing.md` §5's `sx2` conformance surface: as
Phase 1 stages land, their semantics (lease, seal, watermark) should be checked
against these properties before the real implementation exists, then the
properties become the implementation's oracle.
