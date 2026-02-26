# CFC Runner Implementation Plan (Detailed Checklist)

This document is the implementation checklist for integrating CFC boundary
verification into `packages/runner` in:

- `packages/runner`

The goal is to move from current transaction logging + schema traversal to
hard commit-time enforcement of CFC boundary rules, with commit-gated side
effects and deterministic schema binding.

## Status Legend

- `[ ]` not started
- `[x]` done
- `[-]` intentionally deferred

## 0. Scope, Constraints, and Non-Goals

### 0.1 Agreed Constraints

- [x] Boundary checks are declared via schema `ifc` annotations (no separate
      handler flag model).
- [x] CFC relevance is detected in read/transform traversal
      (`validateAndTransform` and doc walking), not only at scheduler setup.
- [x] Any consumed read with effective IFC label constraints can trigger
      prepare-before-commit enforcement.
- [x] Canonical wrapper stripping is fixed to `/value` (not runtime-configured).
- [ ] Legacy classification-only compatibility paths are removable.
- [x] Handler side effects are commit-gated: queue first, flush after success.
- [x] Retry semantics stay at CAS/conflict level in spec (implementation can map
      concrete errors internally).

### 0.2 Phase-1 Schema Policy (Explicit)

- [x] Full write-time JSON Schema validation is deferred.
- [x] Commit-bearing CFC writes must persist `cfc.schemaHash`.
- [x] Commit-bearing CFC writes must persist/update `cfc.labels`.
- [x] Commit gate rejects CFC-relevant writes when schema hash cannot be
      resolved.
- [x] For existing entities, schema hash is immutable by default unless
      explicit migration flow is used.
- [ ] Prepare/check uses the exact schema identified by `cfc.schemaHash`.
- [ ] Full write-time schema validation is tracked as a later strict pass.

### 0.3 Non-Goals for This Pass

- [-] Full schema migration orchestration UX.
- [-] Full policy distribution/discovery protocol redesign.
- [-] Replacement of all runner transaction lifecycle TODOs unrelated to CFC.

## 1. Architecture Baseline and Design Lock

### 1.1 Current-State Audit (Code)

- [ ] Confirm current commit-bearing tx creation points:
      `packages/runner/src/scheduler.ts`.
- [ ] Confirm dependency-discovery tx points (must be excluded from CFC commit
      semantics): `collectDependenciesForAction` flow.
- [ ] Confirm journal activity shape and metadata propagation:
      `packages/runner/src/storage/transaction/journal.ts`.
- [ ] Confirm current read metadata markers and scheduling behavior:
      `packages/runner/src/scheduler.ts`.
- [ ] Confirm existing schema/transform traversal entry points:
      `packages/runner/src/schema.ts`,
      `packages/runner/src/traverse.ts`,
      `packages/runner/src/cell.ts`.

### 1.2 Design Decisions to Lock in Code Comments/Types

- [ ] Define `CfcTxState` type (relevance, preparation, digest, outbox).
- [x] Define `prepareBoundaryCommit` contract shape.
- [x] Define `internalVerifierRead` metadata marker key and semantics.
- [x] Define `AttemptedWrite` canonical shape used by verifier.
- [x] Define `PreparedDigestInput` and stable hash strategy.

### 1.3 Invariants (Must Hold)

- [ ] No CFC-relevant commit may succeed without prepare.
- [x] Prepare must be same-attempt (same tx journal, no stale reuse).
- [x] Any activity change after prepare invalidates preparation.
- [x] Side effects from handler/event sends must not escape before commit.
- [x] Retry uses fresh tx and recomputes reads/writes/checks.
- [ ] Boundary policy evaluation must be fail-closed: non-converged fixpoint
      (fuel exhaustion) rejects the attempt.
- [ ] Confidentiality rewrites must use conjunctive declassification gates:
      release condition true, required integrity evidence present, trusted
      control scope present.
- [ ] Guard evidence must come from evaluated value integrity (guard/result
      labels), not ambient control-integrity context alone.
- [ ] Multi-atom confidentiality preconditions default to clause-local matching;
      cross-clause matching must be explicit.

## 2. Transaction Model Extensions

Primary files:

- `packages/runner/src/storage/interface.ts`
- `packages/runner/src/storage/extended-storage-transaction.ts`

