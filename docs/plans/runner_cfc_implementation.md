# CFC Runner Implementation Plan

This document is the implementation plan for adding commit-boundary Contextual
Flow Control (CFC) enforcement to `packages/runner`.

It is intentionally self-contained. It describes:

- the target behavior
- the normative specification context
- the data model we will implement
- the workstreams, files, and acceptance criteria
- the rollout sequence

## Implementation Guidance

Use a disciplined per-slice workflow while executing this plan:

- Work in red-green-refactor TDD loops: start by writing or extending the
  smallest failing test that captures the next required behavior, implement
  the minimum change to make it pass, then refactor with the suite green
- Commit often. Prefer small, reviewable commits that each preserve a green
  targeted test run and map to one vertical slice, invariant, or mechanical
  refactor
- Keep each landing slice mergeable and reversible. Avoid multi-workstream
  branches that mix contract changes, policy behavior, persistence changes,
  and sink integration unless the boundary is already proven by tests
- After each slice, run the narrowest relevant tests first, then rerun the
  broader package-level tests before moving to the next slice
- Treat invariants in this document as executable requirements. When a bug
  or ambiguity is found, add or tighten a test before adjusting the code
- Use sub-agents only for bounded sidecar work that improves quality
  without creating conflicting edits. Good uses include plan/spec
  conformance review, test-gap review, and source-hunting for integration
  points; avoid delegating overlapping code edits in the same files
- For risky slices such as commit gating, retry behavior, trust-sensitive
  relaxations, or sink deduplication, schedule an explicit review pass
  before moving rollout forward. A sub-agent review is useful here as a
  second set of eyes, but the main branch of truth remains the spec, the
  tests, and the final human review

## Goal

Move from schema-guided IFC propagation to a runner/storage boundary that
enforces CFC at commit time.

At the end of this work:

- schema `ifc` annotations will be enforced before a commit succeeds
- CFC-relevant writes will persist authoritative path-granular metadata and
  deep-frozen canonical schema hashes backed by canonical schema documents
  stored at `cid:<hash>` as a phase-1 stand-in for fuller content-addressed v2
  storage
- commit-time enforcement will apply uniformly at the transaction boundary,
  regardless of whether the transaction came from the scheduler,
  `runtime.editWithRetry()`, or another runtime-owned caller
- external side effects will be gated on successful commit
- trust-sensitive relaxations will be explicit, deterministic, and fail closed

Phase 1 targets the memory-v2 transaction path only. No
`application/label+json` bridge or coarse-label compatibility path is carried
forward.

## Specification Context

This plan is constrained by the surrounding specs rather than by any specific
current implementation shape:

- `docs/specs/json_schema.md` defines `ifc` as a schema extension
- `docs/specs/verifiable-execution/06-cfc-and-trust.md` defines the
  path-granular label-map direction and trust terminology
- `docs/specs/ts-transformer/cfc_authoring_contract.md` defines the authoring
  surface for richer `ifc` keys such as `integrity`, `addIntegrity`,
  `requiredIntegrity`, `maxConfidentiality`, `writeAuthorizedBy`, `projection`,
  and collection rules
- `docs/specs/memory-v2/README.md` and
  `docs/specs/memory-v2/03-commit-model.md` define the seq-addressed JSON write
  path and the adjunct/system-entity surfaces we should reuse for schema
  persistence and code identity; phase 1 persists canonical schemas as regular
  v2 entities addressed by `cid:<hash>` so the boundary model does not depend
  on new blob APIs landing first

This plan adds the boundary substrate that those specs require:

- there is no transaction-level CFC state
- there is no prepare-before-commit step
- there is no canonical digest of consumed reads, attempted writes, and
  write-time policy inputs
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

A transaction is CFC-relevant when at least one consumed read, attempted write,
or write-time policy input touches data whose effective schema or stored CFC
metadata carries IFC constraints.

### Consumed Read

A consumed read is a read that contributes to boundary checking for the current
attempt. It is derived from transaction inspection APIs and excludes
verifier-internal reads. Scheduler-only metadata and CFC metadata must remain
separate concerns.

### Potential and Final Write Sets

