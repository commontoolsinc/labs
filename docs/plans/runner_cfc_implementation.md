# CFC Runner Implementation Plan

This document is the current plan for adding commit-boundary Contextual Flow
Control (CFC) enforcement to `packages/runner`.

It is intentionally self-contained. It describes:

- the target behavior
- the current baseline in this checkout
- the data model we will implement
- the workstreams, files, and acceptance criteria
- the rollout sequence

## Goal

Move from today's schema-guided IFC propagation and coarse label facts to a
runner that enforces CFC at commit time.

At the end of this work:

- schema `ifc` annotations will be enforced before a commit succeeds
- CFC-relevant writes will persist authoritative metadata for later checks
- external side effects will be gated on successful commit
- trust-sensitive relaxations will be explicit, deterministic, and fail closed

Phase 1 targets the memory-v2 transaction path first. Legacy v1 compatibility
can remain on the existing coarse-label behavior until the v2 boundary model is
stable.

## Current Baseline

The current tree already has useful foundations:

- `packages/runner/src/cfc.ts` resolves schema refs, walks `ifc` annotations,
  and computes coarse classification joins
- `packages/runner/src/schema.ts`, `packages/runner/src/traverse.ts`, and
  `packages/runner/src/cell.ts` already carry schema context through reads,
  links, projections, and materialization
- `docs/specs/json_schema.md` defines `ifc` as a schema extension
- `docs/specs/verifiable-execution/06-cfc-and-trust.md` defines today's coarse
  `Labels.classification` and the future path-granular label-map direction
- `docs/specs/ts-transformer/cfc_authoring_contract.md` already reserves richer
  `ifc` keys such as `integrity`, `addIntegrity`, `requiredIntegrity`,
  `maxConfidentiality`, `writeAuthorizedBy`, `projection`, and collection rules
- `packages/runner/src/storage/interface.ts` exposes coarse `StorageValue.labels`
  with `classification?: string[]`
- `packages/runner/src/storage/cache.ts` already persists
  `application/label+json` facts in the v1 path and uses schema-derived
  classification to shape remote queries
- `packages/runner/src/storage/transaction/journal.ts` already records ordered
  read and write activity with metadata
- `packages/runner/src/storage/reactivity-log.ts` already distinguishes
  scheduler-only reads via metadata markers such as `ignoreReadForScheduling`
- `packages/runner/src/storage/extended-storage-transaction.ts` already has a
  wrapper transaction seam and commit callbacks
- `packages/runner/src/storage/v2-transaction.ts` already tracks richer internal
  write state (`writeDetails`, `patchDetails`, native commit operations) that we
  can expose as dedicated v2 CFC extraction APIs instead of reconstructing
  everything from legacy journal activity
- `packages/runner/src/cell.ts`, `packages/runner/src/scheduler.ts`, and
  `packages/runner/src/builtins/fetch-data.ts` already expose places where
  side effects and post-commit hooks can be centralized

What is missing is the actual boundary substrate:

- there is no transaction-level CFC state
- there is no prepare-before-commit step
- there is no canonical digest of consumed reads and attempted writes
- there is no authoritative persisted CFC metadata record per entity
- there is no trust snapshot threaded through boundary evaluation
- side effects are not uniformly gated on successful commit

## Terms

### Schema IFC Metadata

This plan treats schema `ifc` as the only declaration surface. The runner will
support these keys in phases:

- `classification`
- `integrity`
- `addIntegrity`
- `requiredIntegrity`
- `maxConfidentiality`
- `writeAuthorizedBy`
- `exactCopyOf`
- `projection`
- `collection`

### CFC-Relevant Transaction

A transaction is CFC-relevant when at least one consumed read or attempted
write touches data whose effective schema or stored CFC metadata carries IFC
constraints.

### Consumed Read

A consumed read is a read that contributes to boundary checking for the current
attempt. It is derived from transaction inspection APIs and excludes
verifier-internal reads. Scheduler-only metadata and CFC metadata must remain
separate concerns.

### Canonical Write Set

The ideal high-precision model records ordered attempted writes before
last-write-wins compaction.

Phase 1 does not require that precision. It uses a deterministic final-per-path
write set sourced from v2 transaction internals and may pessimistically treat
all consumed reads as influencing all final writes. If later rules need
per-write provenance or exact attempt order, we can add dedicated write-attempt
logging as a follow-on precision optimization.