### 2.1 Interface Additions

- [x] Add typed CFC state to extended transaction interface:
      `cfcRelevant`, `cfcPrepared`, `preparedActivityDigest`, `cfcOutbox`.
- [x] Add methods:
      `markCfcRelevant(reason)`, `markCfcPrepared(digest)`,
      `invalidateCfcPreparation()`, `enqueueCfcSideEffect(effect)`.
- [x] Add optional debug metadata (`cfcReasons`, timestamps) for diagnostics.

### 2.2 Commit Gate

- [x] In `commit()`, enforce `cfcRelevant -> cfcPrepared`.
- [x] Recompute journal digest at commit and compare to prepared digest.
- [x] Reject with explicit error type when gate fails (new error variant).
- [x] Ensure errors are distinguishable for retry behavior.

### 2.3 State Lifecycle Safety

- [x] Ensure abort clears pending CFC outbox.
- [x] Ensure retry attempt starts with clean CFC state.
- [x] Ensure no cross-tx reuse of preparation state.

### 2.4 Acceptance Criteria

- [x] Unit test: CFC-relevant tx with no prepare fails commit.
- [x] Unit test: prepared tx with unchanged activity passes gate.
- [x] Unit test: prepared tx with post-prepare write fails gate.
- [x] Unit test: abort drops outbox.

## 3. Canonical Activity and Boundary Data Model

Primary files:

- new files under
  `packages/runner/src/cfc/`
- integration in
  `packages/runner/src/scheduler.ts`

### 3.1 Canonical Path Utilities

- [x] Implement JSON Pointer conversion for journal paths.
- [x] Implement fixed wrapper strip for `/value`.
- [x] Preserve root path mapping to `/`.
- [x] Add helper for canonical path equality/normalization.

### 3.2 Canonical Activity Extraction

- [x] Build extractor from `tx.journal.activity()` returning:
      canonical reads and attempted writes.
- [x] Preserve write order exactly.
- [x] Retain read metadata including `internalVerifierRead`.
- [x] Exclude only verifier-internal reads from consumed-input set.

### 3.3 Attempted vs Effective Views

- [x] Keep ordered attempted write list.
- [x] Build final-per-path view (last-write-wins in-attempt).
- [x] Keep changed/no-op flags where available.
- [x] Ensure no-op attempted writes still present for verification.

### 3.4 Digest Material

- [ ] Define deterministic digest input fields:
      canonical reads, attempted writes, internal flags, tx identity scope.
- [x] Exclude unstable fields (timestamps/non-deterministic IDs unless needed).
- [x] Use stable serialization before hashing.

### 3.5 Acceptance Criteria

- [x] Unit test: `/value/a` canonicalizes to `/a`.
- [x] Unit test: internal verifier reads marked and excluded from consumed set.
- [x] Unit test: write order preserved.
- [x] Unit test: final-per-path picks last attempted write.
- [x] Unit test: no-op attempted write remains in attempted list.

## 4. CFC-Relevance Detection in Read/Transform/Traversal

Primary files:

- `packages/runner/src/schema.ts`
- `packages/runner/src/traverse.ts`
- `packages/runner/src/cell.ts`

### 4.1 Read-Path Schema Trigger

- [x] During `validateAndTransform`, if traversed schema path has `ifc`, mark
      tx CFC-relevant.
- [x] Include link-followed schemas (post-resolution schema context).

### 4.2 Effective-Label Trigger

- [ ] When read resolves through link/doc context with effective label
      constraints, mark tx CFC-relevant.
- [ ] Ensure detection occurs after schema/label accumulation across link hops.

### 4.3 Write-Path Trigger (Write-Only Actions)

- [x] In write APIs (`set`, `update`, `push`, diff/update path), mark tx
      relevant when target doc/path has IFC obligations even without reads.

### 4.4 Exclusions

- [x] Ensure non-commit-bearing dependency-collection tx does not trigger
      prepare requirement.
- [x] Ensure helper reads tagged as verifier/scheduling internals do not inflate
      consumed-input label checks.

### 4.5 Acceptance Criteria

- [ ] Test: read through link with IFC schema marks tx relevant.
- [ ] Test: read on plain schema/no labels does not mark relevant.
- [ ] Test: write-only to labeled target marks relevant.
- [ ] Test: dependency collection path does not require prepare.

