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
- [x] Legacy classification-only compatibility paths are removable.
- [x] Handler side effects are commit-gated: queue first, flush after success.
- [x] Retry semantics stay at CAS/conflict level in spec (implementation can map
      concrete errors internally).
- [-] Causal-ID storage and direct hash-addressed CAS remain parallel paths
      with independent IFC checks; neither path may bypass the other's access
      rules.
- [x] Less-restrictive schema flow-precision claims are advisory unless the
      executing implementation identity (`CodeHash` or `Builtin(name)`) is
      trusted for concept
      `https://commonfabric.org/cfc/concepts/flow-taint-precision`.
- [x] Concept-valued integrity guards are evaluated from concrete integrity
      against the acting principal's trust closure; runner must not require
      derived concept atoms to be persisted on stored values.

### 0.2 Phase-1 Schema Policy (Explicit)

- [x] Full write-time JSON Schema validation is deferred.
- [x] Commit-bearing CFC writes must persist `cfc.schemaHash`.
- [x] Commit-bearing CFC writes must persist/update `cfc.labels`.
- [x] Commit gate rejects CFC-relevant writes when schema hash cannot be
      resolved.
- [x] For existing entities, schema hash is immutable by default unless
      explicit migration flow is used.
- [x] Prepare/check uses the exact schema identified by `cfc.schemaHash`.
- [-] Full write-time schema validation is tracked as a later strict pass.

### 0.3 Non-Goals for This Pass

- [-] Full schema migration orchestration UX.
- [-] Full policy distribution/discovery protocol redesign.
- [-] Replacement of all runner transaction lifecycle TODOs unrelated to CFC.

## 1. Architecture Baseline and Design Lock

### 1.1 Current-State Audit (Code)

- [x] Confirm current commit-bearing tx creation points:
      `packages/runner/src/scheduler.ts`.
- [x] Confirm dependency-discovery tx points (must be excluded from CFC commit
      semantics): `collectDependenciesForAction` flow.
- [x] Confirm journal activity shape and metadata propagation:
      `packages/runner/src/storage/transaction/journal.ts`.
- [x] Confirm current read metadata markers and scheduling behavior:
      `packages/runner/src/scheduler.ts`.
- [x] Confirm existing schema/transform traversal entry points:
      `packages/runner/src/schema.ts`,
      `packages/runner/src/traverse.ts`,
      `packages/runner/src/cell.ts`.

### 1.2 Design Decisions to Lock in Code Comments/Types

- [x] Define `CfcTxState` type (relevance, preparation, digest, outbox).
- [x] Define `prepareBoundaryCommit` contract shape.
- [x] Define `internalVerifierRead` metadata marker key and semantics.
- [x] Define `AttemptedWrite` canonical shape used by verifier.
- [x] Define `PreparedDigestInput` and stable hash strategy.
- [x] Define implementation-identity derivation for trust gates:
      `CodeHash` for code modules and `Builtin(name)` for runtime built-ins.
- [x] Define `TrustContextSnapshot` / stable trust-context hash used by
      boundary evaluation (verifier delegations, trusted statements, optional
      concept-order edges) for the acting principal.
- [x] Define integrity-guard matcher semantics: concept requirements are
      satisfied by concrete witnesses under acting-user trust closure, not by
      materialized concept atoms in stored labels.

### 1.3 Invariants (Must Hold)

- [x] No CFC-relevant commit-bearing attempt may succeed without prepare.
- [x] Prepare must be same-attempt (same tx journal, no stale reuse).
- [x] Any activity change after prepare invalidates preparation.
- [x] Side effects from handler/event sends must not escape before commit.
- [x] Retry uses fresh tx and recomputes reads/writes/checks.
- [x] Boundary policy evaluation must be fail-closed: non-converged fixpoint
      (fuel exhaustion) rejects the attempt.