The ideal high-precision model records ordered attempted writes before
last-write-wins compaction.

Phase 1 does not require that precision. It uses two deterministic transaction
views:

- `potentialWrites`: the maybe-write target set, sourced from tx
  `markReadAsPotentialWrite` reads performed while deciding whether a diff
  results in a write
- `writes`: the actual changed/final write set sourced from v2 transaction
  internals

Boundary checking uses `potentialWrites ∪ writes` as the target set for
relevance and conservative target-side policy checks. Persisted output label-map
updates and metadata updates are derived from `writes` only. If later rules
need per-write provenance or exact attempt order, we can add dedicated
write-attempt logging as a follow-on precision optimization.

Phase-1 invariant: direct `tx.write*()` usage remains internal-only runner API.
No-op attempted-target coverage depends on higher-level diff paths performing
`markReadAsPotentialWrite` reads before deciding whether to write. That
assumption should be documented explicitly on the transaction write APIs and
covered by guardrail tests. This is not just theoretical: current v2 writes
short-circuit same-value writes before recording write activity, so no-op
attempted-target coverage must come from `markReadAsPotentialWrite` or a future
explicit attempted-write API.

### Write-Policy Input

A write-policy input is boundary-relevant write-time data that cannot be
reconstructed from generic tx read/write inspection alone.

Examples:

- the candidate `SchemaAndHash` or canonical schema payload for a target write
- provenance claims needed for `projection`, `exactCopyOf`, or collection rules
- trusted-event provenance
- immutable sink request snapshots

These inputs must be recorded explicitly in tx CFC state at mutation time,
canonicalized deterministically, and hashed into prepare.

### Prepare

Prepare is the deterministic boundary check that runs after the user action or
handler has produced its reads and writes but before commit succeeds.

Prepare:

- gathers consumed reads, canonical `potentialWrites`, canonical `writes`, and
  canonical write-policy inputs
- evaluates schema and policy obligations
- computes output label maps and metadata
- records a digest of exactly what was checked

### Prepared Digest

The prepared digest is a stable hash of:

- canonical consumed reads
- canonical `potentialWrites`
- canonical `writes`
- canonical write-policy inputs
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

- verified compiled code: a richer verified bundle identity plus canonical
  binding path within that bundle, and when needed source loc/col and/or a pure
  code hash
- built-ins: canonical runtime-owned registry ids

Phase 1 treats bare memory-v2 `codeCID` as at most one component or hint for
that identity, not the identity itself. Trust-sensitive enforcement for
verified compiled user code is therefore blocked on extending memory-v2
commit/transport/storage surfaces to carry or rebind the richer
bundle/path/location/hash identity deterministically.

Phase 1 does not require stable policy identities for direct-eval,
unsafe-host/test helpers, or any other unsupported identity class. Those paths
are treated as untrusted for trust-sensitive relaxations unless a later
explicit stable-id path is added.

### Trust Snapshot

A trust snapshot is the acting-principal-scoped view of the trust graph used by
the boundary evaluator. Trust-sensitive relaxations must depend on this
snapshot, not on ambient mutable state.

## Storage Model

For memory-v2, the runner needs an authoritative CFC metadata record embedded in
the single entity document. Phase 1 is memory-v2-only.

### Embedded Metadata

Introduce a system-owned reserved sibling to `value` and `source` for each
entity:

```ts
type IFCLabel = {
  classification?: unknown[];
  confidentiality?: unknown[];
  integrity?: unknown[];
};

type CfcMetadata = {
  version: 1;
  schemaHash: string;
  labelMap: {
    version: 1;
    entries: Array<{
      path: string[];
      label: IFCLabel;
    }>;
  };
};

type EntityDocumentWithCfc = {
  value?: unknown;
  source?: unknown;
  cfc?: CfcMetadata;
};
```

### Document Surface Rules

Memory-v2 keeps a full entity-document boundary. Low-level `tx.read()` and
`tx.write()` operate on the whole entity document, including reserved metadata
siblings such as `source` and `cfc`.