### Prepare

Prepare is the deterministic boundary check that runs after the user action or
handler has produced its reads and writes but before commit succeeds.

Prepare:

- gathers consumed reads and canonical writes
- evaluates schema and policy obligations
- computes output labels and metadata
- records a digest of exactly what was checked

### Prepared Digest

The prepared digest is a stable hash of:

- canonical consumed reads
- canonical writes
- implementation identity
- trust snapshot identity

Any change to that material invalidates preparation.

### Implementation Identity

Every trust-sensitive check uses an explicit implementation identity:

- a stable, policy-facing code identity for verified compiled modules and
  handlers
- `Builtin(<name-or-ref>)` for runtime built-ins

`implementationRef` remains the runtime lookup key for executable functions, and
`verifiedLoadId` remains the runtime admission scope. The boundary evaluator
reuses the verified-load registry for execution provenance, while policy
references resolve against a separate stable code identity derived from one of:

- verified compiled code: bundle identity + canonical binding locator within the
  verified bundle
- built-ins: canonical runtime-owned registry ids

Phase 1 does not require stable policy identities for direct-eval or
unsafe-host/test helpers. Those paths are treated as untrusted for
trust-sensitive relaxations unless a later explicit stable-id path is added.

### Trust Snapshot

A trust snapshot is the acting-principal-scoped view of the trust graph used by
the boundary evaluator. Trust-sensitive relaxations must depend on this
snapshot, not on ambient mutable state.

## Storage Model

For memory-v2, the runner needs an authoritative CFC metadata record embedded in
the single entity document. Legacy v1 coarse label facts remain as compatibility
behavior until parity work lands.

### Embedded Metadata

Introduce a system-owned reserved sibling to `value` and `source` for each
entity:

```ts
type CfcMetadata = {
  version: 1;
  schemaHash: string;
  labelMap: {
    entries: Array<{
      path: string[];
      confidentiality?: unknown[];
      integrity?: unknown[];
    }>;
  };
  summary: {
    classification?: string[];
  };
};

type EntityDocumentWithCfc = {
  value?: unknown;
  source?: unknown;
  cfc?: CfcMetadata;
};
```

Storage rules:

- in memory-v2, the reserved `cfc` sibling is authoritative for boundary checks
  once present
- the v2 `cfc` sibling stores the authoritative label map, summary labels, and
  `schemaHash` in the same document as `value` and `source`
- ordinary `application/json` reads and materialized values must strip the
  reserved `cfc` sibling
- v1 may continue using `application/label+json` as legacy compatibility
  behavior, but phase 1 does not block on reproducing that MIME-based shape in
  v2

### Path Canonicalization

The canonical logical path format is `string[]` with the wrapper segment
`"value"` stripped. Root is `[]`.

When we need deterministic hashing or ordering, encode that canonical path as a
JSON Pointer string derived from the segment array.

### Schema Hash

Use the existing schema hashing infrastructure for canonical schema identity.

`schemaHash` is the hash of the canonical merged schema envelope for the entity,
not the hash of any one effective selector schema seen during prepare.

### Merged Schema Envelope

The runner needs a proper merge implementation for the supported schema subset.
This is not general JSON-Schema merge; it is a canonical merge for the
IFC-relevant structural subset that preserves compatibility with already-stored
data.

Phase-1 merge rules:

- IFC keys such as `classification`, `integrity`, `addIntegrity`,
  `requiredIntegrity`, `maxConfidentiality`, `writeAuthorizedBy`,
  `exactCopyOf`, `projection`, and `collection` may stay the same or become
  stricter, but must never be weakened
- IFC keys must live at the same node as `anyOf`/`oneOf`/`allOf`, not inside
  divergent branches; we do not support different label sets per branch
- the merged schema must not invalidate data that was previously structurally
  valid
- a merge may add a required field only when the merged schema also provides a
  default that preserves validity/materialization for existing documents
- every merged result is canonicalized with the frozen/interned schema helpers
  before hashing

Phase-1 behavior:

- compute the current effective schema at prepare time
- merge it monotonically into the stored entity envelope when possible
- persist the envelope hash in `schemaHash`
- reject only when the current schema cannot be merged with the stored envelope
  without weakening IFC obligations or invalidating previously valid data,
  unless an explicit migration path is active