- [x] Confidentiality rewrites must use conjunctive declassification gates:
      release condition true, required integrity evidence present, trusted
      control scope present.
- [x] Guard evidence must come from evaluated value integrity (guard/result
      labels), not ambient control-integrity context alone.
- [x] Multi-atom confidentiality preconditions default to clause-local matching;
      cross-clause matching must be explicit.
- [x] Boundary prepare/policy evaluation is acting-principal scoped: the same
      concrete integrity may satisfy a concept guard for one user and not for
      another.
- [x] Rewriting one confidentiality clause must not authorize unrelated clauses;
      in particular, releasing `User(A)` does not release independent
      `User(B)` / owner clauses without their own policy path.
- [x] When a schema flow-precision claim would be less restrictive than
      conservative propagation, runtime must trust-gate by
      `https://commonfabric.org/cfc/concepts/flow-taint-precision` and
      otherwise fail closed to conservative labels.
- [x] Legacy `KeyLocalShapePreserved` / `KeyLocalWriteDependency` map
      precision is trust-gated and fail-closed when untrusted.
- [x] Align flow-precision claim handling to spec
      `PointwisePresencePreserved` / `PointwiseWriteDependency`.
- [-] Direct CAS reads must be label-gated (`hash + expectedLabel` + caller
      readability), not hash-knowledge gated.
- [-] Direct CAS miss outcomes (absent hash, label mismatch, unreadable label)
      must be externally indistinguishable.

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

- [x] Define deterministic digest input fields:
      canonical reads, attempted writes, internal flags.
- [x] Exclude unstable fields (timestamps/non-deterministic IDs unless needed).
- [x] Use stable serialization before hashing.
- [x] Include tx identity scope and trust-context snapshot in digest input used
      for flow-precision trust decisions (`CodeHash` / `Builtin(name)` identity
      + acting-principal trust-context hash).

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

- [x] When read resolves through link/doc context with effective label
      constraints, mark tx CFC-relevant.
- [x] Ensure detection occurs after schema/label accumulation across link hops.

### 4.3 Write-Path Trigger (Write-Only Actions)

- [x] In write APIs (`set`, `update`, `push`, diff/update path), mark tx
      relevant when target doc/path has IFC obligations even without reads.

### 4.4 Exclusions

- [x] Ensure non-commit-bearing dependency-collection tx does not trigger
      prepare requirement.
- [x] Ensure helper reads tagged as verifier/scheduling internals do not inflate
      consumed-input label checks.

### 4.5 Acceptance Criteria

- [x] Test: read through link with IFC schema marks tx relevant.
- [x] Test: read on plain schema/no labels does not mark relevant.
- [x] Test: write-only to labeled target marks relevant.
- [x] Test: dependency collection path does not require prepare.

## 5. Boundary Prepare Engine

Primary files:

- new CFC engine files under
  `packages/runner/src/cfc/`
- scheduler integration in
  `packages/runner/src/scheduler.ts`

### 5.1 Input Requirement Verification

- [x] Implement consumed-input label gathering from canonical reads.
- [x] Implement coherent `requiredIntegrity` verification for object-level
      annotations.
- [x] Implement concept-valued `requiredIntegrity` matching from available
      concrete integrity via acting-user trust closure.
- [x] Implement `maxConfidentiality` checks.
- [x] Respect same-attempt semantics only.

### 5.2 Output Transition Verification

- [x] Implement transition checks over attempted writes.
- [x] Support exact copy / projection checks where applicable.
- [x] Preserve no-op attempted writes in policy evaluation.
- [x] Support final-per-path view for rules that depend on final attempted
      value.
- [x] Evaluate `flowPrecisionClaim` annotations and derive both `L_claim` and
      conservative `L_default` for each affected output path.
- [x] If `L_claim` is less restrictive than `L_default`, require trust for
      concept `https://commonfabric.org/cfc/concepts/flow-taint-precision` on
      executing implementation identity (`CodeHash` or `Builtin(name)`);
      otherwise use `L_default`.