Only the logical `value` surface is exposed to untrusted or user-authored code.
`Cell.get()`, `Cell.sync()`, query materialization, and similar
validate/transform paths read under `value`, not the full document. Reserved
siblings remain system metadata, not user JSON content.

Storage rules:

- in memory-v2, the reserved `cfc` sibling is authoritative for boundary checks
  once present
- the v2 `cfc` sibling stores the authoritative label map and `schemaHash` in
  the same document as `value` and `source`
- untrusted value-surface reads and materialized values must not expose the
  reserved `cfc` sibling
- no `application/label+json` bridge or coarse-summary compatibility path is
  carried forward

### Path Canonicalization

The canonical logical path format is `string[]` with the wrapper segment
`"value"` stripped. Root is `[]`.

When we need deterministic hashing or ordering, encode that canonical path as a
JSON Pointer string derived from the segment array.

### Schema Hash and Frozen Schema

Use the existing frozen-schema pipeline for canonical schema identity:
`toDeepFrozenSchema()` for canonical deep-frozen form and
`internSchema(..., true)` for `SchemaAndHash`.

`schemaHash` is the persisted `SchemaAndHash.hashString` for the canonical
merged schema envelope for the entity, not the hash of any one effective
selector schema seen during prepare.

The corresponding deep-frozen canonical schema object is also persisted as a
regular memory-v2 entity whose id is `cid:<hash>`. The canonical schema payload
lives under that entity document's `value`; any sibling fields are reserved for
system metadata. This is a phase-1 stand-in for a future dedicated
content-addressed v2 surface.

Prepare loads the prior envelope by reading `cid:<schemaHash>` and then its
`value`, merges candidate schema input into it, and persists a replacement
canonical schema document only when the merged envelope changes.

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
- every merged result is canonicalized with `toDeepFrozenSchema()` and
  `internSchema(..., true)` before persistence to its `cid:<hash>` schema
  document

Phase-1 behavior:

- each write that carries schema context, typically from `Cell.*` operations,
  contributes a candidate schema update for its target entity
- if the target entity has no stored `schemaHash`, prepare persists the
  candidate canonical schema envelope as `cid:<hash>` and stores the resulting
  `schemaHash`
- if the target entity already has a stored `schemaHash`, prepare loads that
  canonical schema document from `cid:<schemaHash>` and attempts a monotonic
  merge of the candidate schema into it
- if merge fails because the candidate would weaken IFC obligations or
  invalidate previously valid data, prepare rejects and the transaction aborts,
  unless an explicit migration or recovery path is active
- if the canonical merged envelope produces the same `schemaHash`, prepare
  treats the schema update as a no-op
- if the canonical merged envelope produces a new `schemaHash`, prepare
  persists or reuses the replacement `cid:<hash>` schema document and
  replacement hash
- if a stored `schemaHash` is missing or unreadable, or the corresponding
  `cid:<hash>` schema document is absent/unreadable, prepare rejects and the
  transaction aborts unless an explicit recovery path is active

This keeps schema identity stable while making schema evolution a per-write
entity update, rather than depending on whichever narrowed selector schema
happened to be observed elsewhere in the attempt.

## Non-Goals

This plan does not attempt to do all of the following in the first landing:

- full write-time JSON Schema validation unrelated to CFC
- general policy distribution or discovery protocols
- broad UI authoring ergonomics beyond the provenance hooks needed for trusted
  events
- a generalized content-addressed side-path security model before the core
  causal path is stable
- a wholesale rewrite of scheduler or runtime architecture

## Invariants

These must hold once enforcement is enabled:

- no CFC-relevant commit succeeds without a same-attempt prepare
- any read, write, or write-policy input that changes the prepared digest
  invalidates prepare
- verifier-internal reads never become consumed reads
- explicit IFC claims fail closed on missing schema, missing metadata, unknown
  trust state, or unsupported trust-sensitive claims
- the commit gate lives at the transaction boundary, not only in scheduler code
- external side effects happen only after successful commit
- retries always run in a fresh transaction and recompute prepare
- persisted CFC metadata is system-controlled, not user-editable JSON content
- no `application/label+json` compatibility path participates in enforcement
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

