# Pattern verb contract — implementation plan

**Status:** pending. Executes the design in
[`pattern-verb-contract.md`](pattern-verb-contract.md) (PR #4968). Keep current
as work proceeds: check off exit criteria, record scope changes.

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

- **api:** `action` overloads accept a return type (today both overloads type
  the callback `=> void`, `builder/module.ts:606-609`); `Stream<T, R = void>`
  or equivalent so the result type is visible to the schema layer — the
  defaulted parameter keeps every existing `Stream<T>` use compiling. A
  `VerbError { code, message }` type for rule 4's typed rejections.
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
- **Settle before C3 — which signal marks a verb?** "Stream/handler
  properties" is not a single predicate today. `isStream()` accepts three
  independent signals, any one of which suffices: the cell's construction kind,
  `asCell: ["stream"]` in the schema, and a stored `{$stream: true}` value
  (`packages/runner/src/cell.ts:924-946`). If C3 keys emission off the schema
  marker alone, a verb carrying only the stored marker gets no result schema
  and rule 3 silently does not apply to it — and the WS-C exit below would not
  catch that, since it exercises one CTS pattern that does carry the marker.
  That the signals diverge in practice is not hypothetical: the CLI has two
  runtime workarounds for handlers whose schema lost the marker
  (`tryResolvePieceHandler`, and the forced-stream probe in
  `listPieceCallables`, whose comment says so). What is *not* yet established
  is whether any pattern reaches schema-generator in that state. Determine that
  first; if it can, C3 needs a predicate that agrees with dispatch, and the
  exit criterion needs a second fixture that lacks the schema marker.
- ~~**runner:** plain-return projection~~ — **done (C4)**:
  `plainResultReceipts`, default-off, env-reachable
  (`EXPERIMENTAL_PLAIN_RESULT_RECEIPTS`); registry entry in
  `EXPERIMENTAL_OPTIONS.md`, scheduler-v2 §7.6 receipt-content note, both
  flag states tested in `scheduler-event-receipts.test.ts`, including
  same-id redelivery retaining the original result.
- **C1 design fork, decide first:** `Stream<T>` is a branded-cell interface
  wired through a one-slot HKT (`AsStream`, `packages/api/index.ts:1239`), so
  `Stream<T, R = void>` ripples through the cell-type machinery; the
  alternative is a separate declared-result carrier (e.g.
  `StreamWithResult<T, R> extends Stream<T>`) that only the schema layer
  interprets. Settle this at the top of the C1 PR.
- **Exit:** a CTS pattern declares a verb returning `AddTopicResult`; the
  result schema appears in the durable schema; under the flag, both plain and
  reactive returns are readable in the receipt cell.

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
  a special one.
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
- Generic identity annotation for data reads and callable results. Start with
  an exploration form such as `--include-ids` that annotates points where the
  backing identity changes; evaluate a narrower path-selected form if broad
  output is too noisy. Patterns return child references and never manufacture
  their own fid fields for this purpose.
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
| C1 | api: action return types, `Stream<T, R>`, VerbError | M | — |
| C2 | ts-transformers: value-returning action lowering + CTS spec | M | C1 |
| C3 | schema-generator: result schemas for streams + mapping spec | M | C1 |
| C4 | runner: plain-return projection behind flag + registry entry | S | — |
| C5 | schema-generator/runner: closed-world verb input schemas | S | C1 |
| D1 | runner: eventId through send; structured receipt link on dispatch | M | — |
| D2 | cli: --invocation, readback, receipt-exists reclassification, pre-dispatch validation, phase reporting, transaction-local ack | M | D1 |
| D3 | integration: four timeout/retry scenarios | S | D2 |
| D4 | integration + live: three-topic end-to-end fixture | S | C1–C3, D2 |
| E1 | timestamps, error shape + linked retention collection | L | C1–C5, D1–D4, OQ1, CFC review |
| E2 | CFC: specify `AgentActor` mint, propagation, metadata protection + extraction | L | CFC review |
| E3 | cli: trusted ingress provenance for `cf` calls | M | E2 |
| E4 | topics: retire AgentAuthoredEvent | S | E3 + end-to-end provenance proof |
| F1 | cli: `cf piece verbs --json` | S | — (result schemas after C3) |
| F2 | cli: generic identity/path annotation | M | — |
| F3 | cli: `--await` / `--no-wait`, caller-controlled bound | S | D2 |
