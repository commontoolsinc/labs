---
status: historical
created: 2026-08-13
archived: 2026-08-13
reason: "Audit snapshot of the resulting verbs implementation on main after the implementation arc landed."
---

# Verbs resulting-codebase review

## Snapshot and scope

This is a review of the resulting codebase, not a review of the pull requests
that produced it. Pull-request history was used to establish scope and intent;
every finding below was re-evaluated against `origin/main` at
`79b680725eeae376c6da182754976445647d96ab` on 2026-08-13.

The review follows the surface described by
[`docs/plans/verbs-implementation.md`](../plans/verbs-implementation.md) through
the API, compiler transforms, runner, scheduler, durable receipts, piece layer,
CLI discovery/help/call/read paths, and their tests and live documentation. It
looks for correctness, regression resistance, simplicity, and whether the code
explains its contract consistently.

The implementation arc is broad and still has explicitly unbuilt items. Those
roadmap items are not defects merely because they remain open. In particular,
this report does not choose an event-schema evolution policy. Whether verb
events should be open, closed, or governed by another evolution rule remains a
design discussion.

## Executive summary

The implementation has several good structural choices: caller event ids are
scoped from structured identity, receipt addresses come from the committing
transaction, result reads reuse the ordinary selection path, discovery fails
closed where it cannot prove a callable, and ambiguous handler-to-result
matches do not publish a guessed schema.

Seven current implementation defects remain. The first four can violate the
authored handler or invocation contract and should be addressed before relying
on verbs as a stable external API. A separate documentation finding makes retry
and receipt behavior harder to understand than the code itself, and a test
harness finding leaves central receipt coverage dependent on polling.

| ID | Severity | Status | Finding |
| --- | --- | --- | --- |
| V1 | Major | Verified | An explicitly schema-authored result handler is transformed into an invalid six-argument runtime call. |
| V2 | Major | Verified | Schema injection preserves `{ proxy: true }` syntactically but the runtime ignores it in the transformed call shape. |
| V3 | Major | Verified | Scheduler backlog collapse runs the newest invocation under an older event id and settles several callers with that id. |
| V4 | Major | Verified | The receipt representation conflates absence with valid empty values and publishes undeclared incidental returns. |
| V5 | Minor | Verified | A real selection error can hide the more useful refusal to read a verb as data. |
| V6 | Major | Verified | Unknown projection keys are silently accepted and can produce a successful but materially wrong empty result. |
| V7 | Minor | Verified | A quoted wrapper verb name is not marked `tier: "wrapper"` and can appear in default discovery. |
| V8 | Major | Verified | Live comments and documentation contradict current retry and receipt behavior. |
| V9 | Minor | Verified | Receipt integration tests poll with a timeout even though their commit callback is the completion event. |

## Findings

### V1 — explicit schemas plus a declared result produce an invalid call

The public API supports this form:

```ts
handler<Event, State, Result>(eventSchema, stateSchema, callback)
```

That overload is declared at `packages/api/index.ts:2585` and repeated by the
runner. The transformer takes every `handler` call with at least two type
arguments, generates event and state schemas, and prepends them to all authored
arguments (`packages/ts-transformers/src/transformers/schema-injection.ts:3230`
and `:3306`). With a declared result it also appends the generated result
options object (`:3055`). The resulting call is equivalent to:

```ts
handler(
  generatedEventSchema,
  generatedStateSchema,
  authoredEventSchema,
  authoredStateSchema,
  callback,
  { resultSchema: generatedResultSchema },
)
```

The runtime accepts four arguments, not six
(`packages/runner/src/builder/module.ts:417` and `:559`). It therefore treats
the authored event schema as the callback and ignores the actual callback and
result options. The existing coverage at
`packages/api/test/handler-function-surface.test.ts:65` and
`packages/runner/test/handler-overload-types.test.ts:74` verifies only that the
source expression type-checks; it does not transform or execute this form.

Impact: an explicitly supported public overload compiles into a different ABI
than the runtime implements. Depending on how far the malformed module gets,
the handler can fail to run or carry the wrong schemas and no declared result.