This keeps schema identity stable without pretending that all reads and writes
share one exact selector schema.

## Non-Goals

This plan does not attempt to do all of the following in the first landing:

- full write-time JSON Schema validation unrelated to CFC
- general policy distribution or discovery protocols
- broad UI authoring ergonomics beyond the provenance hooks needed for trusted
  events
- a generalized direct-CAS security model before the core causal path is stable
- a wholesale rewrite of scheduler or runtime architecture

## Invariants

These must hold once enforcement is enabled:

- no CFC-relevant commit succeeds without a same-attempt prepare
- any read or write that changes the prepared digest invalidates prepare
- verifier-internal reads never become consumed reads
- explicit IFC claims fail closed on missing schema, missing metadata, unknown
  trust state, or unsupported trust-sensitive claims
- external side effects happen only after successful commit
- retries always run in a fresh transaction and recompute prepare
- persisted CFC metadata is system-controlled, not user-editable JSON content
- `Labels.classification` remains a coarse summary, not the authoritative
  policy model
- unlabeled paths remain permissive in phase 1; changing that default is a
  separate rollout step, not an implicit side effect of the first enforcement
  launch

## Workstreams

### 1. Contract and Types

Primary files:

- `packages/runner/src/storage/interface.ts`
- `packages/runner/src/storage/extended-storage-transaction.ts`
- new files under `packages/runner/src/cfc/`

Tasks:

- [ ] Define `CfcTxState`, `ConsumedRead`, `AttemptedWrite`,
      `PreparedDigestInput`, `ImplementationIdentity`, `TrustSnapshot`,
      `CfcEnforcementMode`, and `CfcMetadata`
- [ ] Define a dedicated metadata marker for `internalVerifierRead`
- [ ] Define a dedicated side-effect outbox entry type for post-commit effects
- [ ] Define the system metadata MIME/type used for the CFC side record
- [ ] Define a canonical code-identity shape that separates policy-facing code
      identity from per-load runtime ids

Acceptance:

- [ ] New types compile without changing behavior
- [ ] Serialization tests cover `CfcMetadata` and digest input canonicalization

### 2. Transaction State and Commit Gate

Primary files:

- `packages/runner/src/storage/interface.ts`
- `packages/runner/src/storage/extended-storage-transaction.ts`
- `packages/runner/src/storage/transaction.ts`
- `packages/runner/src/storage/v2-transaction.ts`

Tasks:

- [ ] Add CFC state to the extended transaction wrapper:
      relevance, preparation status, prepared digest, trust snapshot, outbox,
      and enforcement mode
- [ ] Add helpers to mark a transaction relevant, prepared, invalidated, and to
      enqueue post-commit side effects
- [ ] Support rollout modes:
      `disabled`, `observe`, `enforce-explicit`, and `enforce-strict`
- [ ] In `observe`, compute prepare state and diagnostics without blocking
- [ ] In enforcing modes, enforce `relevant -> prepared` at commit
- [ ] Recompute the digest immediately before commit and reject on mismatch
- [ ] Reset CFC state on abort and on retry

Acceptance:

- [ ] Observe mode records prepare state without blocking commit
- [ ] Relevant transaction without prepare fails commit in enforcing modes
- [ ] Prepared transaction with unchanged activity commits successfully
- [ ] Post-prepare read or write invalidates prepare
- [ ] Abort clears outbox state

### 3. Canonical Activity Extraction

Primary files:

- `packages/runner/src/storage/interface.ts`
- `packages/runner/src/storage/v2-transaction.ts`
- `packages/runner/src/storage/transaction-inspection.ts`
- `packages/runner/src/storage/reactivity-log.ts`
- new files under `packages/runner/src/cfc/`

Tasks:

- [ ] Build a canonical extractor over the v2 inspection APIs
- [ ] Produce a deterministic final-per-path write set for phase 1
- [ ] Preserve write no-op information when cheaply available
- [ ] Keep scheduler metadata and verifier metadata distinct
- [ ] Exclude only `internalVerifierRead` from the consumed-read set
- [ ] Make the phase-1 prepare engine free to pessimistically treat all consumed
      reads as influencing all final writes
- [ ] Defer exact ordered write-attempt logging to a follow-up precision slice if
      later rules need it