## 5. Boundary Prepare Engine

Primary files:

- new CFC engine files under
  `packages/runner/src/cfc/`
- scheduler integration in
  `packages/runner/src/scheduler.ts`

### 5.1 Input Requirement Verification

- [x] Implement consumed-input label gathering from canonical reads.
- [ ] Implement coherent `requiredIntegrity` verification for object-level
      annotations.
- [x] Implement `maxConfidentiality` checks.
- [x] Respect same-attempt semantics only.

### 5.2 Output Transition Verification

- [x] Implement transition checks over attempted writes.
- [x] Support exact copy / projection checks where applicable.
- [x] Preserve no-op attempted writes in policy evaluation.
- [x] Support final-per-path view for rules that depend on final attempted
      value.

### 5.3 State-Dependent Preconditions (7.5.3)

- [ ] Add same-attempt read precondition protocol enforcement.
- [ ] Require state predicate check before write commit eligibility.
- [ ] Reject attempt when required read/predicate is missing/fails.

### 5.4 Label + SchemaHash Persistence in Prepare

- [ ] Compute new effective labels for outputs/writes.
- [x] Resolve schema to canonical bytes and compute hash.
- [x] Write `cfc.schemaHash` and `cfc.labels` as part of prepare path.
- [x] Ensure prepare fails if schema hash cannot be resolved.

### 5.5 Prepare Outcome Handling

- [x] On success: set `cfcPrepared=true` and store digest.
- [x] On failure: abort attempt tx and return typed boundary error.
- [x] Ensure failure does not emit side effects.

### 5.6 Policy Evaluation Semantics Lock

- [ ] In declassification/exchange guard checks, require release condition to be
      true before confidentiality rewrite.
- [ ] Keep control-integrity (`pcI`) as control-only context; do not auto-inject
      ambient `pcI` tokens into value integrity labels.
- [ ] Implement policy precondition scope default as clause-local
      (`preConfScope = targetClause`) with explicit opt-in for global
      (`anywhere`) matching.
- [ ] Return explicit non-convergence signal from bounded policy fixpoint
      evaluation and reject boundary attempt on that signal.

### 5.7 Acceptance Criteria

- [x] Test: input requirement failure rejects attempt pre-commit.
- [x] Test: output transition failure rejects attempt pre-commit.
- [x] Test: missing schema hash resolution rejects attempt.
- [x] Test: successful prepare writes labels + schemaHash.

## 6. Scheduler and Retry Integration

Primary file:

- `packages/runner/src/scheduler.ts`

### 6.1 Reactive Action Path (`run`)

- [x] Insert prepare step between action completion and `tx.commit()`.
- [x] Keep existing commit retry loop behavior where applicable.
- [x] On retryable commit failure, ensure fresh tx reruns action and prepare.

### 6.2 Event Handler Path

- [x] Insert prepare step before commit in event execution flow.
- [x] Preserve existing requeue retry behavior for retryable failures.
- [x] Ensure no stale prepare state survives into requeued attempt.

### 6.3 Error Classification

- [x] Map commit failures into retryable vs terminal classes.
- [x] Treat CAS/conflict/inconsistency as retryable in implementation.
- [x] Treat prepare-gate failures as terminal unless policy says otherwise.
- [ ] Treat policy non-convergence/fuel exhaustion as terminal boundary failure
      (fail closed), not retryable-without-new-input.

### 6.4 Acceptance Criteria

- [x] Test: retryable failure causes fresh attempt and re-prepare.
- [x] Test: non-retryable failure does not loop.
- [x] Test: prepare-gate failure surfaces clear error.

## 7. Commit-Gated Side Effects (Event Outbox)

Primary files:

- `packages/runner/src/cell.ts`
- `packages/runner/src/scheduler.ts`
- `packages/runner/src/storage/extended-storage-transaction.ts`

### 7.1 Side-Effect API Changes

- [x] Replace immediate event emission from handler tx context with outbox
      enqueue.
- [x] Keep existing non-handler flow behavior unchanged.

### 7.2 Flush Semantics

- [x] Flush outbox only after successful commit.
- [x] Flush order must match enqueue order.
- [x] Drop outbox on abort/reject.

### 7.3 Retry Semantics

