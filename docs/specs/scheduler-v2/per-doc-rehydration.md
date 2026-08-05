# Per-doc scheduler identity and the resume hold

The durable identity invariant this document carries: **each derived doc is
derived by exactly one piece, and `pieceId` IS that doc** (`${scope}:${id}`
of the piece's result cell). This held for the deleted persisted-observation
form and continues to hold for everything that keys scheduler state per
piece:

- **Static sub-pattern nodes**: the child result doc is minted from the
  cause `{ resultFor: <resolved output-redirect spot> }`
  (`instantiatePatternNode`), a stable, position-derived identity. One node
  owns one output spot; the same doc id re-derives on every resume.
- **Collection elements**: the per-element doc is minted from
  `{ map: <container>, elementKey }` where the container is
  `{ map: parentEntity, outputSpot }` and `elementKey` is the element's
  link identity (+ occurrence). One element occurrence, one doc.
  (Inline-value elements key positionally — an accepted identity trade-off
  documented in `builtins/map.ts`; a shifted inline element re-derives as a
  fresh doc.)
- Every pattern reader registers with this identity as its
  `observationIdentity` tag, which the scheduler uses to group shaped
  cell-flip wakes by instance and to tell pattern readers from internal
  machinery (plan B; `runner.ts schedulerObservationIdentity`).

Server-execution v2 keys the basis index's per-instance rows by the same
durable action identity
([serving-loop.md §3b](../server-side-execution/serving-loop.md)), so the
invariant stays load-bearing after the persisted-observation form's
deletion.

## Resume, after the reduction

There is no persisted scheduler state to restore (server-execution v2
Phase 1 stage C deleted the observation tables; the
[archived persisted-form account](../../history/specs/scheduler-v2/per-doc-rehydration-persisted-form.md)
records the design that ran here). A resumed piece registers every action
fresh; a piece resumed from a synced state holds each action's initial run
until the space finishes syncing (`awaitSyncBeforeInitialRun`), so
re-derivations read confirmed-loaded inputs instead of racing the data.
That hold is a bounded anti-churn gate, not a correctness precondition.