- [x] Define `CfcTxState`, `ConsumedRead`, `AttemptedWrite`,
      `WritePolicyInput`, `PreparedDigestInput`, `ImplementationIdentity`,
      `TrustSnapshot`, `CfcEnforcementMode`, and `CfcMetadata`
- [x] Define a dedicated metadata marker for `internalVerifierRead`
- [x] Define a dedicated side-effect outbox entry type for post-commit effects
- [x] Define the reserved embedded `cfc` document shape and system-ownership
      rules for that metadata
- [x] Define a canonical code-identity shape that separates policy-facing code
      identity from per-load runtime ids and can encode bundle/path/location/hash
      provenance without relying on bare memory-v2 `codeCID`

Acceptance:

- [x] New types compile without changing behavior
- [x] Serialization tests cover `CfcMetadata`, `WritePolicyInput`, and digest
      input canonicalization

### 2. Transaction State and Commit Gate

Primary files:

- `packages/runner/src/storage/interface.ts`
- `packages/runner/src/storage/extended-storage-transaction.ts`
- `packages/runner/src/storage/transaction.ts`
- `packages/runner/src/storage/v2-transaction.ts`

Tasks:

- [x] Add CFC state to the extended transaction wrapper and/or underlying
      transaction implementation: relevance, preparation status, prepared
      digest, write-policy inputs, trust snapshot, outbox, and enforcement mode
- [x] Add helpers to mark a transaction relevant, prepared, invalidated, and to
      enqueue post-commit side effects
- [x] Make the commit gate live in the transaction commit path so
      scheduler-driven flows, `runtime.editWithRetry()`, and other
      runtime-owned commit callers use the same enforcement boundary
- [x] Support rollout modes:
      `disabled`, `observe`, `enforce-explicit`, and `enforce-strict`
- [x] In `observe`, compute prepare state and diagnostics without blocking
- [x] In enforcing modes, enforce `relevant -> prepared` at commit
- [x] Recompute the digest immediately before commit and reject on mismatch
- [x] Reset CFC state on abort and on retry

Acceptance:

- [x] Observe mode records prepare state without blocking commit
- [x] Relevant transaction without prepare fails commit in enforcing modes
- [x] Prepared transaction with unchanged activity commits successfully
- [x] Post-prepare read, write, or write-policy input invalidates prepare
- [x] Abort clears outbox state
- [x] Scheduler-owned and direct runtime-owned commit callers hit the same gate

### 3. Canonical Activity and Policy-Input Capture

Primary files:

- `packages/runner/src/storage/interface.ts`
- `packages/runner/src/storage/v2-transaction.ts`
- `packages/runner/src/storage/transaction-inspection.ts`
- `packages/runner/src/storage/reactivity-log.ts`
- new files under `packages/runner/src/cfc/`

Tasks:

- [x] Build a canonical extractor over the v2 inspection APIs
- [x] Surface tx `potentialWrites` as the phase-1 maybe-write target set
- [x] Produce a deterministic final-per-path `writes` set for phase 1
- [x] Preserve no-op attempted-target coverage through `potentialWrites`
- [x] Add JSDoc and guardrails on internal `tx.write*` APIs explaining that
      phase-1 no-op attempted-target coverage relies on higher-level diff paths
      using `markReadAsPotentialWrite`; blind same-value direct writes are not
      surfaced through `potentialWrites`
- [x] Audit existing internal direct `tx.write*` / `writeValueOrThrow()` call
      sites and either ensure they establish `potentialWrites` coverage before
      same-value short-circuiting or explicitly keep them out of phase-1 CFC
      scope
- [x] Add explicit APIs to record canonical `WritePolicyInput` entries at
      mutation time; do not rely on generic tx read/write inspection alone for
      schema hashes or structural provenance claims
- [ ] Keep scheduler metadata and verifier metadata distinct
- [x] Exclude only `internalVerifierRead` from the consumed-read set
- [ ] Make the phase-1 prepare engine free to pessimistically treat all
      consumed reads as influencing all target paths in
      `potentialWrites ∪ writes`
- [ ] Defer exact ordered write-attempt logging to a follow-up precision slice
      if later rules need it