- [x] On retry, ensure only committed attempt flushes events.
- [x] Ensure prior failed attempts do not leak queued events.

### 7.4 Acceptance Criteria

- [x] Test: queued event not delivered when commit fails.
- [x] Test: queued event delivered once after successful retry commit.
- [x] Test: multiple queued events preserve order.

## 8. Schema Hash and Registry Plumbing

Primary files:

- new schema-hash support under
  `packages/runner/src/cfc/`
- integration in traversal/prepare code paths

### 8.1 Canonical Schema Hashing

- [x] Define canonical schema serialization format.
- [x] Implement deterministic hash function wrapper.
- [x] Include version tag for hash format evolution.

### 8.2 Schema Resolution

- [x] Resolve schema from read/write context at prepare time.
- [x] Reject prepare if schema is absent for required CFC write.
- [ ] Cache resolved schema hashes per attempt for performance.

### 8.3 Existing Entity Rules

- [x] Read existing `cfc.schemaHash` when present.
- [x] Enforce immutability by default on existing entities.
- [ ] Add explicit hook point for future migration mode.

### 8.4 Acceptance Criteria

- [x] Test: same schema yields stable hash across runs.
- [x] Test: schema change on existing entity rejects without migration.
- [x] Test: missing schema for CFC-relevant write rejects.

## 9. Internal Verifier Read Marker

Primary files:

- `packages/runner/src/storage/interface.ts`
- `packages/runner/src/storage/transaction/journal.ts`
- `packages/runner/src/scheduler.ts`

### 9.1 Marker Definition

- [x] Add explicit `internalVerifierRead` metadata convention.
- [x] Keep separate from scheduling-only markers.

### 9.2 Propagation

- [x] Ensure read options metadata survives into journal activity.
- [x] Ensure canonical activity extraction preserves the marker.

### 9.3 Consumption

- [x] Exclude verifier-internal reads from consumed input label set.
- [x] Keep verifier-internal reads available for diagnostics.

### 9.4 Acceptance Criteria

- [x] Test: verifier-internal read present in activity but absent from consumed
      inputs.
- [x] Test: non-verifier read remains consumed input.

## 10. Legacy Path Cleanup

Primary files:

- `packages/runner/src/cfc.ts`
- `packages/runner/src/storage/cache.ts`
- `packages/runner/src/storage/interface.ts`

### 10.1 Identify Dead Compatibility Paths

- [ ] Inventory classification-only legacy branches.
- [ ] Confirm no tests depend on removed paths.

### 10.2 Remove/Refactor

- [ ] Remove unused compatibility translation code.
- [ ] Keep needed schema traversal helpers not tied to legacy mode.
- [ ] Update typing/docs to remove legacy mentions.

### 10.3 Acceptance Criteria

- [ ] Existing non-CFC tests still pass.
- [ ] No references to removed legacy path remain.

## 11. Test Plan (Detailed Matrix)

Primary test location:

- `packages/runner/test/`

### 11.1 Commit Gate Tests

- [x] `cfc-commit-gate-rejects-without-prepare.test.ts`
- [x] `cfc-commit-gate-rejects-on-digest-mismatch.test.ts`
- [x] `cfc-commit-gate-allows-prepared-unchanged.test.ts`

### 11.2 Relevance Detection Tests

- [ ] `cfc-relevance-from-ifc-schema-read.test.ts`
- [ ] `cfc-relevance-from-effective-label-read.test.ts`
- [ ] `cfc-relevance-from-write-target-label.test.ts`
- [ ] `cfc-no-relevance-for-dependency-collection.test.ts`

### 11.3 Activity Canonicalization Tests

- [x] `cfc-canonicalize-strip-value-prefix.test.ts`
- [x] `cfc-attempted-write-order.test.ts`
- [x] `cfc-final-write-last-wins.test.ts`
- [x] `cfc-noop-attempted-write-included.test.ts`

### 11.4 Boundary Prepare Tests