- [x] Validate legacy map-like claim semantics (`KeyLocalShapePreserved`,
      `KeyLocalWriteDependency`) before applying claim-derived precision.
- [x] Rename and align claim parsing/validation to
      `PointwisePresencePreserved` / `PointwiseWriteDependency`.
- [x] Extend collection-structure handling for prefix-sensitive built-ins
      (`filter`, `flatMap`) so membership/domain, order/offset, and
      multiplicity can be tainted independently.
- [x] Treat missing/unknown implementation identity as untrusted and fall back
      to conservative labels (fail closed for trust-sensitive claims).
- [x] Resolve `CodeHash(...)` / `Builtin(name)` flow-precision trust from the
      acting principal's trust context; do not hardcode a global builtin
      allowlist.
- [x] Implement flow-precision evaluation in
      `packages/runner/src/cfc/prepare-engine.ts` by extending
      `verifyOutputTransitionsForAttempt` to compute default/claimed labels
      before write-label persistence.
- [x] Add explicit claim parser/validator helper under
      `packages/runner/src/cfc/` (for example `flow-precision.ts`) so schema
      decoding and verification checks stay separate from policy evaluation.

### 5.3 State-Dependent Preconditions (7.5.3)

- [x] Add same-attempt read precondition protocol enforcement.
- [x] Require state predicate check before write commit eligibility.
- [x] Reject attempt when required read/predicate is missing/fails.

### 5.4 Label + SchemaHash Persistence in Prepare

- [x] Compute new effective labels for outputs/writes.
- [x] Resolve schema to canonical bytes and compute hash.
- [x] Write `cfc.schemaHash` and `cfc.labels` as part of prepare path.
- [x] Persist concrete integrity evidence only; do not materialize
      trust-closure-derived concept atoms into stored labels.
- [x] Ensure prepare fails if schema hash cannot be resolved.

### 5.5 Prepare Outcome Handling

- [x] On success: set `cfcPrepared=true` and store digest.
- [x] On failure: abort attempt tx and return typed boundary error.
- [x] Ensure failure does not emit side effects.

### 5.6 Policy Evaluation Semantics Lock

- [x] In declassification/exchange guard checks, require release condition to be
      true before confidentiality rewrite.
- [x] Keep control-integrity (`pcI`) as control-only context; do not auto-inject
      ambient `pcI` tokens into value integrity labels.
- [x] Implement policy precondition scope default as clause-local
      (`preConfScope = targetClause`) with explicit opt-in for global
      (`anywhere`) matching.
- [x] Return explicit non-convergence signal from bounded policy fixpoint
      evaluation and reject boundary attempt on that signal.
- [x] Match concept-valued integrity preconditions against available concrete
      integrity using the acting principal's trust closure.
- [x] Bind prepare success to the acting principal + trust-context snapshot used
      for evaluation; if that snapshot changes before commit, invalidate
      preparation.
- [x] Enforce clause-local release semantics across confidentiality CNF; do not
      add any "any one authorizer unlocks all clauses" shortcut.
- [x] Apply trusted flow-precision gate:
      less-restrictive claim labels require trust in concept
      `https://commonfabric.org/cfc/concepts/flow-taint-precision`; untrusted
      paths fail closed to conservative labels.

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
- [x] Pass acting principal + trust-context snapshot into prepare evaluation.
- [x] Keep existing commit retry loop behavior where applicable.
- [x] On retryable commit failure, ensure fresh tx reruns action and prepare.
- [x] Ensure retryable reruns use a fresh trust-context snapshot.

### 6.2 Event Handler Path

- [x] Insert prepare step before commit in event execution flow.
- [x] Preserve existing requeue retry behavior for retryable failures.
- [x] Ensure no stale prepare state survives into requeued attempt.
- [x] Re-evaluate concept guards using the requeued attempt's acting principal +
      trust-context snapshot.