Recommended repair:

- Establish one canonical post-transform handler call shape.
- Determine the authored form from the callback position. When the callback is
  argument zero, inject generated event and state schemas. When the callback is
  argument two, preserve the authored schemas and callback and add only the
  generated result options.
- Add a transform-and-runtime matrix covering inferred versus explicit schemas,
  value-less versus declared results, and callback position. Type-only overload
  probes should remain, but cannot be the behavioral guard.

### V2 — transformed proxy handlers lose writable state

The authored surface supports `handler(callback, { proxy: true })`, including
the declared-result form (`packages/api/index.ts:2571` and `:2591`). Schema
injection intentionally spreads the authored options into the generated
trailing options object
(`packages/ts-transformers/src/transformers/schema-injection.ts:3051`).

The runtime's trailing `HandlerOptions` accepts only `resultSchema`
(`packages/runner/src/builder/module.ts:401`). It detects `proxy` only when the
first runtime argument is still the callback and the second is the authored
options object (`:426`). After transformation the first arguments are schemas
and `{ proxy: true }` is in the fourth slot, so `writableProxy` is never set.

This is not only a latent overload. Production patterns use the affected form,
including `packages/patterns/system/default-app.tsx:47` and
`packages/background-piece-service/bgAdmin.tsx:55`. `writableProxy` affects
both runtime input construction (`packages/runner/src/runner.ts:5851`) and
write-capability analysis (`packages/runner/src/builder/pattern.ts:961`).

Recommended repair:

- Make the canonical trailing options type carry both `proxy?: true` and
  `resultSchema?: JSONSchema`.
- Derive `writableProxy` from canonical options, while retaining the old
  function-first branch only as a compatibility entry point if it is still
  needed.
- Test the authored-form × proxy × declared-result matrix through the real
  transformer and runtime. Include one production-shaped handler that writes
  through a proxied state value.

### V3 — backlog collapse changes payload but not invocation identity

Each queued event has a durable, readonly id
(`packages/runner/src/scheduler/types.ts:180`), minted or accepted when queued
(`packages/runner/src/scheduler/events.ts:321`). Once a stream reaches the
per-stream backlog cap, the scheduler mutates the last pending entry with the
new event's payload, action, provenance, time, and commit callback
(`packages/runner/src/scheduler/events.ts:351`). It does not and cannot update
the entry's readonly id.

A direct scheduler reproduction queued 259 calls with ids `id-1` through
`id-259`. It delivered 256 events; the final payload, `n: 259`, ran as
`id-256`. The settlement callbacks requested for ids 256 through 259 all
received `id-256`. The current test
`packages/runner/test/delivery-shaping.test.ts:555` checks only the delivery
count and newest payload, so the identity corruption is invisible to it.

Impact: a backlogged external invocation can commit under another invocation's
receipt address, and several callers can be told that the older id is theirs.
Payload, receipt, deduplication, and caller-visible settlement no longer name
one logical event.

Recommended repair:

- Do not apply lossy collapse to caller/invocation events or to events carrying
  settlement callbacks.
- Restrict last-wins collapse to explicitly fire-and-forget event classes, or
  reject each displaced invocation explicitly with its own id.
- Represent a mutable queue slot separately from a logical durable event; a
  slot may coalesce work, but must not silently inherit another event's
  identity.
- Extend the cap test with unique event ids and per-send callbacks, asserting
  exactly which invocations ran, committed, or were refused.

### V4 — the receipt cell cannot represent the public result contract

The receipt-only runner branch writes the returned value when
`plainResultReceipts` is enabled and the value is not `undefined`; otherwise it
writes `{}` (`packages/runner/src/runner.ts:5364`). The CLI then interprets
every empty record as a value-less receipt
(`packages/cli/lib/callable.ts:748`). A verb that deliberately declares and
returns `{}` is therefore indistinguishable from a verb that returns nothing.
Other legitimate values with no enumerable record keys, including the
`FabricBytes` primitive whose bytes are private
(`packages/data-model/src/fabric-primitives/FabricBytes.ts:30`), face the same
shape-based ambiguity.