Acceptance:

- [ ] Canonical path handling strips the `value` wrapper consistently
- [ ] Phase-1 canonical write extraction is deterministic across runs
- [ ] Internal verifier reads remain visible for diagnostics but not policy
- [ ] Final-per-path view is deterministic

### 4. Relevance Detection

Primary files:

- `packages/runner/src/schema.ts`
- `packages/runner/src/traverse.ts`
- `packages/runner/src/cell.ts`
- `packages/runner/src/link-utils.ts`

Tasks:

- [ ] Mark a transaction relevant when traversal encounters schema `ifc`
- [ ] Mark a transaction relevant when existing stored CFC metadata applies to a
      consumed read
- [ ] Mark write-only transactions relevant when the target path carries CFC
      obligations even if no read happened first
- [ ] Ensure dependency-discovery transactions do not trigger prepare
- [ ] Audit helper reads that should be tagged `internalVerifierRead`

Acceptance:

- [ ] Reading a path with `ifc` marks the transaction relevant
- [ ] Reading unlabeled plain data does not mark it relevant
- [ ] Writing to a path with stored or schema-derived CFC metadata marks it
      relevant
- [ ] Dependency-collection transactions remain unaffected

### 5. Metadata Persistence

Primary files:

- `packages/runner/src/storage/v2.ts`
- `packages/runner/src/storage/v2-document.ts`
- `packages/memory/v2.ts`
- `packages/runner/src/storage/interface.ts`
- legacy follow-up: `packages/runner/src/storage/cache.ts`,
  `packages/memory/space.ts`, `packages/memory/provider.ts`

Tasks:

- [ ] Persist CFC metadata as a system-owned reserved sibling to `value` and
      `source` in the v2 entity document
- [ ] Store the authoritative label map, summary labels, and `schemaHash` in
      that embedded metadata
- [ ] Ensure normal user-doc reads do not expose the reserved `cfc` sibling
- [ ] Make storage helpers able to read current CFC metadata efficiently during
      prepare
- [ ] Keep v1 `application/label+json` compatibility as follow-up work; do not
      block phase 1 on v1 parity

Acceptance:

- [ ] A successful prepared write persists embedded CFC metadata in the v2
      document
- [ ] Existing reads of `application/json` do not surface the reserved `cfc`
      sibling
- [ ] Stored envelope incompatibility rejects later writes unless migration is on

### 6. Prepare Engine

Primary files:

- new files under `packages/runner/src/cfc/`
- `packages/runner/src/schema.ts`
- `packages/runner/src/traverse.ts`

Tasks:

- [ ] Build `prepareBoundaryCommit(tx, options)` as a pure, deterministic
      evaluator
- [ ] Implement a canonical merged-schema envelope operator for the supported
      subset
- [ ] Ensure IFC keys never weaken under merge and never appear only inside a
      divergent `anyOf`/`oneOf`/`allOf` branch
- [ ] Ensure structural merge does not invalidate previously valid data; adding
      a required field requires a default
- [ ] Resolve input labels from stored CFC metadata first, then fall back to
      coarse labels and schema-derived compatibility behavior
- [ ] Implement `classification`, `integrity`, `addIntegrity`,
      `requiredIntegrity`, and `maxConfidentiality`
- [ ] Implement `writeAuthorizedBy`, `exactCopyOf`, `projection`, and
      collection-derived transition checks where they can be evaluated from
      consumed reads plus final writes; otherwise fail closed or remain
      conservative
- [ ] Compute output label maps and the coarse summary classification
- [ ] Persist only concrete evidence in stored labels; derived trust closure
      remains runtime-only
- [ ] In phase 1, allow a conservative all-consumed-reads-to-all-final-writes
      influence model
- [ ] Reject on missing schema, missing metadata needed for a check, or any
      unsupported trust-sensitive claim

Acceptance:

- [ ] Required-integrity failures reject before commit
- [ ] Transition failures reject before commit
- [ ] Successful prepare writes stable merged-envelope `schemaHash` and label
      map metadata
- [ ] Unsupported or malformed trust-sensitive claims fail closed

### 7. Scheduler, Retry, and Side-Effect Gating

Primary files:

- `packages/runner/src/scheduler.ts`
- `packages/runner/src/cell.ts`
- `packages/runner/src/runner.ts`
- `packages/runner/src/storage/extended-storage-transaction.ts`