### 6.3 Error Classification

- [x] Map commit failures into retryable vs terminal classes.
- [x] Treat CAS/conflict/inconsistency as retryable in implementation.
- [x] Treat prepare-gate failures as terminal unless policy says otherwise.
- [x] Treat policy non-convergence/fuel exhaustion as terminal boundary failure
      (fail closed), not retryable-without-new-input.

### 6.4 Acceptance Criteria

- [x] Test: retryable failure causes fresh attempt and re-prepare.
- [x] Test: non-retryable failure does not loop.
- [x] Test: prepare-gate failure surfaces clear error.

### 6.5 Implementation Identity Plumbing (Flow-Precision Trust)

- [x] Extend scheduler/action metadata with execution identity and thread it
      into `commitWithCfcPrepare` and `prepareCfcCommitIfNeeded`.
- [x] In `packages/runner/src/runner.ts`, annotate wrapped actions/handlers
      with stable CFC implementation identity:
      code modules as `CodeHash(<hash>)`, built-ins as `Builtin(<moduleRef>)`.
- [x] Preserve builtin identity even for `module.type === "ref"` by carrying
      the registry ref through node instantiation metadata.
- [x] Extend `PrepareBoundaryCommitOptions` in
      `packages/runner/src/cfc/prepare-engine.ts` to accept identity + trust
      evaluator callback, so trust checks are deterministic and testable.
- [x] Add trust concept constant in runner CFC internals for
      `https://commonfabric.org/cfc/concepts/flow-taint-precision` and use it
      in both enforcement code and tests.
- [x] Add helper in `packages/runner/src/cfc/` for deriving identity strings
      from wrapped action metadata so prepare and tests share identical
      `CodeHash(...)` / `Builtin(...)` encoding rules.

### 6.6 Event Envelope + Once-Claim Foundation

- [x] Normalize queued scheduler events to an internal event envelope carrying
      stable `id`, raw `payload`, integrity evidence, and delivery mode.
- [x] Preserve backward compatibility by wrapping legacy raw events with fresh
      ephemeral ids instead of changing their delivery semantics.
- [x] Thread the current event envelope through handler transactions so trusted
      internals can derive prepare/claim behavior from event identity and
      integrity later.
- [x] Add once-per-handler delivery mode that derives a deterministic handled
      marker from `(eventId, handlerId)` and writes it through the normal
      transaction path.
- [x] Treat handled-marker conflicts as benign dedup for scheduler event
      delivery instead of retryable failure.

### 6.7 Semantic Intent Event Helpers

- [x] Add a runner-internal helper for deriving stable semantic `IntentEvent`
      ids from `(sourceGestureId, conditionHash, parameters)` using canonical
      hashing.
- [x] Add a runner-internal helper for building semantic intent-event
      envelopes with explicit integrity/evidence and default
      `once-per-handler` delivery.
- [x] Keep semantic intent-event helpers layered on the existing envelope path
      instead of creating a parallel scheduler event mechanism.
- [x] Add tests for stable id derivation, event-envelope construction, and
      dedup of repeated semantic intent events queued to the same handler.

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
- [x] Cache resolved schema hashes per attempt for performance.

### 8.3 Existing Entity Rules

- [x] Read existing `cfc.schemaHash` when present.
- [x] Enforce immutability by default on existing entities.
- [x] Add explicit hook point for future migration mode.

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

- [x] Inventory classification-only legacy branches.
- [x] Confirm no tests depend on removed paths.

### 10.2 Remove/Refactor

- [x] Remove unused compatibility translation code.
- [x] Keep needed schema traversal helpers not tied to legacy mode.
- [x] Update typing/docs to remove legacy mentions.

### 10.3 Acceptance Criteria

- [x] Existing non-CFC tests still pass.
- [x] No references to removed legacy path remain.

## 11. Test Plan (Detailed Matrix)

Primary test location:

- `packages/runner/test/`

### 11.1 Commit Gate Tests

- [x] `cfc-commit-gate-rejects-without-prepare.test.ts`
- [x] `cfc-commit-gate-rejects-on-digest-mismatch.test.ts`
- [x] `cfc-commit-gate-allows-prepared-unchanged.test.ts`

### 11.2 Relevance Detection Tests

- [x] `cfc-relevance-from-ifc-schema-read.test.ts`
- [x] `cfc-relevance-from-effective-label-read.test.ts`
- [x] `cfc-relevance-from-write-target-label.test.ts`
- [x] `cfc-no-relevance-for-dependency-collection.test.ts`

### 11.3 Activity Canonicalization Tests

- [x] `cfc-canonicalize-strip-value-prefix.test.ts`
- [x] `cfc-attempted-write-order.test.ts`
- [x] `cfc-final-write-last-wins.test.ts`
- [x] `cfc-noop-attempted-write-included.test.ts`

### 11.4 Boundary Prepare Tests

- [x] `cfc-input-required-integrity-fail.test.ts`
- [x] `cfc-output-transition-fail.test.ts`
- [x] `cfc-state-precondition-read-required.test.ts`
- [x] `cfc-state-precondition-predicate-required.test.ts`
- [x] `cfc-prepare-persists-schemahash-and-labels.test.ts`
- [x] `cfc-policy-fixpoint-fuel-exhaustion-fail-closed.test.ts`
- [x] `cfc-declassify-guard-false-no-rewrite.test.ts`
- [x] `cfc-declassify-ambient-pci-token-not-sufficient.test.ts`
- [x] `cfc-policy-preconf-target-clause-default.test.ts`
- [x] `cfc-policy-preconf-anywhere-opt-in.test.ts`
- [x] `cfc-exchange-ambient-pci-token-not-sufficient.test.ts`
- [x] `cfc-flow-precision.test.ts` covers untrusted less-restrictive fallback
      to conservative flow.
- [x] `cfc-flow-precision.test.ts` covers trusted builtin less-restrictive
      claims using claimed precision.
- [x] `cfc-flow-precision.test.ts` covers not-less-restrictive claims without
      trust.
- [x] Add explicit `PointwisePresencePreserved` regression coverage.
- [x] `cfc-flow-precision.test.ts` covers malformed/missing
      `KeyLocalWriteDependency` fallback.
- [x] Add explicit `PointwiseWriteDependency` regression coverage.
- [x] `cfc-scheduler-prepare-shim.test.ts` covers builtin identity propagation
      through scheduler prepare.
- [x] `cfc-flow-precision.test.ts` covers untrusted custom builtin-name
      overrides falling back conservative.
- [x] `cfc-required-integrity-concept-satisfied-via-trust-closure.test.ts`
- [x] `cfc-required-integrity-concept-differs-by-acting-user.test.ts`
- [x] `cfc-policy-concept-guard-does-not-require-materialized-concept-atom.test.ts`
- [x] `cfc-clause-local-release-does-not-release-other-user-clause.test.ts`
- [x] `cfc-trust-context-change-invalidates-prepare.test.ts`
- [x] `cfc-flow-precision.test.ts` covers builtin trust resolution from the
      acting principal's trust context, including fail-closed behavior without a
      trusted statement.
- [x] `cfc-filter-membership-vs-order-precision.test.ts`
- [x] `cfc-flatmap-multiplicity-vs-content-precision.test.ts`

### 11.5 Side-Effect Gating Tests

- [x] `cfc-event-not-emitted-on-failed-commit.test.ts`
- [x] `cfc-event-emitted-after-successful-commit.test.ts`
- [x] `cfc-event-order-preserved.test.ts`
- [x] `cfc-retry-emits-once.test.ts`
- [x] `cfc-event-envelope.test.ts` covers current-event tx context, explicit
      once-per-handler dedup, and unchanged legacy raw-event behavior.

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
- [x] Add a smoke benchmark around prepare overhead in reactive loops.