The boundary is also porous in the opposite direction. A value-less concise
action such as `action(() => cell.set(...))` is deliberately allowed by the
transformer (`packages/ts-transformers/test/verb-return-validation.test.ts:69`),
but the returned cell is converted to a link and published in the receipt
(`packages/runner/test/declared-result-e2e.test.ts:298`). An undeclared
reactive result also remains readable (`:422`). That conflicts with the public
meaning of `Stream<E>` as value-less in
`docs/common/verbs-over-the-cli.md:64`.

The underlying problem is representational: one cell is simultaneously the
commit witness, result storage, reactive-result container, and absence marker.
Shape is being asked to recover a declaration that the representation did not
store.

Recommended repair:

- Introduce explicit result-presence and result-declaration metadata, or a
  versioned receipt envelope. Do not infer absence from `Object.keys(value)`.
- Decide and record whether a declared result (`module.resultSchema !==
  undefined`) gates the public result channel. Incidental completion values may
  remain useful internally without becoming a caller-visible result.
- Define compatibility and readback for receipts written before the new
  representation.
- Cover a declared `{}`, a scalar, `FabricBytes`, a value-less chained `set`,
  an undeclared reactive return, collisions, and the experimental flag-off
  path.

### V5 — selection errors can mask that the target is a verb

For `piece get --schema/--select/--filter`, `getCellValue` runs
`deriveSelectedValue` before it classifies the selected path as a verb
(`packages/cli/lib/piece.ts:2849`). The error path consults the verb guard only
for errors beginning with `Cannot access path` (`:2861`). A real filter applied
to a handler fails earlier with a selection error such as
`--filter can only be applied to an array`, so the user sees a misleading data
shape error instead of being directed to `piece call`.

The existing regression test at `packages/cli/test/piece.test.ts:1354` injects
the one specially handled `Cannot access path` error and therefore does not
exercise the natural selector failure.

Recommended repair:

- For result reads, classify a definite verb before evaluating a selection.
  Preserve the current fail-open behavior when classification is uncertain.
- Alternatively, perform the classification before rethrowing every selector
  error rather than recognizing one message prefix.
- Test a real filter and an incompatible projection against an actual stream
  cell, plus a non-verb data value with the same shape error.

### V6 — projection schemas silently accept unknown keys

Projection normalization has a forbidden-key set and an unsupported-key set
(`packages/cli/lib/cell-selection.ts:549`). Every key in neither set is
accepted (`:638`). A probe with the misspelled key `propeties` succeeded rather
than reporting the typo; depending on the surrounding schema, ignored keys such
as `description` or `title` can yield `{}` while the command exits successfully.
This does not widen the read, but it does return a materially wrong answer with
no indication that the request was ignored.

The live implementation plan already identifies this unfinished item at
`docs/plans/verbs-implementation.md:125`. The code also maintains related but
different schema-key vocabularies in
`packages/piece/src/schema-compatibility.ts:69` and
`packages/piece/src/ops/piece-controller.ts:477`, making silent drift likely.

Recommended repair:

- Classify every supplied key as honored, tolerated annotation, tolerated
  validation keyword, or refused. Refuse a key with no classification and name
  it in the error.
- Derive annotation tolerance from the compatibility vocabulary where possible,
  or add a cross-registry invariant test.
- Cover a typo, standard annotations, `tier`, `deprecated`, and every honored
  object/array projection keyword.

### V7 — quoted wrapper verb names miss tier inference

Wrapper-tier inference recognizes a shorthand property and an
identifier-named property assignment, but not a string-literal property name
(`packages/ts-transformers/src/transformers/verb-tier-mark.ts:108`). The same
transformer's generated-schema mutation already accepts identifier and string
literal names (`:327`). A valid return such as
`{ "open-composer": openComposer }` can therefore remain unmarked and appear in
the default verb listing.

Recommended repair:

- Use one static-property-name helper in both the inference and schema mutation
  passes, covering identifiers and string literals at minimum.
- Add a full-transform test for a quoted wrapper verb name. Also add the missing
  positive full-pipeline test for the second tier signal: direct handler
  application bound to a session-scoped cell.

### V8 — live guidance contradicts runtime behavior

The call path correctly explains that a same-id retry runs the handler body
again and only the losing commit is refused
(`packages/cli/lib/callable.ts:748`). Several authoritative live sources still
promise no re-execution:

- `packages/cli/lib/session.ts:5`
- `docs/plans/pattern-verb-contract.md:752`
- `docs/plans/verb-result-selection.md:29`

The result-selection plan then contradicts itself a few lines later by correctly
saying the body re-runs (`docs/plans/verb-result-selection.md:38`). The CLI
README and the `cf` skill also say receipts declare no schema
(`packages/cli/README.md:369` and `.agents/skills/cf/SKILL.md:309`), while the
runner now writes a descriptive shape schema for plain receipt results
(`packages/runner/src/runner.ts:5390`).

The current retry advice in `docs/common/verbs-over-the-cli.md:226` is closer to
the implementation, but “only writes its own space” is not a sufficient safety
criterion: a handler can satisfy that description and still send mail or spend
an external model call before its transaction loses.

Recommended repair:

- Update all live retry guidance together: a same-id retry re-executes, only
  one receipt commit wins, and non-transactional effects can repeat.
- State the safe criterion as “all effects are transaction-confined or
  externally idempotent,” not which Fabric space receives writes.
- Update receipt-selection guidance to distinguish materialization behavior
  from the descriptive schema now stored on receipts.
- Archive completed or superseded live plans rather than leaving mutually
  contradictory current-state claims in them.

### V9 — receipt tests poll instead of waiting on their completion event

`packages/runner/test/declared-result-e2e.test.ts:149` and
`packages/runner/test/scheduler-event-receipts.test.ts:125` define custom
condition loops with a five-second deadline and `setTimeout(0)`. They are used
throughout the central receipt tests. The test already registers the exact
completion signal: the handling commit callback that records each outcome.

This contradicts the repository's event-driven test guidance at
`docs/development/waiting-in-tests.md:294`. It also evades
`deno task check-no-waitfor` because the custom helper name is not one of the
patterns the gate recognizes.

Recommended repair:

- Make the dispatch helper return a `defer()` or promise resolved by its commit
  callback, and await that promise for settlement.
- Use scheduler idle only after the commit when a test needs downstream graph
  quiescence; do not use it as the completion detector.
- Extend the mechanical gate or centralize the helper so another locally named
  polling loop cannot silently replace the event-driven primitive.

## Simplicity and understandability assessment

### Structures worth preserving

- `scopeCallerEventId` binds a caller id to session and complete stream identity
  as structured data. It avoids delimiter-based identity and keeps the opaque
  caller word out of the durable namespace by itself.
- The sender obtains `handlingReceiptLink` from the transaction that actually
  handled the event. The CLI does not duplicate receipt-address derivation.
- `deriveSelectedValue` is shared by ordinary reads and call-result selection,
  so the language is not reimplemented at the command boundary.
- Discovery prefers omission to invented callability, and
  `declaredVerbResults` publishes a result schema only on one unambiguous node
  match.

### Refactors that would lower future defect risk

1. **Canonical handler ABI.** V1 and V2 have one cause: authored overloads and
   the post-transform runtime ABI are not modeled as separate types. Normalize
   every authored form once, then let the builder accept only the canonical
   form internally.
2. **Resolved callable descriptor.** Listing reconstructs a declared result by
   matching compiled nodes (`packages/cli/lib/piece.ts:1865`), help reaches it
   through a separate thunk (`:2054`), and execution sees a receipt rather than
   the declaration. A first-class descriptor containing kind, location, input,
   output, marks, and module identity would make listing, help, completion, and
   execution consume one resolution.
