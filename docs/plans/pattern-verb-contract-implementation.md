# Pattern verb contract — implementation plan

**Status:** pending. Executes the design in
[`pattern-verb-contract.md`](pattern-verb-contract.md) (PR #4968). Keep current
as work proceeds: check off exit criteria, record scope changes.

**Amended 2026-07-30**, follow-up scope from the pre-dispatch gate review
(#5147): WS-D gains D5 (refuse an absent payload the verb provably cannot run
without) and D6 (the default-relaxation helper moves next to the runner's
validator so C5 shares it instead of re-implementing it), and WS-E records
that pre-dispatch refusals must join the typed-rejection code taxonomy when
codes reach the invocation surface, so agents branch on one signal. Later the
same day, D5's open question was measured (see its bullet): absent events
bypass default materialization entirely, narrowing D5's remaining choice to
refuse-on-unrelaxed-`required` versus normalize-absent-to-`{}`. A third pass
records the C1 review decisions: no bespoke `VerbError` — a separate
`FabricError` effort is underway, the rule-4 carrier will derive from it, and
C1 ships without one; `handler` carries the same explicit-only declared-result
overloads as `action`, reversing the action-only record (both in WS-C); D5's
absence rule settles as normalize-absent-to-`{}`; the reactive-readback claim
is re-confirmed; and the compiled-pattern receipt readback is pinned as a
runner test beside D4's fixture.

**Amended 2026-07-28**, context only — no scope or decision changed: Risks
names #5059 (`cf piece setsrc --check`) as the candidate preflight for the
write-storm gate, WS-F gains a read-path guard so `cf piece get` on a verb
redirects to `cf piece call`, and Non-goals records that constraining
`cf piece set` is out of scope pending a decision this plan does not make. The
design doc carries the same pass's larger share: the llm-dialog handler-branch
precedent, tools restated as deferred rather than rejected, and the
structural-interface property.

**Amended 2026-07-24** from the first live headless session (a three-topic
graph, ~24 CLI operations): compact discovery index (A2), closed-world inputs
(C5), transaction-local acknowledgement as a WS-D exit criterion, phase
reporting and timings (D2), four timeout/retry integration scenarios (D3), the
three-topic end-to-end fixture (D4), the live-acceptance checklist, and the
`setsrc` write-storm gate named in Risks. Merged the same day with the
post-merge review amendments (decisions 5–7: attribution via CFC provenance,
patterns return references while clients render identity, `@name` deferred);
index and fixture wording follows the references model.

## Governing decisions

Made 2026-07-24, shaping everything below:

1. **The authoring surface starts immediately.** Verb return values through
   `action()` / transformers / schema-generator is the critical path and runs
   as its own workstream from day one, in parallel with the small wins.
2. **Plain-return projection ships behind a flag, default-off**, per the
   `EXPERIMENTAL_OPTIONS.md` process; the default flips after the integration
   suite proves readback end to end.
3. **Continuous dogfood.** The live Estuary topics board gets `setsrc` as each
   phase lands. The compat checker gates schema breaks; every phase ends with a
   live-board acceptance pass.
4. **This document plus tracked issues** (breakdown at the end) is the plan of
   record; the design doc's staging section defers here.
5. **Attribution uses CFC provenance.** The invocation envelope does not grow a
   parallel `actor` field. `topics.agentName` stays as an interim atomic
   argument until trusted `cf` ingress can mint and propagate general
   `AgentActor` provenance.
6. **Patterns return references; clients render identity.** Discovery indexes
   carry stable child references and summaries. Fid/path annotation belongs to
   the CLI, which can see backing cell identities.
7. **Client-local `@name` bindings are deferred.** Their overlap with
   fabric-side slugs needs a separate naming design and is not required by this
   plan.

## Non-goals

Named so their absence reads as intent, not oversight:

- The **wrapper-tier marker** for verb listing (semantics are settled in the
  design; the marker mechanism ships after the listing).
- **Cryptographic agent identity / delegation** (design OQ2) — the CFC track
  distinguishes runtime-attested execution context from a separately keyed or
  delegated agent, but does not deliver delegation.
- **Client-local aliases** — `@name` / `cf bind` are deferred pending a
  separate comparison with existing slugs and configured host/space addressing.
- **Cross-space effect atomicity** — the spec's I11 gap stands; the guarantee
  is same-space, which covers `topics`.
- **Constraining direct data writes.** `cf piece set` writes a result field
  directly, past every rule in Part 1 — no declared payload, no atomic unit,
  no typed rejection. The LLM tool surface has no equivalent (it can only
  mutate through verbs), so the CLI is the outlier. Whether this stays a
  sanctioned escape hatch depends on a declarative notion of pattern-managed
  state that does not exist yet (the `readonly`/opt-in-writability question),
  and `set` is also an authoring and debugging tool whose non-agent uses this
  contract does not touch. Until that decision is made, the contract governs
  verbs and says nothing about `set`.
- **Batch / session mode** for the CLI — orthogonal call-cost work, linked
  rather than orphaned: even perfect verbs leave a fresh runtime paying boot
  and sync per call (20–80 s per mutation observed live), so this gets its
  own tracked topic and a dogfood latency target once WS-D's phase timings
  show how much of that is fresh-runtime tax versus quiescence-wait tax. The
  verb surface never changes shape for it (design: the atomic-unit rule).

## Workstreams

### WS-A — `topics` Part 1 finish

Size S–M (~2–4 days). No dependencies. `packages/patterns/topics`.

- `AddTopicEvent` gains optional `body` — argument widening, compat-checker
  clean — and `addTopic` creates the child with it, making `setBody` an
  editing verb rather than part of every create.
- Silent early-returns on mutating verbs become throws: empty title, blank
  `agentName`, empty comment body, invalid link URL. UI composer wrappers
  (`submitTopic`, `submitComment`, `saveBody`, …) keep their silent guards —
  an empty draft is a non-event in a composer, a defect headlessly.
- A compact discovery `index` result on the board — one reference-plus-summary
  row per topic: the child reference plus scalar summaries (`title`,
  `createdAt`, `createdBy`, `commentCount`, `lastActivityAt`) and reference
  edges as sibling references — never expanded pieces, and no pattern-authored
  fid fields (identity rendering is the CLI's job — decision 6, F2).
  `crossrefs` stays as the UI's reference graph; it is not compact — each row
  expands to full pieces, and a live full-board read through it exceeded 300k
  tokens — and stops being the documented survey surface.
- Tests: `topics.test.tsx` / `multi-user.test.tsx` cover body-at-create,
  each thrown rejection (asserting no write happened), and the index
  (asserting no expanded piece/action/runtime values serialize).
- Docs riding the change: `packages/patterns/topics/README.md`,
  `skills/topics/SKILL.md` (`addTopic` example gains `body`;
  `deno task check-skill-facts` gates the citations).
- **Exit:** filing-with-body is five CLI calls; a blank `agentName` fails with
  a nonzero exit; a full-board survey is one bounded read of `index`; live
  board updated via `setsrc` (gated — see Risks).

### WS-B — CLI settlement hygiene

Size S (~1 day). No dependencies. `packages/cli`.

- ~~Replace the `defaultWaitForResult` poll with observed settlement~~ —
  **landed independently as #4946** (2026-07-24): the wait is
  `runtime.settled()`, draining scheduler, storage, and in-flight async
  builtins with no poll interval and no deadline. Scope change recorded; this
  workstream shrank to the second bullet.
- Surface the tool result cell's address in `ExecutedCallable` output
  (`resultRef`), threaded through the exec/piece-call wrappers and printed to
  stderr so stdout stays exactly the tool's JSON result.
- **Exit:** no sleep/poll in the callable wait path (met by #4946);
  `resultRef` returned and printed; `deno task test` in `packages/cli` green.

### WS-C — verb results authoring surface *(critical path)*

Size L (~1–2 weeks). No dependencies; starts immediately.
`packages/api`, `packages/ts-transformers`, `packages/schema-generator`,
`packages/runner`.

- **Results: every published name is permanent, at every depth.** Schema
  compatibility checks results as candidate ⊆ previous, and "results may
  narrow freely" governs *values*, never *named fields*. Measured against
  `assertPatternSchemasBackwardCompatible`:

  | change | verdict |
  | --- | --- |
  | remove a named field, any depth | rejected |
  | add a **required** field, any depth | rejected unless it has a default |
  | add an **optional** field, any depth | allowed |
  | narrow a value type, any depth | allowed |

  Nesting a result under one key confers nothing — the removed-field check
  recurses, so a nested removal is rejected on a nested path exactly as a flat
  one is. So the rule to author against is: publish as few names as the verb
  can live with, and make every later addition optional. The design doc's
  matching paragraph is corrected the same way.
- **Both `action` and `handler` author results; the invariant is
  explicit-only, not which surface.** Reversed in the C1 review (Berni,
  2026-07-30) from an earlier action-only record: `handler` gains the same
  declared-result overloads — `handler<E, T, R>(...)`, reached only by naming
  all three type arguments — so a returning verb compiles against
  `Stream<E, R>` from either surface. What survives from the old rationale is
  the mirror-drift worry, converted into a test obligation: the overloads
  exist in both hand-maintained halves (api `HandlerFunction`,
  `builder/module.ts`), each pinned where its consumer touches it
  (`handler-function-surface.test.ts` on the pattern-facing side,
  `handler-overload-types.test.ts` on the builder side). The `=> any` forms
  absorb every inferred callback first, so an incidental return still never
  declares a result. C2's returning-body error points at declaring the
  result, on whichever surface the author used.
- ~~**api:** `action` overloads accept a return type (today both overloads type
  the callback `=> void` — the `action()` overloads in
  `packages/runner/src/builder/module.ts`); `Stream<E, R = void>`
  so the result type is visible to the schema layer — the defaulted parameter
  keeps every existing `Stream<E>` use compiling.~~ — **done (C1)**.

  **No bespoke `VerbError` — rule 4's typed carrier is deferred** (review,
  2026-07-30): a separate `FabricError` effort is underway and the
  verb-rejection type will derive from it rather than being its own class.
  C1 briefly carried a `VerbError { code, message }` and dropped it. Until
  the derived carrier exists, a rejection is a thrown `Error` whose message
  reaches the caller as prose, and stable codes wait; WS-E's taxonomy bullet
  binds to the derived type when it lands.

  Verb-shaped type parameters read one way throughout: **`E`** the event,
  **`R`** the declared result, **`T`** the handler's bound state where there
  is one. `Handler`/`HandlerFactory`'s second parameter was spelled `R` while
  it meant the event.

  **A result is opt-in by explicit type argument — `action<E, R>(...)` —
  never inferred.** A concise arrow body's completion value is whatever its
  last call returns, and `Cell.set` returns the cell, so inference would
  declare results nobody wrote. TypeScript cannot tell that from a deliberate
  return, so overload 2 absorbs every callback and a result must be asked for
  by name. Contextual typing does not reach it either: annotating the binding
  still selects overload 2 and fails to assign — the intended catch.

  **Type-level stream detection is brand-based** — `AnyStream`
  (`AnyBrandedCell<any, "stream">`), with `StreamEventOf` / `StreamResultOf`
  recovering the halves. A guard spelled `[T] extends [Stream<any>]` pins the
  arity: it means `Stream<any, void>`, which a verb declaring a result does
  not satisfy, so every such guard stopped matching the moment a result
  existed. It failed silently and late — a value-less stream still matches,
  and value-less is every stream in the tree today, so the workspace
  type-checked clean while the break waited for the first `action<E, R>`
  user. This converges the type layer on what the other two already do, which
  is why neither broke: the runtime reads the cell kind, the schema generator
  reads `CELL_BRAND`. Rewriting to `Stream<any, any>` was rejected — it
  re-arms the same trap for a third parameter.

  **Rebuild sites remain the fragile surface.** Pass-through guards preserve
  `T` whole and are arity-independent now, but anything reconstructing a
  stream still names both parameters, so a future axis would be dropped there
  even though detection survives. The tripwire is
  `stream-through-utilities.test.ts`: it asserts the api's own utilities
  preserve a returning stream identically, and fails when a guard is
  reverted.
- **C1 fork — settled: widen `Stream`, do not add a second carrier.** The
  alternative was a separate `StreamWithResult<T, R> extends Stream<T>` that
  only the schema layer interprets, which is tempting because it leaves
  `Stream<T>` and its one-slot `AsStream` HKT untouched. It loses on one
  point that outweighs the rest: **a forgotten annotation stays silent.**
  Because the carrier is a subtype, a verb whose body returns a value but
  whose declaration still reads `Stream<T>` assigns cleanly, and the result
  is erased exactly where the schema layer reads it — the same shape of
  failure as the live board accepting and discarding `agentName`. Widening
  `Stream` makes that a compile error instead, provided `R` sits in a
  structural position rather than a phantom one: a purely unused parameter is
  erased by structural typing (verified — `Stream<string, number>` assigns to
  `Stream<string>` when `R` appears nowhere), while `R` in a property
  position discriminates and forces the author to declare what the body
  returns.
  Prototyped to measure rather than estimate, following the `CELL_INNER_TYPE`
  precedent — a `declare const` unique symbol read as a property, which
  `AnyBrandedCell` already uses for exactly this reason ("without a concrete
  property mentioning T, T would be a phantom parameter"). The workspace
  type-checks clean with `Stream` widened: zero errors.
  **The conditional-type utilities do not need auditing.** An earlier draft of
  this entry called for widening every `[T] extends [Stream<any>]` guard,
  on the theory that a result-carrying stream would silently stop matching.
  It does stop matching — but that does not reach the schema layer, which
  detects wrappers from the author's annotation by two annotation-rooted
  paths: the written `ts.TypeNode` name
  (the wrapper-name check in `schema-generator/src/type-utils.ts`) and the
  `[CELL_BRAND]:
  "stream"` literal on the resolved type
  (`computeCellBrand`, `schema-generator/src/typescript/cell-brand.ts`), whose
  `extractWrapperTypeReference` exposes the full `typeArguments` where `R`
  sits — so detection even survives an alias like
  `type MyVerb = Stream<E, R>`. The
  guards shape inference and authoring ergonomics, not schema extraction, and
  dropping a result there is harmless for every helper that does not care
  about one. Where a guard genuinely mishandles a returning verb it shows up
  as a compile error in that pattern, loudly, and only for verbs that opted
  in — so a single fixture declaring a result catches the class, and guards
  widen reactively when that fixture proves they must. Removing the default
  makes the compiler enumerate all 253 `Stream<` sites, which is a useful
  one-time audit tool but not a prerequisite.
  What must be threaded is the construction path, not the guards:
  `Handler`/`HandlerFactory` return the stream, so they carry the result
  parameter or an author's annotation cannot match what `handler()` produces.
  `AsStream` — one
  slot, `Apply` and `IKeyable` assume that — keeps producing `Stream<A,
  void>`, so a projection through the HKT drops a declared result. That is
  acceptable because streams are leaves: patterns do not `key()` into a
  stream to reach another. Both options need a result parameter threaded
  through `Handler`/`HandlerFactory` regardless, since the factory returns
  the stream, so that work is not a differentiator.
- **ts-transformers:** lowering for value-returning `action` bodies; CTS spec
  updates under `docs/specs/ts-transformer/`. (The runtime side already
  consumes returns — `handleJavaScriptHandlerResult` — so this is authoring
  surface, not execution semantics.)
- **schema-generator:** emit a result schema for stream/handler properties so
  it reaches the piece's **durable** schema — the dependency verb discovery
  named; mapping spec update in
  [the TypeScript-to-JSON-Schema mapping](../specs/schema-generator/ts_to_json_schema_mapping.md).
  Verb **input**
  schemas become closed-world (an undeclared field is a rejection, never
  ignored — design rule 1): emit `additionalProperties: false` for event
  payloads, confirm the runner enforces it at dispatch, and record the rule
  in the mapping spec.

  **A value-less verb wants `{ type: "object", properties: {} }`, not the
  generic `void` sentinel**, which lowers to `{ asCell: ["opaque"] }` — a
  *wrapper* claim ("the result is an opaque cell") rather than a statement
  that there is no result, and it would hand readback a cell to resolve. The
  empty object describes the value the runtime actually writes, since a
  value-less handling's receipt is `{}`; it satisfies rule 3's "a verb that
  produces nothing says so"; and leaving `additionalProperties` **undefined**
  keeps it open, because the compat checker reads `additionalProperties ??
  true`. Emitting `false` there would freeze a verb as value-less forever.
  Deliberately the opposite of verb *inputs*, which close so an undeclared
  field is a rejection.

  **`AsStream` stays single-slot**, so `Stream.for<Event, Result>()` cannot
  construct a result-carrying stream. Acceptable because verbs come from
  `action`/`handler` and streams are leaves. If it ever bites, the cost is
  bounded: `AsStream` has three non-test uses, and widening is four defaulted
  edits — `_B` on `HKT` (implementors inherit it), `Apply<F, A, B = void>`,
  `<T, R = void>` on `CellTypeConstructor`'s `new`/`of`/`for`, and `AsStream`'s
  two-slot projection. Every step carries a default, so no call site moves.
- **Which signal marks a verb — checked, and C3 is not exposed to it.** An
  earlier revision of this bullet warned that "stream/handler properties" is
  not one predicate, because `Cell.isStream` accepts three independent signals
  — construction kind, `asCell: ["stream"]` in the schema, and a stored
  `{$stream: true}` value (`Cell.isStream`, `packages/runner/src/cell.ts`) — and that
  C3 might therefore skip verbs carried only by the stored one. That warning
  was misdirected. C3 runs in schema-generator, off the **TypeScript checker**:
  `getWrapperSchemaFromCallable` reads a property's call signatures and asks
  `getCellWrapperInfo` whether the return type is a `Stream`
  (`packages/schema-generator/src/formatters/object-formatter.ts`). The
  `asCell` marker is that check's *output*, not its input, and the stored
  `{$stream: true}` value is a runtime artifact schema-generator never sees. A
  result schema would ride the same type check that already emits the marker,
  so the two travel together: a property is either recognized as a stream and
  gets both, or is unrecognized and is skipped from `properties` and `required`
  entirely (mapping spec, "Functions / callables / constructables"). There is
  no state where the marker lands and the result schema does not. Verified on
  `packages/patterns/topics/main.tsx`: `addTopic`, `setMyName`, and
  `submitTopic` all emit `asCell: ["stream"]` from their `Stream<T>`
  declarations.
- **The residual check, which belongs to durable-schema readers rather than to
  C3:** the bullet above requires the result schema to reach the piece's
  *durable* schema, and only generation was verified — not persistence. If
  anything strips `asCell` between generation and storage, every consumer that
  reads verbs back from a stored schema is affected, this workstream included.
  The three-signal divergence is real at runtime, which is why the CLI carries
  two workarounds for handlers whose stored schema lacks the marker
  (`tryResolvePieceHandler`, and the forced-stream probe in
  `listPieceCallables`). Worth confirming before anything downstream depends on
  reading verbs out of a durable schema; the design doc's structural-interface
  note rests on the same question.
- ~~**runner:** plain-return projection~~ — **done (C4)**:
  `plainResultReceipts`, default-off, env-reachable
  (`EXPERIMENTAL_PLAIN_RESULT_RECEIPTS`); registry entry in
  `EXPERIMENTAL_OPTIONS.md`, scheduler-v2 §7.6 receipt-content note, both
  flag states tested in `scheduler-event-receipts.test.ts`, including
  same-id redelivery retaining the original result.
- ~~**C1 design fork, decide first:** `Stream<T>` is a branded-cell interface
  wired through a one-slot HKT (`AsStream`, `packages/api/index.ts`), so
  `Stream<T, R = void>` ripples through the cell-type machinery; the
  alternative is a separate declared-result carrier (e.g.
  `StreamWithResult<T, R> extends Stream<T>`) that only the schema layer
  interprets. Settle this at the top of the C1 PR.~~ — settled in #5123; the
  decision and its measured costs are the **C1 fork — settled** bullet above.
- **Exit:** a CTS pattern declares a verb returning `AddTopicResult`; the
  result schema appears in the durable schema; under the flag, both plain and
  reactive returns are readable in the receipt cell. The plain half of that
  readback is pinned at the runner already — `declared-result-e2e.test.ts`
  compiles a declared-result pattern through the real pipeline and reads the
  receipt back through `tx.handlingReceiptLink`, both flag states — landed
  with C1 per review (2026-07-30) in addition to D4's fixture, which stays
  the end-to-end criterion.
- **The reactive half of that exit needs no new machinery** (Berni,
  2026-07-29): `await cell.pull()` on the receipt already ensures the pattern
  on that cell, if there is one, has run. The readback the CLI performs is
  therefore the same call for a plain return and a launched one, and the
  difference stays inside `pull()`. Recorded rather than assumed — the claim
  is the architect's about his own machinery, and this plan has not yet
  exercised a reactive return end to end. Re-confirmed by Berni in the C1
  review round (2026-07-30).

### WS-D — invocation plumbing

Size M (~1 week). Idempotency portion has no dependencies; result readback
joins WS-C. `packages/runner` (`cell.ts` send path), `packages/cli`.

- ~~**runner:** thread a caller-supplied `eventId`; expose the receipt link
  structurally~~ — **done (D1)**: `cell.send(event, onCommit, { eventId })`
  internal options thread to `queueEvent`, and `tx.handlingReceiptLink`
  (mirroring `dispatchedEventId`) carries the receipt address to the sender's
  commit callback on success AND on `receipt-exists` collision — the loser
  receives the winner's outcome address; nobody parses error prose or
  reconstructs `{ $ctx, $event }` client-side. The caller's key is bound to
  its stream on the way in (`scopeCallerEventId`): a receipt derives from the
  handler's input bindings plus the event id, and bindings alone do not
  identify the verb, so an unscoped key lets one id reused across two verbs of
  a piece collide — the second call is reported as an already-settled success
  it never made. Scoping restores what minted ids had, since every minted id
  ends in the stream link. The binding is a content hash over the caller's key
  plus the whole link, not a delimited join: the caller's half is opaque, so
  concatenation would let a chosen id shift the separator.

  The alternative — a client-side helper that derives the receipt cell rather
  than receiving its address — was raised again in review (Berni, 2026-07-29)
  as an equal option. It is not equal, for a reason worth keeping written
  down: **the receipt is not derivable from the event id alone.** Its cause is
  the handler's bound closure *plus* the event id, as this document already
  states. A helper would have to reconstruct `$ctx` from the callable cell at
  every call site — the client-side reconstruction the callback route exists
  to avoid, and the same fact that makes caller-key scoping necessary.
- ~~**cli:** `--invocation <id>` on `piece call` (UUID minted and printed by
  default, including when the wait times out); after commit, sync and read the
  receipt (a cold plain read returns `undefined` — sync first); reclassify
  `precondition: "receipt-exists"` as success-with-readback, exit 0. Output is
  the `Invocation` JSON — `status` and `id` from day one, `result` once WS-C
  lands.~~ — **done (D2)**: `cf piece call` mints a UUID (or takes
  `--invocation <id>`), prints `invocation: <id>` to stderr at dispatch —
  before any network work — and re-prints it with the furthest phase on every
  failure exit; the receipt reads back through `tx.handlingReceiptLink`
  (pull = sync + read); `precondition: "receipt-exists"` settles as success
  with the original outcome (`deduplicated: true`), exit 0; stdout is the
  settled `Invocation` JSON (`invocation`, `status`, `result` when the
  receipt carries a value).
- **cli, pre-dispatch validation:** `piece call` validates the payload against
  the *deployed* verb schema before sending — an undeclared or malformed
  field is an immediate local rejection. This is the half that catches
  skill-versus-deployment skew (the live board accepted and discarded
  `agentName`); the closed-world schema (C5) is the server-side backstop for
  other callers.
- **cli, phase reporting:** every output — success, failure, timeout — carries
  the furthest observed `phase`
  (`initial_sync | dispatched | committed | readback`) beside the invocation
  id — **done (D2)** for the annotation (tracked through an `onPhase`
  callback, printed on failure exits); verbose output adds per-phase timings
  (initial sync / dispatch / handler / commit / result sync / readback) —
  still open. With a caller-supplied id a retry is safe in every phase, so
  phase is diagnosis; a derived `retrySafe` convenience flag may ride along.
- ~~**Acknowledgement is transaction-local.** The call path awaits *this
  handling's* commit (D1's commit callback) plus receipt sync — never
  `runtime.idle()` / full-sync quiescence, which today holds a committed
  write hostage to downstream recomputation (60–80 s body writes observed
  live while `crossrefs` re-derived).~~ — **done (D2)**: the handler send
  path awaits only the commit callback and the receipt pull; a unit test
  fails if the path ever awaits `runtime.idle()` or `manager.synced()`. The
  live acceptance check — a deliberately slow derived recomputation cannot
  delay `addTopic` acknowledgement — rides with D3's integration scenarios.
- ~~Integration tests (isolated toolshed, `isolated-test-processes`
  conventions), four timeout/retry scenarios: timeout before dispatch (retry
  re-executes; one topic); timeout after dispatch, before commit
  acknowledgement; commit succeeded but the response was lost (retry
  collides, reads the original back, exits 0); and a retry from a fresh
  process with the same id — in every case exactly one topic exists
  afterwards.~~ — **done (D3)**: `run_piece_call_retry` in
  `packages/cli/integration/integration.sh`, running in the existing
  `piece-call` shard against its own toolshed, each scenario in its own
  space. Every scenario ends on the same assertion — exactly one message
  recorded — because that is the property an agent depends on. The
  killed-after-dispatch case is triggered by the CLI's own `invocation:`
  announcement, read through a blocking pipe read, so it lands in the window
  without racing a clock; a `--message` that differs on the retry proves the
  settled outcome stands rather than being overwritten. Each scenario spawns
  a fresh `cf` process, so the fresh-process case is the default rather than
  a special one. One half of the third scenario is not covered yet: the
  collision is asserted through `deduplicated` and exit 0, but not by reading
  a *result* back off the receipt, because a void verb leaves none to read.
  That assertion joins when WS-C gives verbs return values — or sooner
  against `plainResultReceipts`.
- **cli, absent-payload gate (D5) — follow-up the pre-dispatch gate's review
  deferred.** The pre-dispatch validator passes `input === undefined`
  unconditionally (`verbInputSchemaError`, `packages/cli/lib/callable.ts`),
  so a call that sends *nothing* against a verb whose event schema requires
  fields still dispatches, runs the handler with `$event === undefined`, and
  silently spends the invocation id — the failure class the gate closes for
  typo'd payloads, reached by the second-most-likely agent mistake:
  forgetting the payload rather than misspelling a field. The gate's
  "value-less verbs are a supported shape" rationale conflates a VERB that
  declares no event with a CALLER that sent nothing; they are
  distinguishable. The rule — refuse only on proof, stay fail-open on
  uncertainty: refuse an absent payload iff the schema, after
  `relaxDefaultedRequired` and after resolving a top-level local `$ref`
  (reuse `localRefTarget`; a stream's schema is often
  `{ $ref: "#/$defs/X", asCell: ["stream"], $defs: {...} }`), is an object
  schema with non-empty `required` — no absent payload can ever satisfy it.
  Everything else keeps today's behavior: schema `undefined` / `true`,
  boolean `false` (absent must pass; supplied is already refused), object
  schemas with no post-relaxation `required`, and combinator roots — an
  `anyOf`/`oneOf` whose every branch has non-empty relaxed `required` may
  refuse only with a test proving it, otherwise the helper's doc comment
  names it out of scope. Conservative and documented beats clever and
  silent. Characterize first: a CLI unit test pins that an absent payload
  currently dispatches against a required-fields schema, then flips to
  assert refusal — the same order the gate's runner characterization took.
  The question this bullet once left to experiment is now measured
  (2026-07-30, scratch runner test on the gate's branch, recorded on
  #5147): defaults materialize only for a **present** object payload —
  `SchemaObjectTraverser.traverseObjectWithSchema` fills each missing
  defaulted property before checking `required` — while a wholly absent
  event bypasses the object branch entirely, so the handler sees
  `undefined` and the receipt still spends the id even when every required
  property carries a default. Relaxation is therefore honest for present
  payloads and the wrong lens for the absence decision: an all-defaulted
  `required` list does not make absence deliverable. **Settled (Berni,
  2026-07-30): normalize an absent payload to `{}`** where the verb's schema
  is an object schema, so defaults engage and absence flows through the same
  gate as any payload — `{}` fails the relaxed schema exactly when top-level
  `required` survives relaxation, so the refusal set the rule above
  describes is unchanged; what changes is the fail-open corner, which now
  delivers a defaults-populated object instead of `undefined`. Boolean
  `false` and non-object schemas keep today's absent-passes behavior —
  normalization applies only where an object schema makes `{}` meaningful.
  The measured behavior belongs in the helper's doc comment. Plumbing reuses
  `VerbInputValidationError` with a detail that says no payload was supplied
  and names the missing requirement ("send a payload" must read differently
  from "fix your payload"); both entry points (piece call and mounted exec)
  flow through the shared `assertVerbInputSatisfiesSchema` call site.
  Integration: `run_piece_call_retry` gains the mirror of the gate's
  scenario 5 — absent payload refused locally, zero messages recorded,
  corrected call under the SAME invocation id records exactly one. The
  gate's plan wording ("a call with no payload at all stays legal") narrows
  in the same change: legal only when the relaxed schema requires nothing;
  a provably-unsatisfiable absence is refused pre-dispatch like any other
  unfit payload. Migration note for the PR: calls that previously "settled"
  with no payload against a required-fields verb now fail locally and are
  retryable under the same invocation id.
- **runner/cfc, relocate the relaxation helper (D6).**
  `relaxDefaultedRequired` and `localRefTarget` re-implement the runtime's
  default-satisfaction rule inside `packages/cli/lib/callable.ts`, and C5
  (closed-world inputs enforced at dispatch) needs the identical relaxation
  server-side — two copies of "what does a default satisfy" is how the CLI
  and the runtime drift apart, the residual-risk class the gate's own
  design named. Move both next to `validateSchemaValue` under
  `packages/runner/src/cfc/` (following that module's conventions), export
  from the defining module, and import directly in the CLI — no re-export
  shims. The relaxation unit tests move to the runner with the code; the
  CLI keeps the tests that exercise the *gate* (refusal at both entry
  points, id not spent) — those test CLI behavior, not the helper. The
  helper's doc comment grows the list of what it does not check
  (`additionalProperties`, `patternProperties`, and the other validations
  `validateSchemaValue` applies but the relaxer doesn't — each a potential
  refused-but-valid call if a generated schema leans on a required property
  there); naming the boundary is the point. Pure move plus doc comment, no
  behavior change, its own commit beside D5 so the diff reviews as such.
- **Exit (Phase 2, before WS-C):** the duplicate-on-retry bug is dead on the
  live board. **Exit (Phase 4, with WS-C):** the retry returns the original
  result.

### WS-E — retention and CFC execution provenance *(gated)*

Size L, most unknowns. After WS-C and WS-D. `packages/runner`,
`packages/piece`, `packages/cli`, `packages/patterns/topics`.

The retention half is gated on three resolutions, in order:

1. Design OQ1 — the default retention window (it bounds the idempotency
   guarantee).
2. The CFC label review for stored invocation records
   (`docs/specs/cfc-label-metadata-confidentiality.md`).
3. Confirmation of the storage layer's collection story for unreferenced
   cells (the open unknown in the design's defects section).

Then: timestamps / typed error shape in the record (schema authored
open-world); the collection linked from the piece with pattern-declared range +
default and read-and-expire.

- **One rejection taxonomy.** Two "fix your input" signals exist ahead of
  this workstream, and today neither carries a stable code:
  `VerbInputValidationError` (CLI pre-dispatch refusal) and a thrown `Error`
  in the verb body (rule 4's rejection, whose typed carrier is deferred to
  derive from `FabricError` — see WS-C). When this workstream puts codes on
  the invocation surface, the `FabricError`-derived rejection type and the
  pre-dispatch refusal must speak the same taxonomy — e.g. a reserved
  `INVALID_INPUT` code — so an agent branches one way, not two. Recorded so
  the convergence is a plan, not a rediscovery; no code field ships before
  this workstream.

The provenance half is a separate CFC-gated track:

- Specify a runtime-minted provenance atom, provisionally `AgentActor`, for
  trusted execution context at ingress. Its metadata may include agent role,
  tool/session context, or a protected reference to the triggering request; it
  is not reduced to a display name.
- Fix the external `cf` call boundary so it mints the atom from trusted client
  context and attaches it to the invocation input. Prove that CFC flow labels
  carry it to writes affected by that input.
- Define metadata confidentiality and extraction/display helpers before rich
  context is exposed. Prompt or user-request content must not be copied into an
  ordinary invocation payload.
- Keep `AgentAuthoredEvent { agentName }` in `topics` until the provenance path
  works end to end. Only then retire it; dropping the required input field is
  argument widening and compatible.

- **Exit:** records are enumerable and expire per policy; CFC inspection proves
  execution provenance reaches affected writes from `cf`; Topics can omit
  `agentName` without losing display attribution; the invocation record has no
  independent canonical actor field.

### WS-F — client affordances

Size M, mostly parallel. `packages/cli`, `skills/cf`.

- ~~`cf piece verbs --json`~~ — **shipped** (F1): name, kind, on
  (result/input), input schema per verb; tools carry their output schema.
  Walks result-then-input with the same classification `cf piece call`
  resolves through — including the forced-stream fallback path. v1 lists
  everything per the decided semantics; handler result schemas appear once
  WS-C lands, tier filtering with the marker, later. The 2026-07-24 amendment is absorbed: the listing carries the
  deployed pattern's source identity (skew detection).
- Generic identity annotation for data reads and callable results
  (`--show-links` / `--include-ids`). Patterns return child references and
  never manufacture their own fid fields for this purpose. Two shapes were
  weighed (Berni, 2026-07-29): an inline `"@ID": { doc?, path?, space?,
  scope? }` wherever the doc id or scope changes, versus provenance beside the
  value as a `{ "/path": <link> }` dictionary.

  **Take the second.** Berni's own objection settles it: inline cannot
  annotate a **scalar**, and a scalar can be its own doc, so the format needs
  a special case exactly where results are simplest — and an irregular format
  costs an agent more than a verbose one. A second reason follows from the
  result rule above: an inline `@ID` inside a schema-described result is
  either undeclared (the tolerated-but-undeclared shape rule 1 exists to kill)
  or declared, and then permanent at every path it appears, for provenance
  metadata.

  Not a new format either — the llm-dialog tool path already returns the link
  as a sibling of the value, never inside it. Placement is a `links` field on
  the Invocation JSON rather than a second stdout block: `resultRef` is
  already recorded as advisory until the invocation protocol carries it there,
  and Invocation is required to be authored open-world precisely so protocol
  fields can be added later. Cost is bounded by emitting links only for paths
  that have them, and only when asked.
- **Read-path guard:** `cf piece get` on a path that resolves to a verb returns
  the stream's serialization rather than redirecting. The llm-dialog `read`
  tool already rejects this case with the right message — "Path resolves to a
  handler; use invoke() instead" — and the CLI read path
  (`packages/cli/lib/piece.ts`, `getCellValue`) has no equivalent check. Cheap,
  and it saves an agent a wasted turn.
- `--await` / `--no-wait` and the caller-controlled wait bound — with WS-D.
- Skill updates ride each surface (`skills/cf`, `skills/topics`): the handle
  lookup and verification read leave the documented workflow when Phase 4
  makes them unnecessary.

## Phases

```text
Phase 1 (parallel, now): WS-A, WS-B, WS-F verb listing + identity
                         annotation; WS-C starts
Phase 2: WS-D idempotency-only  → duplicate bug dead on the live board
Phase 3: WS-C lands             → topics verbs return values; flag still off
Phase 4: WS-C + WS-D join       → full Invocation JSON; --await; flag flips
                                   after the three-topic fixture (D4) passes;
                                   skills drop the lookup/verification steps
Phase 5: WS-E                   → retention + CFC provenance; only then may
                                   AgentAuthoredEvent go
```

Every phase ends with a live-board acceptance pass (continuous dogfood), and
live docs — skills, specs, `EXPERIMENTAL_OPTIONS.md`, this plan — ride the
change that alters them.

## Test strategy

- **Unit**, per package, riding each change: pattern tests (WS-A), CLI tests
  (WS-B/D/F), `scheduler-event-receipts.test.ts` extensions (WS-C/D),
  transformer fixtures and schema-generator goldens (WS-C).
- **Integration:** the four timeout/retry scenarios (WS-D) exercise id
  plumbing, collision, reclassification, and readback against an isolated
  toolshed.
- **End-to-end fixture (D4, Phase 4):** the three-topic graph from the live
  session, run as an integration test and as the live pass — create an
  umbrella with body (returns its child reference); create two children whose
  bodies reference it; revise the umbrella to reference both; deliberately
  drop one create response and retry with the same invocation id. Verify
  exactly three topics; each returned reference renders to a fid that opens
  the canonical child; reciprocal derived references; every write attributed
  to the acting agent. Record command
  count, payload sizes, per-phase timings, and cold/warm durations — the
  baseline the session-mode decision (Non-goals) reads.
- **Live acceptance checklist**, per phase, against the Estuary board — a
  scenario per phase (six-call filing shrinking to five in Phase 1, a
  deliberate duplicate retry in Phase 2, a returned handle in Phase 4), and
  on every pass:
  - deployed verb schema / source identity matches the skill driving it;
  - body-at-create preserves exact Markdown;
  - the returned reference, rendered as a fid/path by the CLI, opens the
    canonical child, not an intermediate wrapper;
  - attribution persists in `createdBy` / `bodyUpdatedBy`;
  - an undeclared field fails with a nonzero exit;
  - a full-board discovery read stays bounded;
  - commit acknowledgement does not wait on cross-reference recomputation;
  - update rehearsal and commit-rate monitoring pass before any live
    `setsrc` (Risks — the write-storm gate).
- **Doc gates:** `deno task check-docs`, `deno task check-skill-facts` on
  every change touching docs or skills.

## Risks

- **`Stream<T, R>` type ripple** (WS-C): `Stream` appears throughout `api`
  consumers; the defaulted parameter is the mitigation, and the api change
  lands first so downstream packages absorb it incrementally.
- **Receipt-link exposure touches the storage tx error surface** (WS-D): the
  structured rejection field needs coordination with the storage/scheduler
  owner rather than a drive-by.
- **Live-board regressions** (decision 3): mitigated by the compat checker on
  every `setsrc`, phase-scoped changes, and the board being explicitly a
  dogfood surface.
- **Decision 3 is not yet satisfiable: the live board still runs the legacy
  schema.** Prod updates are gated by the write-storm incident history (a
  prior update drove cross-version write storms to 96% of all commits):
  before any live `setsrc`, rehearse old→populate→new in a scratch space
  watching commit rates, and verify the generated-cell identity-versioning
  fix is an ancestor of the deployed revision (`git merge-base
  --is-ancestor`; the computed-cell-identity arc — #4659, default-on in
  #4956, merged 2026-07-24 — is the candidate fix; confirm before the first
  Phase 1 deploy). Until the gate clears, a "live-board acceptance pass"
  degrades to a scratch board and must say so rather than pass silently.
  **#5059 (`cf piece setsrc --check`) is the candidate preflight for this
  gate:** it answers whether a source can be applied to a given piece before
  attempting it, driving the real rules in dry-run — the schema subset proof,
  the CFC envelope merge, the retained-link validator — rather than a second
  copy of them. It does not measure commit rates, so the rehearsal above
  stands; what it removes is discovering an incompatibility by attempting the
  swap on the live board.
- **WS-E's gates may stall it** (OQ1, CFC review, collection unknown, trusted
  ingress mint and propagation): it is last and severable; everything through
  Phase 4 delivers without it, and `topics.agentName` remains the safe interim.

## Issue breakdown

Importable one-to-one into the tracker; `blocks →` names the dependency edge.

| id | title | size | depends on |
| --- | --- | --- | --- |
| A1 | topics: body at create + thrown rejections | S | — |
| A2 | topics: reference-plus-summary discovery index | S | — |
| B1 | cli: sink-based settlement, result cell address | S | — |
| C1 | api: action return types, `Stream<E, R>` (rejection carrier deferred to `FabricError`) | M | — |
| C2 | ts-transformers: value-returning action lowering + CTS spec | M | C1 |
| C3 | schema-generator: result schemas for streams + mapping spec | M | C1 |
| C4 | runner: plain-return projection behind flag + registry entry | S | — |
| C5 | schema-generator/runner: closed-world verb input schemas | S | C1 |
| D1 | runner: eventId through send; structured receipt link on dispatch | M | — |
| D2 | cli: --invocation, readback, receipt-exists reclassification, pre-dispatch validation, phase reporting, transaction-local ack | M | D1 |
| D3 | integration: four timeout/retry scenarios | S | D2 |
| D4 | integration + live: three-topic end-to-end fixture | S | C1–C3, D2 |
| D5 | cli: refuse a provably-unsatisfiable absent payload | S | D2 pre-dispatch gate (#5147) |
| D6 | runner/cfc: relocate `relaxDefaultedRequired` + `localRefTarget` (C5 consumes) | S | D5 (same PR, own commit) |
| E1 | timestamps, error shape + linked retention collection | L | C1–C5, D1–D4, OQ1, CFC review |
| E2 | CFC: specify `AgentActor` mint, propagation, metadata protection + extraction | L | CFC review |
| E3 | cli: trusted ingress provenance for `cf` calls | M | E2 |
| E4 | topics: retire AgentAuthoredEvent | S | E3 + end-to-end provenance proof |
| F1 | cli: `cf piece verbs --json` | S | — (result schemas after C3) |
| F2 | cli: generic identity/path annotation | M | — |
| F3 | cli: `--await` / `--no-wait`, caller-controlled bound | S | D2 |
