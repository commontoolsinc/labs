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

There is now also a narrow direct-command authority helper for agent kernels:

1. Root agent intents may only be refined from source events whose integrity
   contains `UserSurfaceInput(user = actingUser)`,
   `PromptSlotBound(role = "direct-command", subject = actingUser,
   kernelName = ...)`, and a trusted builtin marker for that kernel.
2. Same-user note/context surfaces fail closed because their
   `PromptSlotBound.role` is not `direct-command`.
3. Other-user text also fails closed because the submission subject does not
   match the acting user.

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
4. Consumed markers can carry committed-result metadata, which lets later
   deduplicated executions return the already-committed result without
   performing the side effect again.

These pieces now compose through a runner-internal refiner helper:

1. Handler code can take the current semantic event, claim refinement once,
   and build a short `IntentOnce` value in the same transaction.
2. If the same semantic event is processed again without scheduler-level dedup,
   the helper returns `null` once the refinement claim already exists.

There is now also a request-binding predicate for future sink adapters:

1. A short `IntentOnce` can be checked against concrete request semantics using
   exact matching on `audience`, `endpoint`, `payloadDigest`, and
   `idempotencyKey`.
2. The predicate fails closed when any of those bindings are missing or
   mismatched.

For `fetchData`, runner internals now also expose a shared request snapshot and
semantics derivation path:

1. `fetchData` input normalization (including structured body stringification)
   lives in a shared helper, not inline in the builtin.
2. CFC code can derive request semantics from that normalized snapshot using
   the same body and header view the builtin uses at execution time.
3. Endpoint class can be supplied explicitly when a sink policy/refiner needs a
   logical endpoint name instead of the default `METHOD path` shape.

There is now also a thin intent-aware fetch commit wrapper:

1. It derives fetch request semantics from normalized inputs.
2. It requires an exact `IntentOnce` binding match before any request attempt
   executes.
3. On success it reuses the generic intent retry/consume helper; on mismatch it
   fails closed without starting the side effect.

The fetch path also now has a conservative authorization-placement guard:

1. The same auth token must appear in `Authorization` and nowhere else in the
   normalized request.
2. Query-string reuse, body reuse, or reuse in another header fails closed.
3. This remains only the structural half of the sink gate for request-shape
   validation; broader sink policies like error sanitization are still deferred.

`fetchData` now also propagates result labels from persisted request labels:

1. The fetch sink loads request labels from the resolved request cell and loads
   sink-scoped rewrite rules from the persisted schema-hash/blob path.
2. Successful fetches aggregate request confidentiality, apply any matching
   `allowedSink = "fetchData"` rewrites, and preserve unmatched request taint.
3. The runtime mints `AuthorizedRequest` when a sink rule fires and always mints
   `NetworkProvenance` for labeled fetch responses.
4. Those labels are written onto the resolved result cell, so callers observe
   the same CFC state through `result.key("result").resolveAsCell()`.

Input-requirement checks now also accept structured atom patterns:

1. `requiredIntegrity` schema annotations can include JSON atoms, not only
   legacy strings.
2. Object-pattern requirements use subset matching, so a schema can require
   only the stable fields it cares about from minted atoms such as
   `AuthorizedRequest` or `NetworkProvenance`.
3. Concept-valued requirements still route through the acting principal's
   trust closure rather than requiring derived concept atoms to be persisted.

Policy rewrite guards now use the same atom-pattern model:

1. `confidentialityPre` and `integrityPre` accept JSON atoms, not only legacy
   strings.
2. `confidentialityPre` preserves declared order because the first atom is the
   target clause atom and later atoms are side conditions.
3. `integrityPre` matches minted evidence atoms (for example
   `AuthorizedRequest`) by subset object pattern, with concept guards still
   routed through trust closure.
4. `addIntegrity` now persists onto prepared output labels; it is no longer
   just an internal allow/deny intermediate during policy evaluation.

That composition is now covered end to end for a Gmail-style read flow:

1. Phase 1 writes a fetch request whose auth-header clause is sink-rewritten.
2. The resolved fetch result persists `User(...)` confidentiality plus minted
   `AuthorizedRequest` / `NetworkProvenance` integrity on disk.
3. Phase 2, in a fresh runtime instance, reads that persisted result and
   successfully passes both `requiredIntegrity` and downstream declassify
   checks without relying on phase-1 caches.

The commit-point send path is also now covered in the same way:

1. A Gmail-style send uses `fetchData` with a bound `IntentOnce`.
2. The first committed attempt stores the committed result alongside the
   consumed-intent marker.
3. A second runtime instance replays the same send and gets the stored result
   back without issuing another network request.

Intent-backed fetch sends now also have a live request-side sink gate:

1. If the refined `IntentOnce` binds a `targetPrincipal`, `fetchData` requires
   a fresh audience-verification callback at commit time before any network
   attempt executes.
2. Successful verification contributes an `AudienceRepresents(principal,
   audience)` integrity atom for the current attempt.
3. Before sending, the fetch path loads persisted request labels and
   request-schema `allowedSink = "fetchData"` rules, applies matching rewrites,
   and fails closed unless every remaining confidentiality clause is satisfied
   by the acting user's own `User(...)` authority.
4. The same fresh `AudienceRepresents(...)` atom is persisted onto successful
   fetch results alongside the existing `AuthorizedRequest` and
   `NetworkProvenance` evidence.
5. Trusted integrity carried on the refined intent itself is also included in
   that request-side gate and persisted result integrity. This lets agentic
   email body rules require disclaimer/acknowledgment atoms without treating
   the untrusted report text as routing authority.

That is now covered by a return-to-sender slice:

1. A value labeled with both `User(Alice)` and `AuthoredBy(hotel)` is written
   into a fetch request body.
2. Without a matching sink rule, the live send is rejected even if the
   audience verifier would otherwise approve the destination.
3. With a matching rule and a fresh `AudienceRepresents(hotel, audience)`
   verification, only the `AuthoredBy(...)` clause is cleared for the send,
   while the result still carries `User(Alice)` confidentiality.

That same mechanism now covers a narrow agentic email slice too:

1. A refined email-send intent may carry trusted
   `SinkContentDisclaimerAttached(...)` integrity.
2. A request-body field tainted with `Caveat(kind = PROMPT_INFLUENCE, ...)`
   remains blocked unless the request schema's fetch sink rule sees that
   disclaimer atom.
3. The recipient field stays controlled by the trusted intent binding, while
   body release is authorized separately through the disclaimer evidence.

A fact-check assurance slice is also now covered:

1. A policy rewrite authorizes a public-audience output classification from a
   user-scoped input using structured atom-pattern guards.
2. The same rewrite persists structured assurance atoms like `FactChecked` and
   `SourcesDisclosed` onto the output label.

A durable sharing slice is now covered too:

1. Policy rewrites can capture variables from structured confidentiality atoms,
   substitute them into `guard.policyState` entries, and resolve those guards
   against deterministic on-disk policy-state records.
2. When a matching `ShareGrant` exists, the rewrite can synthesize the output
   confidentiality label if the target schema has no base classification.
3. A fresh runtime instance can consult that persisted `ShareGrant` and still
   complete the share-style declassification without relying on warm caches.

Prepare-time policy matching now also seeds reserved bindings from the ambient
prepare context:

1. `$actingUser` resolves from `PrepareBoundaryCommitOptions.actingPrincipal`.
2. Policy preconditions can require a user-scoped input to match the acting
   principal.
3. The same binding can be substituted into synthesized output atoms.

There is now also a first direct-CAS helper seam:

1. CAS payloads are stored immutably by canonicalized byte hash, with labels in
   a separate append-only binding record keyed by the same hash.
2. Direct CAS writes currently flow through an injected trusted-boundary
   evaluator that turns a caller-proposed label context into the effective
   stored label.
3. Direct CAS reads currently require `(blobHash, expectedLabel)` plus an
   injected readability check; absent hash, label mismatch, and unreadable
   label all normalize to the same `undefined` miss shape.
4. This is intentionally narrower than the final runtime contract: the helper
   seams still need to be replaced by the runner's concrete IFC/policy engine
   and caller-access semantics before the CAS path is fully integrated.

The calendar-consent foundation is now present too:

1. Runner-internal `MultiPartyConsentIntent` helpers derive deterministic ids
   from participant, scope, constraints, evidence, and expiry.
2. Consent validation intersects time ranges and hours conservatively, takes
   the minimum `maxResults`, preserves `onlyFuture` when any participant
   requires it, and derives a deterministic `ConsentedBy` atom.
3. Canonical result labels can now be derived directly from those consents:
   `MultiPartyResult(participants=...)` plus `ComputedBy(...)` and
   `ConsentedBy(...)`.
4. Policy atom matching now supports array membership via a `contains` matcher,
   which lets rules express checks like
   `participants contains $actingUser` on `MultiPartyResult` atoms.
5. Policy rewrites now honor `removeMatchedClauses` together with a non-empty
   postcondition, so a matched confidentiality atom can be replaced rather than
   only augmented.
6. Broader runtime-trust domain enforcement is still a later layer, but
   prepare-time runtime/device attestation guards now sit on top of this
   foundation.

Schema-declared write authority is now also enforced in prepare:

1. Schema paths may declare `ifc.writeAuthorizedBy` with `CodeHash(...)` and/or
   `Builtin(...)` atoms.
