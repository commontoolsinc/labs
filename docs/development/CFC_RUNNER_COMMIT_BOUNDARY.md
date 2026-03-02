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