- [x] `cfc-input-required-integrity-fail.test.ts`
- [x] `cfc-output-transition-fail.test.ts`
- [ ] `cfc-state-precondition-read-required.test.ts`
- [ ] `cfc-state-precondition-predicate-required.test.ts`
- [x] `cfc-prepare-persists-schemahash-and-labels.test.ts`
- [ ] `cfc-policy-fixpoint-fuel-exhaustion-fail-closed.test.ts`
- [ ] `cfc-declassify-guard-false-no-rewrite.test.ts`
- [ ] `cfc-declassify-ambient-pci-token-not-sufficient.test.ts`
- [ ] `cfc-policy-preconf-target-clause-default.test.ts`
- [ ] `cfc-policy-preconf-anywhere-opt-in.test.ts`
- [ ] `cfc-exchange-ambient-pci-token-not-sufficient.test.ts`

### 11.5 Side-Effect Gating Tests

- [x] `cfc-event-not-emitted-on-failed-commit.test.ts`
- [x] `cfc-event-emitted-after-successful-commit.test.ts`
- [x] `cfc-event-order-preserved.test.ts`
- [x] `cfc-retry-emits-once.test.ts`

### 11.6 Schema Hash Tests

- [x] `cfc-schemahash-stable.test.ts`
- [x] `cfc-schemahash-required-for-relevant-write.test.ts`
- [x] `cfc-schemahash-immutable-existing-entity.test.ts`

### 11.7 Internal Verifier Read Tests

- [x] `cfc-internal-verifier-read-excluded-from-consumed.test.ts`
- [x] `cfc-internal-verifier-read-retained-in-activity.test.ts`

### 11.8 Regression and Performance Smoke

- [x] Run existing scheduler/transaction regression tests.
- [x] Run existing CFC-related tests.
- [ ] Add a smoke benchmark around prepare overhead in reactive loops.

## 12. Rollout and Guardrails

### 12.1 Feature Flagging

- [ ] Add runtime feature flag for staged enablement (if needed).
- [ ] Start with CI-on, production-off mode if runtime supports staged rollout.

### 12.2 Observability

- [ ] Add debug counters:
      `cfcRelevantTx`, `cfcPreparedTx`, `cfcGateRejects`, `cfcOutboxFlushes`.
- [ ] Add structured logs for rejection reasons.
- [ ] Ensure sensitive values are not logged.

### 12.3 Backward Compatibility Checks

- [x] Verify unchanged behavior for transactions not marked CFC-relevant.
- [x] Verify non-handler paths are unaffected by event outbox changes.

## 13. Documentation and Spec Sync

Primary docs:

- `cfc/08-10-validation-at-boundaries.md`
- `cfc/07-write-actions.md`
- `cfc/04-label-representation.md`
- `cfc/FORMALIZATION.md`

### 13.1 Runner Documentation

- [ ] Add runner-internal design note for prepare-before-commit.
- [ ] Add lifecycle doc for tx outbox and flush behavior.
- [ ] Document internal verifier read marker.

### 13.2 Spec Cross-Check

- [ ] Confirm implementation aligns with attempted-write semantics.
- [ ] Confirm fixed `/value` stripping behavior is reflected.
- [ ] Confirm state-precondition same-attempt rule coverage.
- [ ] Confirm schemaHash persistence policy is represented.
- [ ] Confirm declassification gate is conjunctive (condition true + evidence +
      trusted control).
- [ ] Confirm ambient control-integrity tokens are not treated as value evidence.
- [ ] Confirm policy side-condition scope defaults to clause-local matching.
- [ ] Confirm bounded fixpoint evaluation rejects on non-convergence.
- [ ] Confirm runner tests cover guard-false, ambient-token-smuggling, and
      cross-clause-mixing attack shapes.

## 14. Execution Order (Recommended)

- [ ] Step A: complete Section 2 (transaction model extensions).
- [ ] Step B: complete Section 3 (canonical activity + digest).
- [ ] Step C: complete Section 4 (relevance detection).
- [ ] Step D: complete Section 5 (prepare engine).
- [ ] Step E: complete Section 6 and 7 (scheduler integration + side effects).
- [ ] Step F: complete Section 8 and 9 (schema hash plumbing + verifier marker).
- [ ] Step G: complete Section 10 (legacy cleanup).
- [ ] Step H: complete Section 11 (full test matrix).
- [ ] Step I: complete Section 12 and 13 (rollout/docs).

## 15. Open Items Tracked Separately

- [ ] Broader runner TODO: handlers and transaction lifecycle behavior when
      transactions are later aborted (tracked independently from CFC project).
