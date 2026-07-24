# Pattern verb contract — implementation plan

**Status:** pending. Executes the design in
[`pattern-verb-contract.md`](pattern-verb-contract.md) (PR #4968). Keep current
as work proceeds: check off exit criteria, record scope changes.

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

## Non-goals

Named so their absence reads as intent, not oversight:

- The **wrapper-tier marker** for verb listing (semantics are settled in the
  design; the marker mechanism ships after the listing).
- **Actor authentication / delegation** (design OQ2) — the envelope carries an
  unverified actor regardless of how that lands.
- **Cross-space effect atomicity** — the spec's I11 gap stands; the guarantee
  is same-space, which covers `topics`.
- **Batch / session mode** for the CLI — orthogonal call-cost work.

## Workstreams

### WS-A — `topics` Part 1 finish

Size S (~1–2 days). No dependencies. `packages/patterns/topics`.

- `AddTopicEvent` gains optional `body` — argument widening, compat-checker
  clean — and `addTopic` creates the child with it, making `setBody` an
  editing verb rather than part of every create.
- Silent early-returns on mutating verbs become throws: empty title, blank
  `agentName`, empty comment body, invalid link URL. UI composer wrappers
  (`submitTopic`, `submitComment`, `saveBody`, …) keep their silent guards —
  an empty draft is a non-event in a composer, a defect headlessly.
- Tests: `topics.test.tsx` / `multi-user.test.tsx` cover body-at-create and
  each thrown rejection (asserting no write happened).
- Docs riding the change: `packages/patterns/topics/README.md`,
  `skills/topics/SKILL.md` (`addTopic` example gains `body`;
  `deno task check-skill-facts` gates the citations).
- **Exit:** filing-with-body is five CLI calls; a blank `agentName` fails with
  a nonzero exit; live board updated via `setsrc`.

### WS-B — CLI settlement hygiene

Size S (~1 day). No dependencies. `packages/cli`.

- Replace `defaultWaitForResult` (25 ms poll, 15 s ceiling,
  `lib/callable.ts:206-222`) with settlement observed through the existing
  `running.sink(…)` path. The default time bound remains until WS-F makes the
  wait caller-controlled, but it bounds an observation, not a poll.
- Surface the tool result cell's address in `ExecutedCallable` output.
- **Exit:** no sleep/poll in the callable wait path; `deno task test` in
  `packages/cli` green.

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
  `docs/specs/schema-generator/ts_to_json_schema_mapping.md`.
- **runner:** plain-return projection — the receipt-only branch
  (`runner.ts:3713-3725`) writes the validated plain return instead of `{}`,
  behind a new experimental option (registry entry in
  `docs/development/EXPERIMENTAL_OPTIONS.md` with owner and end state:
  default-off → flip after Phase 4's integration proof → fold in). Spec note
  in scheduler-v2 §7.6 (receipt content), and
  `packages/runner/test/scheduler-event-receipts.test.ts` extended for both
  plain and reactive-bearing returns.
- **Exit:** a CTS pattern declares a verb returning `AddTopicResult`; the
  result schema appears in the durable schema; under the flag, both plain and
  reactive returns are readable in the receipt cell.

### WS-D — invocation plumbing

Size M (~3–5 days). Idempotency portion has no dependencies; result readback
joins WS-C. `packages/runner` (`cell.ts` send path), `packages/cli`.

- **runner:** thread a caller-supplied `eventId` from `cell.send()` to
  `queueEvent` (the parameter exists — `facade.ts:1308`; the send path passes
  none — `cell.ts:1276`). Expose the receipt cell's link **structurally
  through the dispatch path**: the commit callback on success, a structured
  field on the `receipt-exists` rejection on collision. Both branches already
  know the cell; nobody parses error prose, and the CLI never reconstructs
  `{ $ctx, $event }` client-side.
- **cli:** `--invocation <id>` on `piece call` (UUID minted and printed by
  default, including when the wait times out); after commit, sync and read the
  receipt (a cold plain read returns `undefined` — sync first); reclassify
  `precondition: "receipt-exists"` as success-with-readback, exit 0. Output is
  the `Invocation` JSON — `status` and `id` from day one, `result` once WS-C
  lands.
- Integration test (isolated toolshed, `isolated-test-processes`
  conventions): file a topic, kill the process, retry the same id from a
  fresh process; assert exactly one topic exists and the retry exits 0.
- **Exit (Phase 2, before WS-C):** the duplicate-on-retry bug is dead on the
  live board. **Exit (Phase 4, with WS-C):** the retry returns the original
  result.

### WS-E — envelope and retention *(gated)*

Size L, most unknowns. After WS-C and WS-D. `packages/runner`,
`packages/piece`, `packages/patterns/topics`.

Gated on three resolutions, in order:

1. Design OQ1 — the default retention window (it bounds the idempotency
   guarantee).
2. The CFC label review for stored invocation records
   (`docs/specs/cfc-label-metadata-confidentiality.md`).
3. Confirmation of the storage layer's collection story for unreferenced
   cells (the open unknown in the design's defects section).

Then: `actor` / timestamps / typed error shape in the record (schema authored
open-world); the collection linked from the piece with pattern-declared
range + default and read-and-expire; retire `AgentAuthoredEvent` in `topics`
(dropping a required input field is argument widening — compatible).

- **Exit:** an agent passes no `agentName`; attribution rides the envelope;
  records are enumerable and expire per policy.

### WS-F — client affordances

Size M, mostly parallel. `packages/cli`, `skills/cf`.

- `cf piece verbs --json` — name, kind, input schema per verb from the
  existing classification (`packages/fuse/callables.ts:88`); result schemas
  appear once WS-C lands; v1 lists everything, per the decided semantics
  (every verb listable; tier filtering arrives with the marker, later).
  **Independent — can ship first.**
- `@name` client-side binding: `cf bind <name> <url>`, resolution in
  `piece call` / `piece get`; stored client-side (it must resolve before the
  fabric is reachable).
- `--await` / `--no-wait` and the caller-controlled wait bound — with WS-D.
- Skill updates ride each surface (`skills/cf`, `skills/topics`): the fid
  lookup and verification read leave the documented workflow when Phase 4
  makes them unnecessary.

## Phases

```text
Phase 1 (parallel, now): WS-A, WS-B, WS-F verbs-listing + binding; WS-C starts
Phase 2: WS-D idempotency-only  → duplicate bug dead on the live board
Phase 3: WS-C lands             → topics verbs return values; flag still off
Phase 4: WS-C + WS-D join       → full Invocation JSON; --await; flag flips
                                   after the integration proof; skills drop
                                   the lookup/verification steps
Phase 5: WS-E                   → envelope, retention, AgentAuthoredEvent gone
```

Every phase ends with a live-board acceptance pass (continuous dogfood), and
live docs — skills, specs, `EXPERIMENTAL_OPTIONS.md`, this plan — ride the
change that alters them.

## Test strategy

- **Unit**, per package, riding each change: pattern tests (WS-A), CLI tests
  (WS-B/D/F), `scheduler-event-receipts.test.ts` extensions (WS-C/D),
  transformer fixtures and schema-generator goldens (WS-C).
- **Integration:** the cross-process retry test (WS-D) is the load-bearing
  one — it exercises id plumbing, collision, reclassification, and readback in
  one scenario, against an isolated toolshed.
- **Live acceptance**, per phase, against the Estuary board: the six-call
  filing sequence shrinking to five (Phase 1), a deliberate duplicate retry
  (Phase 2), a returned handle (Phase 4).
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
- **WS-E's gates may stall it** (OQ1, CFC review, collection unknown): it is
  last and severable; everything through Phase 4 delivers without it.

## Issue breakdown

Importable one-to-one into the tracker; `blocks →` names the dependency edge.

| id | title | size | depends on |
| --- | --- | --- | --- |
| A1 | topics: body at create + thrown rejections | S | — |
| B1 | cli: sink-based settlement, result cell address | S | — |
| C1 | api: action return types, `Stream<T, R>`, VerbError | M | — |
| C2 | ts-transformers: value-returning action lowering + CTS spec | M | C1 |
| C3 | schema-generator: result schemas for streams + mapping spec | M | C1 |
| C4 | runner: plain-return projection behind flag + registry entry | S | — |
| D1 | runner: eventId through send; structured receipt link on dispatch | M | — |
| D2 | cli: --invocation, readback, receipt-exists reclassification | M | D1 |
| D3 | integration: cross-process idempotent retry test | S | D2 |
| E1 | envelope fields + linked retention collection | L | C1–C4, D1–D3, OQ1, CFC review |
| E2 | topics: retire AgentAuthoredEvent | S | E1 |
| F1 | cli: `cf piece verbs --json` | S | — (result schemas after C3) |
| F2 | cli: `@name` binding | S | — |
| F3 | cli: `--await` / `--no-wait`, caller-controlled bound | S | D2 |