Tasks:

- [ ] Insert prepare between action/handler execution and commit
- [ ] Replace effectful use of generic commit callbacks with a success-only
      outbox
- [ ] Migrate stream sends, queued events, and other runner-managed side effects
      to the outbox
- [ ] Keep retries fresh: new tx, new prepare, new trust snapshot
- [ ] Audit `onCommit` call sites and move effectful ones to the outbox

Acceptance:

- [ ] Failed commit does not emit side effects
- [ ] Retried handler emits side effects once, after the winning commit
- [ ] Non-effectful commit callbacks used for diagnostics still work

### 8. Implementation Identity and Trust

Primary files:

- `packages/runner/src/runner.ts`
- `packages/runner/src/builder/module.ts`
- `packages/runner/src/builder/json-utils.ts`
- `packages/runner/src/harness/executable-registry.ts`
- new files under `packages/runner/src/cfc/`

Tasks:

- [ ] Define a stable policy-facing code identity separate from runtime
      `implementationRef` and per-load `verifiedLoadId`
- [ ] Keep `implementationRef` as the runtime lookup key and `verifiedLoadId` as
      the runtime admission scope; resolve policy identities through the
      verified registry and built-in registry
- [ ] Derive verified compiled-code identity from verified bundle identity plus
      canonical binding location within the bundle
- [ ] Define canonical ids for built-ins
- [ ] In phase 1, treat direct-eval and unsafe-host/test helpers as untrusted
      for trust-sensitive relaxations unless a later explicit stable-id path is
      added
- [ ] Thread the resulting implementation identity through action and handler
      execution
- [ ] Define a trust-snapshot provider interface that is deterministic and easy
      to test
- [ ] Bind prepare success to the acting principal plus trust snapshot identity
- [ ] Gate trust-sensitive flow relaxations on that snapshot

Acceptance:

- [ ] Built-ins and verified compiled code produce stable policy-facing
      implementation identities
- [ ] Unsupported identity classes fail closed for trust-sensitive checks
- [ ] Changing the trust snapshot between prepare and commit invalidates prepare
- [ ] Unknown implementation identity is treated as untrusted

### 9. Flow-Precision and Structural Claims

Primary files:

- new files under `packages/runner/src/cfc/`
- `packages/runner/src/builtins/`
- `packages/runner/src/traverse.ts`

Tasks:

- [ ] Define the supported structural claim set for the first pass
- [ ] Implement conservative defaults for collection transforms
- [ ] Allow less-restrictive structural claims only when explicitly trusted
- [ ] Start with the built-ins that already shape collections in the runtime:
      `map`, `filter`, and `flatMap`

Acceptance:

- [ ] Untrusted structural relaxations fall back to conservative labels
- [ ] Trusted structural claims can narrow labels only where the claim proves it
- [ ] Unsupported collection operators remain conservative

### 10. Sink Enforcement

Primary files:

- `packages/runner/src/builtins/fetch-data.ts`
- `packages/runner/src/builtins/fetch-program.ts`
- new files under `packages/runner/src/cfc/`

Tasks:

- [ ] Introduce a stable, immutable request snapshot for external sink calls
- [ ] Move network side effects behind the transaction outbox
- [ ] Verify sink-specific policy from prepared request labels before issuing the
      request
- [ ] Add idempotency keys so retries do not reissue the same committed effect
- [ ] Keep request authorization and request execution as separate steps

Acceptance:

- [ ] Failed prepare or failed commit never issues a network call
- [ ] Retried attempts reuse the winning committed effect and do not double-send
- [ ] Request release rules are evaluated from persisted labels, not ad hoc
      runtime state

### 11. UI Provenance and Trusted Events

Primary files:

- `packages/html/src/`
- `packages/runner/src/scheduler.ts`
- `packages/ts-transformers/src/`
- `packages/schema-generator/src/`

Tasks:

- [ ] Define an internal event envelope that can carry provenance and integrity
      hints
- [ ] Add renderer-generated provenance for user-initiated events
- [ ] Carry event provenance through scheduler delivery and handler execution
- [ ] Add the minimum authoring/schema hooks needed to declare trusted UI event
      outputs

Acceptance:

- [ ] User-originated events can be distinguished from untrusted synthetic input
- [ ] Boundary evaluation can consume event provenance without ambient globals
- [ ] Untrusted UI-origin claims fail closed

### 12. Direct CAS and Parallel-Path Hardening

This stays behind the core causal-path rollout.

Primary files:

- `packages/runner/src/storage/`
- `packages/memory/`
- new files under `packages/runner/src/cfc/`

Tasks:

- [ ] Apply the same boundary model to direct CAS writes
- [ ] Enforce exact label binding on CAS reads
- [ ] Normalize miss behavior across absent hash, unreadable binding, and label
      mismatch
- [ ] Prove that causal-path and CAS-path authorization cannot bypass one
      another

Acceptance:

- [ ] CAS writes cannot bypass policy enforcement
- [ ] CAS reads do not leak miss reasons
- [ ] Public causal reads never expose CAS-only metadata

## Test Strategy

The test matrix should be built in the same order as the implementation:

- [ ] unit tests for types, path canonicalization, and digest stability
- [ ] unit tests for merged-schema monotonicity, branch-external IFC placement,
      and required-field/default compatibility
- [ ] transaction tests for prepare gating and invalidation
- [ ] rollout-mode tests for `disabled`, `observe`, and enforcing modes
- [ ] traversal tests for relevance detection
- [ ] prepare-engine tests for input requirements and output transitions
- [ ] storage tests for embedded-metadata persistence and non-exposure
- [ ] scheduler tests for retry and outbox behavior
- [ ] sink tests for commit-gated network execution and idempotency
- [ ] UI tests for provenance-backed trusted event delivery
- [ ] fresh-runtime restart tests for persisted metadata, trust snapshots, and
      sink results

Every phase should land with tests before the next phase starts.

## Rollout and Guardrails

- [ ] Add a runtime feature flag for commit-boundary CFC enforcement
- [ ] Define rollout modes:
      `disabled`, `observe`, `enforce-explicit`, and `enforce-strict`
- [ ] Default phase 1 to unlabeled-permissive behavior; switching unlabeled
      paths away from permissive defaults is a separate rollout gate
- [ ] Emit counters for:
      `cfcRelevantTx`, `cfcPreparedTx`, `cfcPrepareRejects`,
      `cfcDigestInvalidations`, `cfcOutboxFlushes`, and sink dedup hits
- [ ] Keep sensitive values out of logs; log only rule ids, paths, and summary
      labels
- [ ] Treat step 8 below as the first safe enablement point for state-only
      transactions
- [ ] Do not enable enforcing modes for runtimes with external sinks until
      outbox and retry tests are green
- [ ] Do not enable direct CAS enforcement until parallel-path non-bypass tests
      are green

## Recommended Landing Order

Land the work in mergeable vertical slices:

1. [ ] Types, canonical path helpers, and digest helpers
2. [ ] Transaction CFC state and rollout modes with observe-mode prepare
3. [ ] V2 consumed-read and compact final-write extraction APIs
4. [ ] Relevance detection and merged-schema envelope implementation
5. [ ] Embedded v2 CFC metadata persistence and non-exposure
6. [ ] Baseline prepare engine for classification and integrity checks
7. [ ] Scheduler integration and success-only outbox
8. [ ] Enforcing commit gate for state-only transactions once extraction/prepare
       slices are green
9. [ ] Stable implementation identity and trust snapshotting
10. [ ] Structural flow-precision claims for core built-ins
11. [ ] Fetch and other external sink enforcement
12. [ ] UI provenance and trusted-event path
13. [ ] Direct CAS and parallel-path hardening

Step 8 is the first safe enablement point for transactions that do not issue
external effects. Step 11 is the first safe enablement point for runtimes with
external sinks.

## Done Means

This plan is complete when all of the following are true:

- CFC-relevant transactions are prepared and verified before commit
- authoritative CFC metadata is persisted for later reads and writes
- current coarse label behavior still works for existing query and redaction
  flows, whether sourced from legacy v1 facts or embedded v2 summaries
- external side effects are commit-gated and retry-safe
- stable policy-facing code identities and runtime verified-load provenance refer
  to the same admitted implementations for the supported identity classes
- trust-sensitive relaxations are deterministic and fail closed
- tests cover warm-runtime and fresh-runtime behavior
- the feature can be enabled incrementally with clear observability