Acceptance:

- [x] Canonical path handling strips the `value` wrapper consistently
- [x] Phase-1 canonical `potentialWrites` extraction is deterministic across
      runs
- [x] Phase-1 canonical `writes` extraction is deterministic across runs
- [x] Canonical `WritePolicyInput` capture is deterministic across runs
- [ ] Internal verifier reads remain visible for diagnostics but not policy
- [x] Final-per-path view is deterministic
- [x] Same-value direct writes are either covered by `potentialWrites` or
      explicitly out of phase-1 scope

### 4. Relevance Detection

Primary files:

- `packages/runner/src/schema.ts`
- `packages/runner/src/traverse.ts`
- `packages/runner/src/cell.ts`
- `packages/runner/src/link-utils.ts`

Tasks:

- [x] Mark a transaction relevant when traversal encounters schema `ifc`
- [x] Mark a transaction relevant when existing stored CFC metadata applies to a
      consumed read
- [x] Mark write-only transactions relevant when the target path carries CFC
      obligations even if no read happened first
- [x] Treat attempted no-op writes as relevant when they appear in
      `potentialWrites` for a path carrying CFC obligations
- [x] Ensure dependency-discovery transactions and other non-committing
      inspection transactions do not trigger prepare
- [x] Audit helper reads that should be tagged `internalVerifierRead`

Acceptance:

- [x] Reading a path with `ifc` marks the transaction relevant
- [x] Reading unlabeled plain data does not mark it relevant
- [x] Writing to a path with stored or schema-derived CFC metadata marks it
      relevant
- [x] Attempting a no-op write to a path with stored or schema-derived CFC
      metadata still marks it relevant
- [x] Dependency-collection transactions remain unaffected

### 5. Metadata and Schema Persistence

Primary files:

- `packages/runner/src/storage/v2.ts`
- `packages/runner/src/storage/v2-document.ts`
- `packages/memory/v2.ts`
- `packages/memory/v2/engine.ts`
- `packages/runner/src/storage/interface.ts`

Tasks:

- [x] Persist CFC metadata as a system-owned reserved sibling to `value` and
      `source` in the v2 entity document
- [x] Persist canonical merged schema envelopes as system-owned v2 schema
      documents at `cid:<hash>` and store `schemaHash` in embedded metadata
- [x] Store the authoritative path-granular label map and `schemaHash` in that
      embedded metadata
- [x] Ensure untrusted value-surface reads and materialized values do not
      expose the reserved `cfc` sibling
- [x] Make storage helpers able to read current CFC metadata and load
      canonical schemas from `cid:<schemaHash>` efficiently during prepare
- [ ] Do not carry forward `application/label+json` or query-redaction
      compatibility behavior

Acceptance:

- [x] A successful prepared write persists embedded CFC metadata and
      `schemaHash`
      in the v2 document
- [x] Loading the stored canonical schema by `schemaHash` after a fresh runtime
      restart reads `cid:<schemaHash>` and reproduces the canonical merged
      schema envelope
- [x] Existing untrusted value-surface reads and materialized values do not
      surface the reserved `cfc` sibling
- [x] Missing or unreadable `schemaHash` rejects later writes unless recovery
      is on

### 6. Prepare Engine

Primary files:

- new files under `packages/runner/src/cfc/`
- `packages/runner/src/schema.ts`
- `packages/runner/src/traverse.ts`

Tasks:

- [x] Build `prepareBoundaryCommit(tx, options)` as a pure, deterministic
      evaluator
- [x] Thread explicit write-policy inputs recorded at mutation time into
      prepare, including candidate `SchemaAndHash` values and structural
      provenance claims
      when available
- [x] Implement a canonical merged-schema envelope operator for the supported
      subset
- [x] Ensure IFC keys never weaken under merge and never appear only inside a
      divergent `anyOf`/`oneOf`/`allOf` branch
- [x] Ensure structural merge does not invalidate previously valid data; adding
      a required field requires a default
- [x] Resolve input labels from stored CFC metadata and persisted
      `cid:<hash>`-backed schema documents; no coarse-label fallback
