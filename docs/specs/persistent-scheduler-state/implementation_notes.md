# Persistent Scheduler State Implementation Notes

## 2026-05-20 - Plan Checkpoint

- Branch: `codex/persistent-scheduler-state-spec`.
- Plan version: transaction-centric hybrid scheduler persistence with per-space
  mirrored read indexes.
- Initial assumptions:
  - scheduler observations are internal runtime state, not user-visible memory
    data
  - no-op observations are durable but do not create semantic memory revisions
  - the memory server records dirty/stale scheduler state but never executes
    actions
  - stable action identity starts from scheduler/action metadata and can be
    tightened when process graph snapshots become durable
- Known gaps to resolve during implementation:
  - exact durable action identity before full process graph snapshots exist
  - whether dirty/stale state needs per-cause rows instead of summary sequence
    fields
  - how far v1 rehydration can go without a persisted process graph snapshot
  - how to keep mirrored cross-space read index cleanup reliable after action
    replacement
- Validation so far: spec-only work, `git diff --check` passed before this
  implementation pass.

## 2026-05-20 - Red Test Checkpoint

- Added red tests for the first implementation seams:
  - scheduler observation construction excludes `attemptedWrites`
  - memory v2 persists no-op scheduler observations without semantic commits
  - memory v2 indexes scheduler readers and can mark them dirty from writes
- Expected failures before implementation:
  - missing `scheduler/persistent-observation.ts`
  - missing memory v2 scheduler-state engine APIs
- Decision: start with engine-level internal persistence and observation
  construction before trying full runner restart semantics. This keeps the
  first green slice independent of process graph snapshot work.

## 2026-05-20 - Observation Builder

- Implemented a pure scheduler observation builder in
  `packages/runner/src/scheduler/persistent-observation.ts`.
- Decision: keep this builder runner-local for now. Memory v2 gets its own
  structurally compatible type because `packages/memory` must not depend on
  `packages/runner`.
- Validation:
  - `deno test -A packages/runner/test/scheduler-observations.test.ts`