2. Prepare compares that set against the attempt's implementation identity.
3. Writes from identities outside the declared set fail closed with
   `CfcOutputTransitionViolationError(requirement = "writeAuthorizedBy")`.
4. This covers the counter-pattern worked example directly at the field level,
   before the write reaches storage.

Policy rewrites now also see trusted output integrity, not just consumed-read
integrity:

1. Prepare seeds policy evaluation with the effective integrity of the output
   label being written.
2. Sanitizer patterns can therefore require trusted post-transform assurance
   atoms such as `InjectionSafe` in `integrityPre`.
3. Clause-local confidentiality release remains narrow: removing one matched
   material-risk caveat does not clear unrelated clauses like
   `PROMPT_INFLUENCE`.
4. This is the runner hook needed for the safe-probing worked example.

Fetch sink failures now preserve boundary evidence too:

1. Non-OK `fetchData` responses keep structured HTTP error metadata on the
   stored `@Error` wrapper, including parsed error body fields and response
   headers when available.
2. The error cell receives the same sink-derived confidentiality/integrity
   labels as a successful result cell when the request reached an HTTP
   response.
3. That makes Gmail-style operator diagnostics implementable without dropping
   `AuthorizedRequest` / `NetworkProvenance` evidence on the failure path.
4. Operator-facing sanitized fields can then be materialized into separate
   cells/views while retaining full request confidentiality on raw details and
   headers.

Quality-constrained direct-command refinement is now available too:

1. A trusted direct-command root `IntentOnce` may bind
   `requiresFactChecked: true` as part of the user's requested authority.
2. Refinement to the final email-send `IntentOnce` can fail closed before any
   sink call if the refinement does not carry matching `FactChecked` evidence.
3. The live fetch sink still independently checks the final request/body
   bindings plus any disclaimer or assurance atoms required by the sink rule.
4. This gives the agentic fact-checked email variant an earlier, explicit
   quality gate in addition to the normal commit-point sink enforcement.

Return-to-sender refinement can also demand explicit provider trust:

1. A sender-bound confidentiality clause such as `AuthoredBy(..., provider =
   Gmail)` can now be paired with an early refinement helper that requires
   matching `TrustedProvider(Gmail)` evidence before minting the final
   principal-bound `IntentOnce`.
2. The final sink rule can still require fresh `AudienceRepresents(...)` at
   commit, so refinement-time provider trust and commit-time audience binding
   remain separate checks.
3. This matches the spec’s conditional-trust reading of sender-authored
   provenance without weakening the existing return-to-sender commit gate.

Sharing flows now also have a provenance-disclosure helper layer:

1. A trusted share-policy helper can derive a durable `ShareGrant` from a
   semantic `ShareWithUser` intent event only when the previewed
   `owner/resourceRef/recipient/scope` match and disclosure evidence was
   rendered.
2. The helper currently requires `GestureProvenance`,
   `IntentSurfaceTrusted(action = "ShareWithUser")`, and both
   `DisclosureRendered(kind = "SelectionInfluence")` and
   `DisclosureRendered(kind = "SelectionNotShared")`.
3. `policyState` guards now match stored state records structurally rather than
   by exact deep equality, so the durable stored record can carry metadata like
   `grantedAt` and `sourceIntentId` while the guard still names only the key
   fields.

Runtime/device placement guards are now available as ambient prepare-time
integrity too:

1. `Runtime` may expose ambient execution-integrity atoms such as
   `RuntimeProfile`, `RuntimeTEE`, `RuntimeProvider`, `RuntimeImage`,
   `AudioTrigger`, or `AudioFilterApplied`.
2. Those atoms are threaded into the transaction prepare scope, included in the
   prepared digest, and therefore same-attempt checked at commit just like the
   acting principal and trust-context snapshot.
3. Policy `integrityPre` rules can match those ambient runtime facts without
   persisting them onto the output label unless the schema explicitly adds them.
4. The acting user’s trust context can now also upgrade structured attestation
   atoms into concept guards; trust statements are no longer limited to
   legacy string concretes.
5. Prepare now also treats device/runtime confinement clauses on the output
   label as destination requirements for the current runtime. Exact-copy or
   otherwise monotone writes of device-locked or shared-CC-locked data fail
   unless the ambient execution-integrity facts satisfy those confinement
   clauses.
6. Only runtime/domain atoms participate in this extra destination check
   today (`DeviceIdentity`, `DeviceTier`, `RuntimeProfile`, `RuntimeTEE`,
   `RuntimeProvider`, `RuntimeImage`), so ordinary caveat clauses such as
   prompt influence are not incorrectly treated as placement locks.
7. This is enough for the exact-device, owner-tier, and shared-CC calendar
   placement slices plus the device-constrained audio-trigger slice from the
   worked examples, including exact-copy confinement outside explicit
   declassification rules.

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