- [x] Implement `classification`, `integrity`, `addIntegrity`,
      `requiredIntegrity`, and `maxConfidentiality`
- [ ] Implement `writeAuthorizedBy`, `exactCopyOf`, `projection`, and
      collection-derived transition checks where they can be evaluated from
      consumed reads plus `potentialWrites`/`writes` plus explicit write-policy
      inputs; otherwise fail closed or remain conservative
- [x] Until stable implementation identities and trust snapshots land, treat
      trust-sensitive claims such as `writeAuthorizedBy` as non-enforceable:
      allow diagnostics in `observe`, but hard-reject them in enforcing modes
- [x] Compute output label maps from `writes`
- [ ] Persist only concrete evidence in stored metadata; derived trust closure
      remains runtime-only
- [x] In phase 1, allow a conservative all-consumed-reads-to-all-targets
      influence model over `potentialWrites ∪ writes`
- [ ] Use `potentialWrites ∪ writes` for target-side enforcement and use
      `writes` only for persisted output metadata
- [x] If a target entity has no stored `schemaHash`, seed it from the first
      canonical `SchemaAndHash` and persist or reuse `cid:<hash>`; if merge
      yields the existing `schemaHash`, treat it as a no-op; if merge yields a
      new `schemaHash`, replace the stored hash; if merge fails, reject and
      abort the transaction
- [ ] Reject on missing schema, missing write-policy inputs, unreadable schema
      hashes, or any unsupported trust-sensitive claim

Acceptance:

- [x] Required-integrity failures reject before commit
- [x] Successful prepare writes stable `schemaHash` and label-map metadata
- [x] Unsupported or malformed trust-sensitive claims fail closed

### 7. Transaction Integration, Retry, and Side-Effect Gating

Primary files:

- `packages/runner/src/scheduler.ts`
- `packages/runner/src/cell.ts`
- `packages/runner/src/runner.ts`
- `packages/runner/src/runtime.ts`
- `packages/runner/src/storage/extended-storage-transaction.ts`

Tasks:

- [x] Make prepare invocation explicit for all runtime-owned writable
      transaction paths; scheduler integration is one path, but the commit gate
      remains in the transaction commit path
- [x] Insert prepare between action/handler execution and commit in
      scheduler-managed flows
- [x] Integrate generic `runtime.editWithRetry()` and other direct commit
      callers with the same prepare-or-observe path
- [x] Replace effectful use of generic commit callbacks with a success-only
      outbox
- [x] Migrate stream sends, queued events, and other runner-managed side
      effects to the outbox
- [x] Add JSDoc on internal commit-callback / `onCommit` hooks explaining that
      they are internal-only, may run after failed commits, and must not
      perform external side effects; effectful work must use the outbox
- [x] Keep retries fresh: new tx, new prepare, new trust snapshot
- [ ] Audit `onCommit` and direct commit call sites and move effectful ones to
      the outbox

Acceptance:

- [x] Failed commit does not emit side effects
- [ ] Relevant transactions committed via the scheduler,
      `runtime.editWithRetry()`, or other runtime-owned direct callers are
      uniformly gated
- [x] Retried handler emits side effects once, after the winning commit
- [x] Non-effectful commit callbacks used for diagnostics still work
- [x] Internal callback docs make the non-effectful restriction explicit

### 8. Implementation Identity and Trust

Primary files:

- `packages/runner/src/runner.ts`
- `packages/runner/src/builder/module.ts`
- `packages/runner/src/builder/json-utils.ts`
- `packages/runner/src/harness/executable-registry.ts`
- `packages/runner/src/storage/interface.ts`
- `packages/memory/v2.ts`
- new files under `packages/runner/src/cfc/`

Tasks:

- [ ] Define a stable policy-facing code identity separate from runtime
      `implementationRef` and per-load `verifiedLoadId`, capable of describing
      verified bundle identity, canonical binding path, optional loc/col,
      and/or pure code hash
- [ ] Keep `implementationRef` as the runtime lookup key and `verifiedLoadId` as
      the runtime admission scope; resolve policy identities through the
      verified registry and built-in registry, treating bare memory-v2
      `codeCID` as only one possible component or hint rather than a complete
      identity
