# Runner CFC Commit Boundary

This note documents the runner-internal CFC commit lifecycle in
`packages/runner`.

## Prepare-Before-Commit Flow

Reactive actions and event handlers both use the same boundary flow:

1. Action or handler runs in a fresh transaction attempt.
2. If the attempt is CFC-relevant and commit-bearing (writes or queued
   side effects), scheduler calls `prepareCfcCommitIfNeeded(tx)`.
3. Prepare performs boundary checks and persists CFC metadata for writes:
   `cfc.schemaHash` and `cfc.labels`.
4. Prepare snapshots the canonical activity digest and stores it in tx CFC state.
5. Commit gate recomputes digest at `commit()` and rejects if activity changed.

Read-only relevant transactions bypass the prepare-required gate by design.

## Handler Outbox Lifecycle

Handler-side stream sends are commit-gated through transaction outbox:

1. Handler code enqueues side effects on tx outbox (FIFO order).
2. Outbox is flushed only after successful commit.
3. On abort, gate failure, or commit failure, outbox is dropped.
4. Retries run with fresh transactions, so only the committed attempt flushes.

This guarantees no pre-commit side effects are emitted from failed attempts.

## Event Envelope and Once-Claims

Scheduler events now normalize to an internal envelope before handler delivery:

1. Every queued event has a stable internal `id`, raw `payload`, integrity
   array, and delivery mode.
2. Legacy raw events are wrapped with a fresh ephemeral id so existing delivery
   semantics stay unchanged.
3. The current envelope is attached to the handler transaction for the duration
   of execution (`tx.currentCfcEvent`).

Explicit semantic events may request `once-per-handler` delivery:

1. Before running the handler, scheduler derives a handled marker from
   `(eventId, handlerId)` in the event stream's space.
2. If the marker already exists locally, scheduler skips handler execution and
   treats the event as already handled.
3. Otherwise the marker write is added to the transaction and committed with the
   rest of the handler's writes.
4. If commit conflicts on that marker, scheduler treats the result as deduped
   success rather than retrying.

This is the runner foundation for later `IntentEvent` / `IntentOnce` work:
event consumption is expressed through ordinary tx conflict/CAS on derived
entities instead of a separate token store.

Runner internals now also expose a semantic `IntentEvent` helper layer:

1. Semantic intent ids are derived deterministically from
   `(sourceGestureId, conditionHash, parameters)`.
2. Semantic intent envelopes carry explicit integrity/evidence and default to
   `once-per-handler` delivery.
3. These helpers reuse the same scheduler envelope path, so later trusted UI
   or runtime code can mint semantic events without adding a second event
   mechanism.

On top of that, runner internals now expose deterministic refinement helpers:

1. Refinement claim cells are keyed by `(sourceIntentId, refinerHash)` and use
   the ordinary transaction path, so duplicate refinement attempts collapse to
   normal CAS/conflict behavior.
2. Derived `IntentOnce` ids are deterministic from the same pair.
3. Refined intent values accumulate source intent integrity plus a
   `RefinedBy` atom, but still stop short of sink commit / consumption logic.

Runner internals also now expose the short-intent value shape needed for later
commit points:

1. `IntentOnce` helpers bind `audience`, `endpoint`, `payloadDigest`, and
   `idempotencyKey` onto the derived value.
2. Payload digests are canonical over parameters; idempotency keys are stable
   from `(sourceIntentId, operation)`.
3. Short-intent verification is currently limited to the spec's <=5s duration
   window and does not yet execute or consume the intent.

Intent consumption bookkeeping is now also present as an internal helper layer:

1. Consumed-intent cells are deterministic from `intentOnceId`.
2. Attempt cells are deterministic from `(intentOnceId, attemptNumber)`.
3. Both claim paths use ordinary tx writes, so later bounded-retry execution can
   reuse normal CAS/conflict behavior instead of a separate intent token store.

## Internal Verifier Read Marker

Verifier/system reads use metadata marker `internalVerifierRead`:

1. Marker is attached to verifier reads via `internalVerifierReadMeta`.
2. Marker is preserved in transaction activity/canonicalization for diagnostics.
3. Marked reads are excluded from consumed-input label enforcement.

This keeps boundary enforcement focused on user-consumed reads while preserving
auditability of verifier reads.

## Rejection Logging

Scheduler emits structured `cfc-reject` logs on CFC terminal failures using
sanitized fields (`name`, requirement/path/entity context, fuel, counts).
Sensitive payload fields (values, digests, schema hash bodies) are not logged.