### 11.9 Direct CAS + Dual-Path Safety Tests (Deferred)

- [-] `cfc-cas-write-appends-effective-label-binding.test.ts`
- [-] `cfc-cas-write-failed-boundary-check-does-not-append-binding.test.ts`
- [-] `cfc-cas-read-requires-expected-label-match.test.ts`
- [-] `cfc-cas-read-unreadable-binding-returns-not-found.test.ts`
- [-] `cfc-cas-read-absent-vs-unreadable-indistinguishable.test.ts`
- [-] `cfc-cas-low-write-does-not-overwrite-stronger-binding.test.ts`
- [-] `cfc-causal-and-cas-no-bypass.test.ts`

## 12. Rollout and Guardrails

### 12.1 Feature Flagging

- [x] Add runtime feature flag for staged enablement (if needed).
- [-] Start with CI-on, production-off mode if runtime supports staged rollout.

### 12.2 Observability

- [x] Add debug counters:
      `cfcRelevantTx`, `cfcPreparedTx`, `cfcGateRejects`, `cfcOutboxFlushes`.
- [x] Add structured logs for rejection reasons.
- [x] Ensure sensitive values are not logged.

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

- [x] Add runner-internal design note for prepare-before-commit.
- [x] Add lifecycle doc for tx outbox and flush behavior.
- [x] Document internal verifier read marker.
- [x] Document internal event envelope and once-claim lifecycle for
      event-handler transactions.

### 13.2 Spec Cross-Check

- [x] Confirm implementation aligns with attempted-write semantics.
- [x] Confirm fixed `/value` stripping behavior is reflected.
- [x] Confirm state-precondition same-attempt rule coverage.
- [x] Confirm schemaHash persistence policy is represented.
- [x] Confirm declassification gate is conjunctive (condition true + evidence +
      trusted control).
- [x] Confirm ambient control-integrity tokens are not treated as value evidence.
- [x] Confirm policy side-condition scope defaults to clause-local matching.
- [x] Confirm bounded fixpoint evaluation rejects on non-convergence.
- [x] Confirm runner tests cover guard-false, ambient-token-smuggling, and
      cross-clause-mixing attack shapes.
- [x] Confirm concept-valued integrity guards are evaluated from concrete
      integrity via acting-principal trust closure.
- [x] Confirm concrete integrity is persisted; derived concept satisfaction is
      boundary-evaluated and not serialized into stored labels.
- [x] Confirm the same concrete evidence may satisfy concept guards for one
      acting principal and fail for another.
- [x] Confirm clause-local release semantics prevent `User(A)` rewrites from
      implicitly authorizing independent `User(B)` / owner clauses.
- [x] Confirm flow-precision claims are trust-gated by concept
      `https://commonfabric.org/cfc/concepts/flow-taint-precision` with
      conservative fallback when untrusted.
- [x] Confirm spec-aligned `PointwisePresencePreserved` /
      `PointwiseWriteDependency` replace legacy `KeyLocal*` claim parsing.
- [x] Confirm prefix-sensitive built-ins (`filter`, `flatMap`) taint
      membership/domain independently from order/offset/multiplicity.
- [x] Confirm builtin modules can make trusted flow-precision claims via
      `Builtin(name)` identity and share the same trust gate semantics as
      `CodeHash`.
- [x] Confirm internal semantic events carry stable ids and integrity metadata
      without changing legacy raw scheduler event semantics.
- [x] Confirm once-per-handler event consumption can be expressed as ordinary
      tx conflict/CAS on a derived handled marker.
- [-] Confirm direct CAS writes append boundary-computed effective labels only.
- [-] Confirm direct CAS reads require exact `expectedLabel` match plus
      principal readability.
- [-] Confirm direct CAS miss normalization for absent hash vs label mismatch vs
      unreadable binding.