- [x] Define canonical ids for built-ins
- [ ] Mark verified compiled-code policy identity as blocked on extending
      memory-v2 commit/transport/storage surfaces beyond bare `codeCID` so the
      richer bundle/path/location/hash identity can be carried or rebound
      deterministically
- [ ] In phase 1, treat direct-eval and unsafe-host/test helpers as untrusted
      for trust-sensitive relaxations unless a later explicit stable-id path is
      added
- [ ] Thread the resulting implementation identity through action and handler
      execution where possible; built-ins can land earlier, while verified
      compiled user code remains observe-only/fail-closed until the v2
      extension lands
- [x] Define a trust-snapshot provider interface that is deterministic and easy
      to test
- [ ] Bind prepare success to the acting principal, trust snapshot identity,
      and resolved policy-facing implementation identity
- [ ] Gate trust-sensitive flow relaxations on that snapshot

Acceptance:

- [x] Built-ins produce stable policy-facing implementation identities
- [ ] Verified compiled user-code policy identities remain blocked until v2
      carries the richer bundle/path/location/hash identity surface
- [ ] Unsupported identity classes fail closed for trust-sensitive checks
- [x] Changing the trust snapshot between prepare and commit invalidates prepare
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
- `packages/runner/src/builtins/stream-data.ts`
- `packages/runner/src/builtins/llm.ts`
- `packages/runner/src/builtins/llm-dialog.ts`
- new files under `packages/runner/src/cfc/`

Tasks:

- [ ] Introduce a stable, immutable request snapshot for external sink calls
- [ ] Include `streamData`, `llm`, `llmDialog`, `generateText`, and
      `generateObject` alongside `fetchData` and `fetchProgram` in the initial
      sink inventory and rollout gate
- [ ] Move network side effects behind the transaction outbox
- [ ] Verify sink-specific policy from the prepared request snapshot and
      committed CFC state before issuing the request
- [ ] Add idempotency keys so retries do not reissue the same committed effect
- [ ] Keep request authorization and request execution as separate steps

Acceptance:

- [ ] Failed prepare or failed commit never issues a network call from
      `fetchData`, `fetchProgram`, `streamData`, `llm`, `llmDialog`,
      `generateText`, or `generateObject`
- [ ] Retried attempts reuse the winning committed effect and do not double-send
- [ ] Request release rules are evaluated from the prepared request snapshot and
      committed CFC metadata, not ad hoc runtime state

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

### 12. Content-Addressed Side-Path Hardening

This stays behind the core causal-path rollout. Phase 1 schema persistence uses
regular `cid:<hash>` schema entities, not a dedicated blob/adjunct write
surface. This slice remains blocked until memory-v2 gains first-class
content-addressed adjunct read/write APIs.

Primary files:

- `packages/runner/src/storage/`
- `packages/memory/`
- new files under `packages/runner/src/cfc/`

Tasks:

- [ ] Apply the same boundary model to future content-addressed adjunct writes
      that affect CFC outcomes once v2 exposes them, starting with any
      blob-backed schema/object side paths that replace the temporary
      `cid:<hash>` schema-entity convention
- [ ] Enforce exact binding between embedded hashes such as `schemaHash` and
      either the temporary `cid:<hash>` schema entity or any future
      content-addressed object that prepare actually checked
- [ ] Normalize miss behavior across absent blob/ref, unreadable binding, and
      policy mismatch
- [ ] Prove that seq-addressed entity updates and content-addressed side paths
      cannot bypass one another

Acceptance:

- [ ] Content-addressed side-path writes cannot bypass policy enforcement
- [ ] Side-path reads do not leak miss reasons
- [ ] Public causal reads never expose system-owned side-path metadata except
      explicit embedded hashes

## Test Strategy

The test matrix should be built in the same order as the implementation:

- [x] unit tests for types, path canonicalization, write-policy input
      canonicalization, and digest stability
- [x] unit tests for merged-schema monotonicity, branch-external IFC placement,
      and required-field/default compatibility