3. **Typed projection intermediate representation.** `cell-selection.ts` is
   2,312 lines and separately carries a normalized schema, link markers,
   projection mask, output schema, and source-read schema. Compile the request
   once to an IR that makes container kind, read requirement, output intent,
   and address-only markers explicit. This would make invalid states harder to
   construct than the present parallel structures.
4. **Logical event versus queue slot.** The scheduler currently mutates a
   logical event as though it were a queue slot. Separate the two so coalescing
   policy cannot accidentally rewrite caller identity.
5. **One normalized-link equality implementation.** Identical
   `areNormalizedLinksSame` implementations exist in
   `packages/runner/src/link-utils.ts:192` and
   `packages/runner/src/link-types.ts:277`. Keep the canonical primitive in one
   low-level module and re-export it if compatibility requires both import
   paths.
6. **Explicit schema-check policies.** Compatibility code currently carries
   contextual booleans for subset proof, evolution, and verb-event treatment.
   Once the evolution policy is decided, use a named policy object or separate
   entry points for strict subset proof and update compatibility. This is a
   maintainability recommendation, not a ruling on whether verb events evolve.

Two comments also make the current system harder to read. The listing comment
at `packages/cli/lib/piece.ts:1915` says listing and dispatch can never disagree,
while the fallback comment at `:1997` explicitly accepts that a markerless
handler can remain dispatchable but omitted. A test comment at
`packages/cli/test/piece-verbs.test.ts:186` still describes a data-field call
as a silent no-op even though the current command path refuses it. Comments
should state the present invariant and its deliberate fail-closed exception.

## Recommended PR sequence

The fixes should be observable as separate review units rather than one verbs
cleanup branch.

1. **Handler ABI and transformer matrix** — V1 and V2. These share one contract
   and should land together so a partial canonicalization cannot create another
   split ABI.
2. **Invocation-safe scheduler backlog policy** — V3. Start with an executable
   failing identity/callback test, then make the coalescing policy explicit.
3. **Receipt representation design and compatibility** — V4. This deserves a
   short design PR or design section before implementation because it changes a
   durable caller-visible format and needs an old-receipt story.
4. **Read error precedence and projection vocabulary** — V5 and V6. Both are
   CLI read-boundary validation and can share end-to-end command tests.
5. **Tier inference and callable-resolution cleanup** — V7 plus the narrow
   shared-property-name refactor. Keep the larger callable descriptor as a
   follow-up unless the small fix naturally exposes the seam.
6. **Contract and test-harness reconciliation** — V8, V9, and the inaccurate
   comments. The documentation can land independently, while the receipt-test
   wait should be a separate commit or PR with no semantic changes.
7. **Architecture follow-ups** — projection IR, callable descriptor, duplicate
   link equality, and schema-policy separation. These are maintainability
   improvements, not prerequisites for every correctness fix above.

## Deliberate exclusions

- The earlier finding that an address-only marker below a link fetched every
  linked document is fixed on this snapshot by #5701. It is not a current
  finding.
- The earlier false handler-output help and stale current-system walkthrough
  were corrected by #5717. They are not repeated here.
- Closed-world verb-event emission was ruled out by the implementation arc. The
  remaining evolution-policy discussion is open and is not reported as a
  correctness blocker.
- Unbuilt roadmap items such as `wish`/`exec` selections, references as call
  arguments, and CLI refusal of undeclared payload fields remain plan work, not
  regressions attributed to the landed code.

## Verification performed

The review combined source tracing with focused behavioral reproductions. The
handler transform, proxy shape, scheduler identity collapse, and projection-key
behavior were reproduced directly. Relevant runner and CLI suites passed,
including declared-result receipt behavior, scheduler receipts and delivery
shaping, piece callable listing/help/call/read behavior, and selection. The
ts-transformers fixture and verb-tier suites passed on the reviewed snapshot:
10 tests, 374 steps.

Passing tests do not negate the findings: V1 and V2 are covered only by type
surface probes, V3's test omits identity and callbacks, V5 stubs the one handled
error shape, V6 is an explicitly unimplemented validation class, and V7 has no
quoted-name case.