- [-] Confirm parallel causal/CAS stores do not bypass one another's access
      control rules.

## 14. Execution Order (Recommended)

- [x] Step A: complete Section 2 (transaction model extensions).
- [x] Step B: complete Section 3 (canonical activity + digest).
- [x] Step C: complete Section 4 (relevance detection).
- [x] Step D: complete Section 5 (prepare engine).
- [x] Step E: complete Section 6 and 7 (scheduler integration + side effects).
- [x] Step F: complete Section 8 and 9 (schema hash plumbing + verifier marker).
- [x] Step G: complete Section 10 (legacy cleanup).
- [x] Step H: complete Section 11 (full test matrix).
- [x] Step I: complete Section 12 and 13 (rollout/docs) for baseline CFC work.
- [x] Step J: complete acting-principal trust-closure + flow-precision
      additions in Sections 1, 3, 5, 6, 11, and 13.
- [x] Step J.1: add event-envelope + once-claim foundation for later
      `IntentEvent` / `IntentOnce` work without yet introducing sink commit
      points.
- [x] Step J.2: add semantic `IntentEvent` helpers on top of event envelopes
      so later trusted UI/runtime code can mint stable intent events without
      further scheduler changes.
- [-] Step K: complete Section 15 (direct CAS + dual-path safety).
- [x] Step L: re-run Section 12 and 13 cross-check after Step J/K.

## 15. Direct CAS + Dual-Path Safety (Chapter 17, Deferred)

Primary files:

- `packages/runner/src/storage/interface.ts`
- `packages/runner/src/storage/extended-storage-transaction.ts`
- `packages/runner/src/cfc/`
- `packages/runner/src/storage/`

### 15.1 Direct CAS Write Path

- [-] Add write contract for direct CAS that accepts payload bytes plus proposed
      label context.
- [-] Route direct CAS writes through trusted boundary evaluation to compute
      effective write label (caller-provided label is request, not authority).
- [-] Canonicalize + hash payload bytes before storage.
- [-] Persist immutable payload by hash and append (never overwrite)
      `LabelBinding{label: effectiveLabel}`.
- [-] On IFC/policy rejection, fail write without appending label binding.

### 15.2 Direct CAS Read Path

- [-] Add read contract that requires `blobHash` and `expectedLabel`.
- [-] Return bytes only when a stored binding exactly matches `expectedLabel`
      and caller principal can access that label.
- [-] Return normalized not-found for all non-authorized/non-matching cases.

### 15.3 Miss Indistinguishability and Side-Channel Hygiene

- [-] Normalize external status code/class across absent hash, label mismatch,
      and unreadable label.
- [-] Normalize response body shape across miss cases.
- [-] Normalize timing envelope within configured bounds for miss cases.
- [-] Keep internal diagnostics reasoned, but do not leak miss cause via
      external API/log surface.

### 15.4 Parallel-Store Non-Bypass Rules

- [-] Enforce that causal-ID reads/writes continue to use causal-path
      authorization rules only.
- [-] Enforce that direct CAS reads/writes continue to use hash+label-binding
      rules only.
- [-] Prevent implicit fallback from one path into the other for authorization
      decisions.
- [-] Ensure low-trust writes to an existing hash only add low-trust bindings
      and cannot overwrite/remove stronger bindings.

### 15.5 Acceptance Criteria

- [-] Unit tests from Section 11.9 pass for direct CAS and dual-path cases.
- [-] Existing causal-ID behavior is unchanged by enabling direct CAS path.

## 16. Open Items Tracked Separately

- [-] Broader runner TODO: handlers and transaction lifecycle behavior when
      transactions are later aborted (tracked independently from CFC project).
- [-] Runtime-trust domain enforcement phase:
      attestation evidence ingestion, principal-scoped trust-set evaluation,
      and domain-confinement policy checks (device-locked vs CC-locked data).