- [x] transaction tests for prepare gating and invalidation
- [x] rollout-mode tests for `disabled`, `observe`, and enforcing modes
- [ ] traversal tests for relevance detection
- [x] prepare-engine tests for input requirements and output transitions
- [x] storage tests for embedded-metadata persistence, `schemaHash`
      dereferencing, and non-exposure
- [x] scheduler and runtime-owned direct-commit tests for retry and outbox
      behavior
- [ ] sink tests for commit-gated network execution and idempotency
- [ ] UI tests for provenance-backed trusted event delivery
- [ ] fresh-runtime restart tests for persisted metadata, schema hashes, trust
      snapshots, and sink results

Every phase should land with tests before the next phase starts.

## Rollout and Guardrails

- [x] Add a runtime feature flag for commit-boundary CFC enforcement
- [x] Define rollout modes:
      `disabled`, `observe`, `enforce-explicit`, and `enforce-strict`
- [ ] Default phase 1 to unlabeled-permissive behavior; switching unlabeled
      paths away from permissive defaults is a separate rollout gate
- [ ] Emit counters for:
      `cfcRelevantTx`, `cfcPreparedTx`, `cfcPrepareRejects`,
      `cfcDigestInvalidations`, `cfcOutboxFlushes`, and sink dedup hits
- [ ] Keep sensitive values out of logs; log only rule ids, paths, schema
      hashes,
      and effect ids
- [ ] Treat step 8 below as the first safe enablement point for state-only
      transactions
- [ ] Before step 9 below, enforcing modes cover only the non-trust-sensitive
      rule subset; claims that depend on stable code identity or trust snapshots
      must remain observe-only or fail closed
- [ ] Do not enable enforcing modes for runtimes with external sinks until
      outbox and retry tests are green
- [ ] Do not enable content-addressed side-path enforcement until non-bypass
      tests are green; the temporary `cid:<hash>` schema-entity path can land
      earlier

## Recommended Landing Order

Land the work in mergeable vertical slices:

1. [x] Types, canonical path helpers, write-policy input helpers, and digest
       helpers
2. [x] Transaction CFC state and rollout modes with observe-mode prepare
3. [ ] V2 consumed-read, `potentialWrites`, compact final-write extraction, and
       write-policy input capture APIs
4. [ ] Relevance detection and merged-schema envelope implementation
5. [x] Embedded v2 CFC metadata persistence, `cid:<hash>` schema-document
       persistence, and non-exposure
6. [ ] Baseline prepare engine for classification and integrity checks
7. [x] Transaction integration and success-only outbox
8. [ ] Enforcing commit gate for state-only transactions for the
       non-trust-sensitive rule subset once extraction/prepare slices are green
9. [ ] Stable built-in implementation identity and trust snapshotting; richer
       verified-code identity and trust-sensitive rule enforcement remain
       blocked on extending v2 code-identity surfaces
10. [ ] Structural flow-precision claims for core built-ins
11. [ ] Fetch, `streamData`, `llm`, and other external sink enforcement
12. [ ] UI provenance and trusted-event path
13. [ ] Content-addressed side-path hardening

Step 8 is the first safe enablement point for non-trust-sensitive,
state-only transactions that do not issue external effects. Step 9 is the first
safe enablement point for identity classes that already have stable policy ids,
such as built-ins; verified compiled user-code trust-sensitive enforcement
remains blocked until the richer v2 code-identity extension lands. Step 11 is
the first safe enablement point for runtimes with external sinks.

## Done Means

This plan is complete when all of the following are true:

- CFC-relevant transactions are prepared and verified before commit at the
  transaction boundary
- authoritative path-granular CFC metadata and canonical schema hashes are
  persisted for later reads and writes, with phase-1 schema payloads stored as
  `cid:<hash>` schema documents
- no `application/label+json` or coarse-label bridge is required for the v2
  enforcement path
- external side effects are commit-gated and retry-safe
- stable policy-facing code identities align supported identity classes with
  bundle/path/location/hash provenance rather than relying on bare `codeCID`
- trust-sensitive relaxations are deterministic and fail closed
- tests cover warm-runtime and fresh-runtime behavior
- the feature can be enabled incrementally with clear observability
