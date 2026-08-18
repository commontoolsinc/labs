---
status: historical
created: 2026-08-14
archived: 2026-08-14
reason: "Independent review of the verbs implementation arc as it stands combined on main at 5ca4c1296: findings across runtime, transformer, CLI, docs, and tests, with a follow-up sequence and a reconciliation against the PR #5765 review."
---

# The verbs arc, reviewed as the system it produced

**Reviewed commit:** `5ca4c12968b71b161f8d29507b02f2b894eb1278` (`origin/main`,
2026-08-13 23:10 -0700, "docs(plans): the three verb design documents agree on
what the gate checks (#5782)").

**Review target.** Not any one PR: the resulting implementation on main after
the whole verbs arc landed, including interactions and regressions that exist
only in the combination. Individual PRs were used for intent and provenance
only. The verb event-schema evolution policy is an open design discussion;
nothing below reports the absence of a chosen policy as a defect, and the one
finding that touches that boundary (F2) is labeled design/maintainability
feedback.

## Scope: what the arc is

Established from `docs/plans/verbs-implementation.md`, the two archived plans
it supersedes, git history of the touched files since 2026-07-20, and GitHub
metadata (states checked per PR/issue with `gh` on 2026-08-14).

**Merged (the arc proper):** #4946, #4968, #4991, #5123, #5147, #5170, #5226,
#5233, #5234, #5244, #5245, #5246, #5262, #5276, #5286, #5289, #5296, #5297,
#5302, #5309, #5311, #5345, #5459, #5468, #5470, #5497, #5500, #5501, #5504,
#5593, #5601-era doc reattachments where they touched this surface, #5609,
#5610, #5614, #5629, #5631, #5639, #5643, #5673, #5680, #5682, #5683, #5694,
#5701, #5717, #5740, #5747, #5753, #5757, #5762, #5767, #5778, #5782.

**Reverted and re-landed:** #5469 and #5505 merged 2026-08-10, backed out by
#5582 the same day, re-landed together as #5610 (2026-08-11) — the invocation
pair `{id, session}` and call selection. #5767 restored a rename that #5762
and #5740 raced on (merged five minutes apart; main stopped type-checking) —
the plan's own "two green PRs" mechanism recurring after it was documented;
the enabling gap (`packages/cli/lib` absent from `tasks/check.sh`) is closed
at this commit.

**Closed, not merged:** #5307 (closed-world event-schema emission — ruled
against on #5589; retreating left nothing to land), #5458 (folded into
#5470's squash; the shared read step is on main as
`packages/cli/lib/cell-selection.ts`).

**Open:** #5746 (the `Demand<T>` prototype), and PR #5765 (the other review of
this same arc; see Reconciliation).

**Issue tail at this commit:** open — #5498, #5499, #5502, #5530, #5534,
#5560, #5576, #5589, #5632, #5633, #5637, #5663, #5698, #5706, #5722, #5734;
closed during the arc — #5523 (#5757), #5558 (#5680 + #5717), #5559 (folded
into #5637), #5577 (#5740), #5619 (#5629), #5662 (#5683).

## Method and coverage

Six parallel deep-read lanes (delegated review agents), one per subsystem:
authoring surface and transformer emission; runner/scheduler invocation
machinery; CLI call path and discovery; read layer and projection; live-doc
coherence; test rigor and production callers. Each lane read its slice's
implementation and tests, ran the focused suites, and probed emitted or
runtime behavior where a claim needed it. The synthesizing reviewer read the
core dispatch/receipt seam independently (`callable.ts` whole,
`runner.ts` receipt paths, `cell.ts` send path, `event-identity.ts` whole,
`events.ts` W4 branch, `cell-selection.ts` derive step, `piece.ts`
`getCellValue`), re-verified every major finding against source or by direct
reproduction, and wrote one probe of its own (F10). Design context read in
full: `verbs-implementation.md`, `pattern-verb-contract.md`,
`verb-evolution.md`, `fabric-read-model.md`, `shaped-reads-and-verb-results.md`,
`projection-key-classification.md`, `references-as-arguments.md`, both
archived implementation plans, `docs/history/README.md`.

For independence, PR #5765 and its report were not read until every finding
below was fixed; the Reconciliation section at the end was written afterwards
and changed nothing above it.

All focused suites at this commit are green (commands and results at the
end). No implementation code was modified; probes lived outside the tree.

---

## Findings — current defects

Ordered by impact. Severity uses the repo taxonomy
(critical / major / minor / info). "Verified" means the reviewer ran it or
read the exact lines; nothing suspected is presented as a bug.

### F1 · MAJOR (borderline critical) · verified, reproduced — the W4 backlog collapse silently discards a caller-supplied durable invocation id

- **Where:** `packages/runner/src/scheduler/events.ts:307-381`
  (`queueSchedulerEvent`): the scoped delivery id is computed at line 321 and
  the collapse branch (351-381) never consults it — the survivor keeps its
  own id while taking the new event's payload, action, time, and injection
  provenance, and chaining `onCommit`.
- **Behavior (reproduced against the real scheduler):** at
  `MAX_EVENT_BACKLOG_PER_STREAM` (256) pending events for one
  (stream, handler), a send carrying `{eventId, session}` collapses into the
  last same-origin entry. Reproduction: after 256 plain sends, a caller-id
  send leaves the queue at 256, zero `evt:caller:` ids present, the caller's
  payload under a minted id with the chained callback. The handler runs, the
  commit callback fires with the survivor's tx, the CLI reports `settled` and
  publishes the survivor's receipt — no receipt ever exists at the address
  the pair derives, so a later same-id retry or `--no-wait` collection finds
  nothing and **re-executes**: the duplicate-on-retry defect this arc exists
  to kill. In the other direction, a queued caller-id entry can be the
  survivor and have its **payload replaced** by a later same-origin send, so
  the receipt under the caller's id durably records a result computed from a
  payload its owner never sent, and same-id retries deduplicate against it.
- **Reachability:** needs a 256-deep same-origin backlog on one stream inside
  a long-lived runtime (toolshed, background-piece-service, shell host — not
  a one-shot CLI process). Origin-less events share the `undefined` origin
  (`events.ts:348`, and the CLI ingress send passes no origin tx), so an
  ingress send can collapse with unrelated origin-less sends in a shared
  host. Bounded, but the caller cannot detect it, and every design document
  tells the caller a same-id retry is safe in every phase.
- **Why it matters:** it breaks the arc's core invariant — payload, event id,
  receipt address, callback, and caller-visible outcome naming one logical
  invocation — and it is a pure interaction defect: W4 predates the arc
  (#4740-era backlog shaping); #5469/#5610 landed caller-supplied durable
  ids on top without exempting them.
- **Repair:** exempt durable-id events from collapse (skip the branch when
  `args.eventId !== undefined`, and never select a survivor whose id starts
  with `evt:caller:`), or refuse loudly at the cap (fail the send / settle
  the callback errored) — silently merging is the one wrong answer. Which of
  those two is wanted is an owner decision (see Decisions).
- **Acceptance tests:** at cap, a `{eventId, session}` send still enqueues
  (or errors loudly) and its receipt lands at the scoped address; a queued
  caller-id entry is never payload-overwritten; W4 last-wins is preserved
  for minted-id floods.

### F2 · MAJOR · verified (probes; mechanism corroborated in source) — a verb carries two event schemas that diverge, and the design of record describes the wrong mechanism

- **Where:** `packages/ts-transformers/src/transformers/schema-injection.ts:286-353`
  (`applyCapabilitySummaryToArgument` applied to the handler's event
  parameter, ending in `applyShrinkAndWrap`);
  `packages/ts-transformers/src/closures/utils/schema-factory.ts:225-263`;
  doc claims in `docs/plans/references-as-arguments.md` ("What is missing")
  and `docs/plans/verbs-implementation.md` item 11, fourth part.
- **Behavior (emitted output, probed both ways):** the event schema lowered
  onto the handler — the schema the deployed stream cell carries, which
  `cf piece call` validates against, dispatch judges, and discovery serves —
  is a **usage summary of the current handler body**. A declared
  `Writable<T>` event field the body never reads is dropped from `properties`
  **and** `required`, for the named and inline spellings alike; when the body
  reads it, both spellings emit, capability-narrowed (`asCell: ["readonly"]`
  for a read-only body). Meanwhile the pattern's durable result schema
  (`$defs.<Event>`) always carries the full declared event. Two sources of
  truth for one verb's input, divergent by construction whenever the body
  does not exercise a declared field.
- **Why it matters:** a declared field the current deploy's body doesn't
  read is undiscoverable to callers, and under plan item 12's future refusal
  would be *refused despite being authored*. And
  `references-as-arguments.md` — the design of record for item 11 — records
  the gap as spelling-dependent ("an inline `Writable<{…}>` disappears …
  the named form emits `$ref` with no asCell"), which no longer matches: the
  disappearance is usage-dependent, and the named form now carries a
  capability-summarized `asCell`. A driver picking up item 11 would chase a
  gap that has moved, and the schema-blind vs schema-directed decision would
  read an `asCell` marker that records the body's usage, not the author's
  declaration.
- **Design feedback (not a policy choice):** which schema is a verb's input
  contract — the stream cell's usage summary or the declared event — needs
  deciding before item 12 ships a refusal keyed on it. This intersects the
  open evolution-policy discussion and is flagged for that conversation, not
  resolved here.
- **Repair:** (a) correct `references-as-arguments.md` and the verbs plan's
  item-11 bullet to the measured mechanism — cheap, and should precede any
  item-11 work; (b) decide the contract question; if the stream schema is
  the contract, event parameters likely need exemption from usage-shrinking
  (or a merged declared-type emission).
- **Acceptance tests:** a transformer fixture with a declared event field the
  body does not read, pinning whichever contract is decided; a probe-style
  test asserting named/inline parity under usage.

### F3 · MAJOR · verified (mechanism; magnitude unmeasured) — `piece call --select/--schema` re-couples the caller's result to global graph quiescence

- **Where:** `packages/cli/lib/cell-selection.ts:2505-2509`
  (`deriveSelectedValue` awaits `outputCell.pull()`, **`runtime.idle()`**,
  `runtime.storageManager.synced()`, then `pull()` and `idle()` again),
  consumed by `selectCallResult` (`packages/cli/lib/callable.ts:646-667`).
- **Behavior:** the arc's headline D2 property is transaction-local
  acknowledgement — a call awaits its own handling's commit plus receipt
  sync, "never the graph going quiet" (60-80 s live-board waits motivated
  it; a unit test pins the send path). But a call that passes a selection
  runs the shaped readback through `deriveSelectedValue`, whose
  `runtime.idle()` is global — in the same CLI runtime where the handler
  just ran and triggered downstream recomputation. On a piece with slow
  derived state, `cf piece call --select title addTopic …` waits for that
  recomputation before stdout: the wait class the arc removed, re-imported
  through the selection door, on the arc's flagship "call, then read shaped"
  loop.
- **Repair:** scope the shaped-readback wait to the transform's own
  computation (event-driven completion of the transform result cell), or
  document the coupling as a known cost of `--select`/`--schema` on calls.
  The same block serves `piece get`, where it is benign only because no
  handler ran in that runtime.
- **Acceptance test:** mirror D2's guard — a deliberately slow unrelated
  computed on the source piece must not delay a selected call result,
  asserted by event ordering, not wall clock.

### F4 · MAJOR · verified — the `piece call` failure exit is a diverged inline copy; the exported helper it duplicates is dead and is what the tests assert

- **Where:** `packages/cli/commands/piece.ts:328` (`exitPieceCallFailure`,
  exported, doc-commented as "The failure exit for `cf piece call`", unit
  tested at `packages/cli/test/piece-call.test.ts:1892,1930`) vs the inline
  catch that actually runs (`packages/cli/commands/piece.ts:1999-2029`).
  Confirmed: the only references to the helper anywhere are its definition
  and its tests.
- **Behavior:** #5233 called the helper; the F3-wait change replaced the call
  site with an inline catch (adding the `WaitBoundExpired` stdout Invocation
  JSON) and left the helper behind. The two have diverged: the inline path
  renders `{id, status: <phase>}` to stdout on wait expiry; the helper does
  not.
- **Why it matters:** this is the arc's own recorded mechanism — a test
  guarding a double instead of the thing — in its fourth instance, now in
  command code: edits to the "exit contract" in the helper pass its tests
  while changing nothing a user sees; edits to the live catch are guarded by
  nothing.
- **Repair:** re-unify — either the action's catch calls
  `exitPieceCallFailure` (folding the wait-expiry stdout JSON into it), or
  the helper is deleted and the tests move onto an extracted function the
  action really calls.
- **Acceptance test:** one unit test driving the extracted failure exit that
  asserts both the stderr `invocation:`/`phase:` lines and the wait-expiry
  stdout JSON.

### F5 · MAJOR (coverage) · verified as an absence — item 4's exit criterion has no end-to-end witness

- **Where:** every `--no-wait`/receipt-envelope test runs against a
  fabricated harness receipt (`packages/cli/test/piece-call.test.ts:2351-2485`,
  harness `harnessReceipt` ~line 1396); `grep -rn "no-wait"
  packages/cli/integration/*.sh` finds nothing; no integration step feeds a
  published `receipt.id` back through `cf piece get --piece`.
- **Why it matters:** "a detached call returns an address that reads back the
  outcome it names" is the property item 4 (#5694) landed for, and it
  composes three seams (envelope publication, `of:` entity intake from
  #5459, scope handling) that only an end-to-end read exercises. The runner
  pins that `tx.handlingReceiptLink` exists; the CLI pins that the envelope
  carries what the harness said; nothing witnesses the composition — the
  plan's own three-strike lesson about doubles, one layer up.
- **Repair + acceptance:** one integration step (natural home:
  `verbs-over-the-cli.sh` or the `run_piece_call_retry` shard): call with
  `--no-wait`, parse `.receipt.id`, `cf piece get --piece <id>`, assert the
  verb's result fields and `status == "committed"`; plus a settled-mode
  variant asserting `.receipt.id` reads back the same value as `.result`.

### F6 · MAJOR · verified — the gap harness runs in no automated lane, so "a gap closing announces itself" is currently false

- **Where:** `packages/cli/integration/verb-session-gaps.sh` (whole);
  `.github/workflows/deno.yml` cli-integration matrix;
  `packages/cli/integration/integration.sh` shard dispatch (the `piece-call`
  shard delegates to `verbs-over-the-cli.sh` only);
  `docs/plans/verbs-implementation.md` ordering-table row 1, which rests on
  the announcement property.
- **Behavior:** the script's header says its gap steps "fail loudly the day
  the gap closes, so this script is how we find out that a capability
  arrived." Nothing in CI, any task, or any script invokes it. The plan's
  stated detection mechanism for items 11 (#5560) and the id-divergence gap
  (#5632) is a script only a human remembers to run. (That the #5577 gap was
  correctly converted after #5740 shows the manual loop worked once.)
- **Repair:** invoke it from the `piece-call` shard beside
  `run_verbs_walkthrough` (it deploys its own fixture into its own space),
  or give it a matrix row.
- **Acceptance:** flip one `gap` call's polarity on a branch — the shard must
  go red.

### F7 · MINOR · verified — on the forced-stream fallback path the pre-dispatch gate is inert, and the comment beside it claims the opposite

- **Where:** `packages/cli/lib/piece.ts:1611-1631` (`tryResolvePieceHandler`
  returns the forced-cast `streamCell` as `callableCell` while only the
  command spec uses the link-derived schema; comment: "so `--help` and input
  validation are unaffected"); `packages/cli/lib/callable.ts:838-842`
  validates `resolved.callableCell.schema` — the cast's
  `{asCell:["stream"]}`, which admits anything.
- **Behavior:** for a handler whose stored schema lost the stream marker, a
  malformed payload dispatches, the handler runs with `$event === undefined`,
  and the receipt spends the invocation id — the exact class D2/D5 close on
  ordinary paths. Bounded to marker-less handlers.
- **Repair:** validate against `commandSpec.inputSchema` when richer than the
  dispatch cell's schema, or correct the comment to "…so `--help` is
  unaffected; the payload gate does not engage on this path."
- **Acceptance:** a unit test resolving a marker-less handler whose
  link-derived schema requires a field: typo'd payload refused pre-dispatch,
  id unspent.

### F8 · MINOR · verified — third hand-rolled local-`$ref` resolver, in the exact family the tree has paid for twice

- **Where:** `schemaAtLocalRef`, `packages/cli/lib/cell-selection.ts:1053-1070`
  (used by `derivePosition`, the #5740 cyclic bound): private JSON-Pointer
  walking, no nested-`$defs` scope tracking, no escaped-name handling. The
  canonical resolver is used two functions away (`walkSchemaRoot` →
  `ContextualFlowControl.resolveSchemaRefsOrThrow`), and `localRefTarget`'s
  own doc comment (`packages/runner/src/cfc/schema-sanitization.ts`) records
  this precise repeated bug. Two prior instances make this the third — fix
  the shape, not the instance.
- **Impact bound:** on divergence `derivePosition` degrades to the legible
  `CyclicResultError` refusal rather than corrupting — which is why this is
  minor.
- **Repair + acceptance:** resolve hops through the canonical resolver; a
  test where the declared result's recursion sits under a nested `$defs`
  scope (or a `~1`-escaped name) still derives the cut.

### F9 · MINOR · verified (both halves) — the gap probes cannot distinguish "gap still open" from unrelated breakage, and the runner receipt suites' wait bounds cannot fire under the package fake clock

- **Gap probes:** `verb-session-gaps.sh:41-47` (`gap()` accepts any nonzero
  exit; step 10 never checks `$OTHER` non-empty; step 3 greps fixture
  prose). A probe that passes for the wrong reason is the can't-fail class.
  Repair: assert the specific refusal text and guard inputs.
- **Wait bounds:** `scheduler-event-receipts.test.ts:108-142` (and
  same-named copies in three sibling files): `setTimeout(reject, 1000)` and
  `performance.now()` deadlines under the package clock preload
  (`auto-advance`; `performance.now` frozen — probed: 0 ms across 100
  zero-delay turns, a 50 ms test timer never fires). The bounds are
  decorative; a regression that makes a condition unsatisfiable hangs the
  suite to the CI job timeout with no test name instead of failing with the
  helper's message — the precise trap `waiting-in-tests.md` names.
  Repair: iteration-bounded loops that actually throw the message.
- **Acceptance:** corrupt `$OTHER` → step 10 fails rather than reporting the
  gap; make one receipt-suite condition unsatisfiable in a scratch copy →
  the test fails with the helper's message within the run.

### F10 · MINOR · verified by direct probe — issue #5734's and the projection design's "exit 0" claim does not reproduce at the command layer; the real current failure is a refusal that misleads

- **Where:** `packages/cli/lib/piece.ts:2908-2929` (the `sourceWasAbsent`
  escape and the `CellSelectionError` refusal, landed with #5276);
  `docs/plans/projection-key-classification.md` problem table row 3; issue
  #5734.
- **Probe (this review, in-process runtime, cell-backed result fields):**
  `getCellValue` with `{"type":"object","required":["absent"],`
  `"properties":{"title":true}}` and with `required:["secret"]` both **throw
  `CellSelectionError`** (nonzero exit); `root.getRaw()` is not undefined,
  so the escape does not bypass; the satisfied control returns
  `{"title":"Visible"}`.
- **What stands and what doesn't:** the mechanism is real and confirmed —
  the caller's `required` reaches the read boundary and empties the whole
  selection (probed at the derive layer), and the disclosure-shaped widening
  (`type` stated + misspelled `properties` → every field including ones
  deliberately not named, exit 0) is confirmed and survives the command
  layer. What does not reproduce is the *silent exit-0* half for `required`
  at the command layer: the caller gets a refusal whose message suggests
  `--step` and never names `required` — misleading, but loud. The design doc
  merged (2026-08-14) with a motivating row that was already stale against
  the refusal (landed 2026-08-03).
- **Repair:** re-measure #5734 against a live server and update the issue
  and the design table to the current behavior split (silent widening still
  exit 0; unsatisfiable `required` a misleading refusal); item 2's fix
  (derive `required` from the source on the JSON path) is unchanged by this.
- **Acceptance:** the command-layer read-outcome test the issue itself names
  as missing, for both `get` and `call`.

### F11 · MINOR · verified — CLI unit doubles are self-typed, so cross-package contract drift is invisible to both the test run and `deno task check`

- **Where:** `packages/cli/test/piece-call.test.ts:1454` (`createMockCell`,
  duplicated at `exec.test.ts:3017`); hand-written
  `sendOptions?: { eventId?; session? }`; 14 `as never`/`as unknown as`
  reaches into `executePieceCallable`.
- **Why:** a runner-side rename of `StreamSendOptions.session` or a change
  to the commit-callback tx surface compiles clean and leaves every unit
  test green — the #5505/#5582 lesson one layer down. First detection is the
  integration shard, late but real.
- **Repair + acceptance:** type the double via
  `Parameters<Cell<unknown>["send"]>` and
  `IExtendedStorageTransaction` members; share one `createMockCell`; a
  branch renaming `session` must fail `deno task check` on
  `packages/cli/test`.

### F12 · MINOR · suspected (two independent instances) — small caller-facing losses at edges

- **Receipt scope dropped from the recovery hint:**
  `packages/cli/commands/piece.ts:656` prints
  `cf piece get --piece <receiptId>` without the `@<scope>` suffix, against
  `CallableResultRef`'s own warning that reopening a scoped cell without it
  resolves a different cell. Handler receipts appear space-scoped on every
  path traced, hence suspected. Repair: render `@<scope>` when
  `receipt.scope !== "space"`.
- **JSDoc description skipped on the factory-resolved stream-property
  branch:** `packages/schema-generator/src/formatters/object-formatter.ts:299-318`
  attaches the wrapper schema and the `deprecated` mark, then `continue`s
  before the description attachment — the #5637 prose-loss family, one more
  emitter-side branch, asymmetric on its face (taught `deprecated` but not
  `description`). Not reproduced end to end (inference-path probe failed
  type-checking for unrelated reasons). Repair: hoist doc attachment above
  the `continue`, or record the boundary in the mapping spec.

### F13 · MINOR · verified — the hand-maintained handler overload mirrors differ in props typing

- **Where:** `packages/api/index.ts:2563-2599` (`HandlerFunction`, props
  `HandlerState<T>` — non-handle members readonly) vs
  `packages/runner/src/builder/module.ts:518-555` (props bare `T`; its
  comment claims the mirror). Patterns see only the api side, so the
  authored surface is the stricter one; the tripwire tests pin overload
  reachability, not props parity.
- **Repair + acceptance:** align the builder overloads to `HandlerState<T>`
  (or narrow the mirror comment); a type assertion in
  `handler-overload-types.test.ts` that a builder-side callback's non-cell
  props member is readonly.

---

## Findings — live sources that misdescribe the current system

The bar (per the repo's review skill): someone landing on these must not be
misled about how the runtime works now. All verified against code.

### F14 · MAJOR — the normative scheduler spec contradicts two landed changes

- `docs/specs/scheduler-v2/README.md:841`: a verb's declared result is
  "settled at the type layer and **never reaching the runtime**" — false
  since #5501 (`module.resultSchema`; served by `cf piece verbs` #5629 and
  `--help` #5717). The true statement is "never reaching the durable schema
  or the receipt's contract."
- §7.5 describes event ids as minted (or an external ingress id used
  verbatim) and never mentions the `{id, session}` pair and stream-link
  scoping (`scopeCallerEventId`) that now decide where a receipt lives — the
  spec's identity section cannot reconstruct where a CLI call's receipt
  lands. §7.6's "sent events reserve their position in the global FIFO
  immediately" is also silent about (and arguably contradicted by) the W4
  collapse, so nothing normative decides F1.
- **Repair:** a §7.5 paragraph naming the scoped derivation and its inputs;
  the corrected §7.6 sentence; a sentence stating the backlog cap, the
  collapse rule, and its exclusions once F1's decision is made.

### F15 · MAJOR — `docs/plans/verb-result-selection.md` describes the pre-August system as "today", and contradicts itself on session scoping

- ~Line 188: `--no-wait` returns "no receipt field; that is what migration
  step 2 adds" — #5694 landed; the receipt rides every envelope.
- ~Line 270: "`of:fid1:…` | `--piece` today | throws" — #5459 landed.
- ~Line 335: the receipt hash contains "no DID, no session" — false since
  #5610, and it contradicts the same document's "How addresses are derived"
  section, which was updated. One half of the doc moved, the other did not.
- The migration section lists steps 1-4 as future; all four are on main.
- **Repair:** rewrite the stale sections to present tense or archive the
  superseded portions; the "no session" sentence must go.

### F16 · MAJOR — the receipt-schema motivation outlived #5468 in two designs

- `docs/plans/shaped-reads-and-verb-results.md:357`: "Today it does not:
  receipts are created with no schema argument … an empty `schema` field" —
  plain results now store a descriptive schema
  (`runner.ts:5406-5407`); reactive results still carry none. Also lines
  98-99 cite `FORBIDDEN/UNSUPPORTED_PROJECTION_KEYS` in
  `piece-get-transform.ts` — that file no longer exists; they live in
  `cell-selection.ts`.
- `docs/plans/fabric-read-model.md:118`: a receipt is "distinguished only by
  being created without a schema — which is a defect rather than a
  property" — now half-false.
- **Repair:** restate as the shipped plain/reactive split with the
  declared-sourced open question intact; fix the citations.

### F17 · MINOR — a cluster of smaller drifts, each capable of misleading

- **Three surfaces teach stripping the `of:` prefix** that #5459 made
  unnecessary: `packages/cli/README.md:302-303`,
  `docs/common/verbs/over-the-cli.md:443-446` and `:545-546`,
  `skills/cf/SKILL.md:296` — while the walkthrough's own receipt examples
  pass `of:` ids verbatim. The strip advice contradicts the arc's
  composition goal and the docs contradict themselves.
- **The verbs plan's State table is behind the tree it owns:** step 7 says
  "#5577 — in review (#5740)" (merged 2026-08-13, issue closed); step 10's
  #5523 is unmarked (fixed by #5757, closed); the open-PR table still lists
  #5307 (closed); #5576 is listed "fixed by #5683" while the tracker shows
  it open — plan or tracker, one is behind.
- **`pattern-verb-contract.md`** cites `resolveInvocationId` twice (renamed
  `resolveInvocationIdentity`), and its client-surface examples show
  `--invocation inv_7f3a` with no session and claim replay — the shipped CLI
  refuses exactly that call; the document never mentions sessions.
- **`packages/cli/README.md:388` and `skills/cf/SKILL.md`**: "a handling's
  receipt declares no schema for a selector to narrow against" — false for
  plain results since #5468 (the stated reason is stale regardless of
  whether readback narrowing engages today).
- **`cli-surface-implementation.md`/`-shape.md`** count 20 subcommands; #5673
  added two (`get-label`/`set-label`), unclassified in the keep/move tables.
- **Skills gap (info):** `skills/topics/SKILL.md` teaches no
  `--invocation`/session retry for post-dispatch uncertainty — the precise
  duplicate-on-retry class the arc closed — and never mentions the `receipt`
  address; `skills/cf/SKILL.md`'s quick reference has no
  invocation/receipt/`--no-wait` rows.

---

## Findings — info-tier notes (recorded, no repair urged beyond a sentence)

- A verb deliberately returning `{}` is indistinguishable from a value-less
  verb (`callable.ts:933-938`) — by design; worth one sentence in
  `verbs-over-the-cli.md`.
- `Handler "X" failed:` takes the latest entry in the shared runtime error
  log since call start (`callable.ts:884-890`) and can attribute an
  unrelated concurrent error; exit path correct either way.
- The cyclic-result derived bound closes object schemas, so undeclared
  receipt extras ("advisory" per the archived plan) are dropped exactly and
  only when the declared type is self-referential — defensible; undocumented.
- `runtimeErrorLog` fails open (`[]`) for non-CLI embedders of
  `deriveSelectedValue`; transform failures would be swallowed.
- Verb-return validation's arithmetic rule is one-operand
  (`verb-return-validation.ts:157`) while spec §6.10 reads both-operand —
  conservative in the safe direction; align the wording.
- `withDeclaredResultSchema` spreads an authored `{proxy:true}` into the
  injected options object — the already-filed #5502 surface; cover the
  spread path when that is fixed.
- `packages/patterns/bookmarks.tsx:105` sends `{ index }` — rule 5's literal
  anti-example, pre-existing, now *advertised* to agents by the arc's
  discovery surface.
- Dormant machinery after the #5589 ruling, confirmed sound as built and
  with exactly one production mint site for the injection carve-out
  (`llm-dialog.ts`): `closedWorldEventRejection`, the #5302 `verbEvent`
  compat rule, and `markRuntimeInjectedEventKeys` are live, tested code
  that generated schemas no longer trigger. The plan already assigns
  retirement to the runtime owner; recorded here as maintainability weight,
  not as a policy claim.
- Style: several api type-test files use `Deno.test` rather than the
  mandated BDD shape; the type-assertion technique itself is sound and the
  assertions are genuinely gated by `deno task check`.
- Under `--verbose`, a `--help` invocation leaves its `initial_sync` span
  unclosed (documented as intended; no invocation ran).

## Roadmap items confirmed open (not defects), and history confirmed fixed

Confirmed still open and accurately scoped: item 2 (projection-key refusal;
widening probe reproduced), item 5 (`wish`/`exec` take no read options —
only `commands/piece.ts` consumes `parseCellSelectionOptions`), item 11/#5560
(gap script step 10 still asserts it), item 12 (undeclared call fields
accepted and dropped — reconfirmed at the gate), #5637 (three-row description
table reproduces exactly as the plan records), #5698 — with the caveat that
its description ("candidate names built from the declared result type") no
longer matches the mechanism: `listPieceCallables` now also sweeps the piece
root's stored value (`piece.ts:2033-2064`); the residual boundary is verbs
with neither a stored `{$stream:true}` sentinel nor a link-derived stream
schema. The issue and the `verb-evolution.md` paragraph citing it deserve a
re-measure. #5633/#5706 remain runner-owned as the plan states.

Suspicions checked and dropped: no fourth can't-fail-fixture instance in the
*test* tree (the arc internalized that lesson — `hiddenPing`,
`Object.assign(() => {}, graph)`, live-pinned cause-matching); session-scoping
coverage is complete across unit, runtime, and CI integration; integration
scenario 2's `if/elif` records which raced outcome ran rather than weakening
the pass; `verbs-over-the-cli.sh` step 13 pins the no-session refusal.

## Strong design choices worth preserving

- **The invocation pair as one value**, refused without its session at the
  innermost layer (`cell.ts:1483-1495`) with the reasoning in the error —
  the invalid state is unrepresentable at the send boundary, not just in the
  CLI.
- **`scopeCallerEventId`** — canonical `hashStringOf` over the structured
  pair plus the whole stream link; type-tagged, length-prefixed,
  delimiter-mimicry-proof (and tested for exactly that); deliberately never
  echoes caller text into logs.
- **"Absent beats fabricated"**: the receipt address published on success
  *and* on collision, withheld entirely when receipts are off
  (`runner.ts:5361-5374`).
- **`--no-wait` as "skip only the readback"** with the commit
  acknowledgement non-skippable, and honest degraded-mode prose when no
  receipt exists.
- **`declaredResult` as a thunk** on `CallableResolution` — the pattern load
  priced onto exactly the two callers that need it.
- **stdout/stderr discipline** — stdout is exactly the Invocation JSON in
  every mode including wait expiry.
- **One classification for listing, dispatch, completion, and read-guard**,
  the forced-stream cast confined to the dispatcher, and the boundary stated
  in `probeForcedStreamCell`'s doc comment.
- **Read-count tests via real storage-sync counters** (the #5701 exit
  asserted as an economics property), and **session-scoped transform result
  cells** making cross-process projection collision impossible by
  construction (#5757 holds beyond what its tests assert).
- **One normalization path for both selection spellings** —
  `conciseSelectionSchema` re-enters `normalizeProjectionSchema`, so
  `--select` cannot drift from `--schema`.
- **`CELL_RESULT_TYPE` as a structural, non-phantom pin** with the failure
  mode written at the declaration; **explicit-only result declaration** plus
  the syntax-based return validator covering exactly what types cannot.
- **The live-test discipline** and its stated rationale ("a double asserts
  that agreement instead of demonstrating it"); `topics-rejections.test.tsx`'s
  exact `expectRuntimeErrors: 9`; the D3/D4 integration scenarios each ending
  on the caller-visible property; `receipt-schema.test.ts` pinning collision
  keeps the winner's schema.
- **Spec-rides-the-change** in scheduler-v2 §7.6's receipt paragraphs (one
  sentence excepted — F14); `StreamSendOptions`/`scopeCallerEventId` doc
  comments carrying the full threat model; `verbs-over-the-cli.md` pairing
  every claim with a runnable walkthrough step.

## Recommended follow-up sequence

Small, reviewable PRs, roughly ordered; items needing a human decision are
marked ⚑.

1. ⚑ **F1** — W4 exemption or loud refusal for durable-id events at the cap
   (runner; decide semantics first), with the three acceptance tests, and
   the §7.5/§7.6 spec sentences riding it (F14's W4 half).
2. **F6 + F9a** — wire `verb-session-gaps.sh` into the `piece-call` shard;
   tighten the gap probes to assert specific refusals.
3. **F4** — re-unify the `piece call` failure exit; move the tests onto the
   live path.
4. **F5** — the `--no-wait` → `piece get` readback integration step.
5. **F2 (doc half)** — correct `references-as-arguments.md` and the verbs
   plan's item-11 bullet to the usage-dependent mechanism, before item-11
   work starts. ⚑ The contract question (which schema is a verb's input
   contract) goes to the item-11/12 owner and the evolution-policy
   conversation.
6. ⚑ **F3** — decide whether call+selection guarantees transaction-local
   latency; then either the scoped wait or the documented coupling.
7. **F14-F16** — docs batch: scheduler spec §7.5 identity paragraph and the
   `resultSchema` sentence; `verb-result-selection.md` refresh;
   receipt-schema paragraphs in the two read-model designs; citation fixes.
8. **F17** — docs batch: `of:` prefix sweep; State-table refresh (with
   tracker sync for #5576); `pattern-verb-contract.md` rename + sessions in
   examples; README/skill receipt-schema rationale; subcommand counts;
   skills teaching retry-by-id and the receipt address.
9. **F7** — forced-stream path: gate on the command-spec schema or fix the
   comment (small, self-contained).
10. **F8** — `schemaAtLocalRef` onto the canonical resolver.
11. **F9b + F11** — test hardening: iteration-bounded waits in the runner
    receipt suites; typed doubles shared between `piece-call`/`exec` tests.
12. **F10** — re-measure #5734 live; update the issue and the design table;
    fold the read-outcome tests into item 2's work.
13. **F12/F13 + info items** — scope suffix on the recovery hint; the
    object-formatter description hoist; builder/api props parity; one-line
    doc for `{}`-result semantics.

Decisions that require human agreement before implementation: the F1
at-cap semantics (exempt vs refuse); the F2 input-contract question (flagged
to the open evolution-policy discussion, deliberately not chosen here); the
F3 latency contract for shaped call readback; retirement of the dormant
closed-world machinery (already assigned by the plan to the runtime owner);
whether `{}`-means-value-less becomes documented contract.

## What was read and run

**Deep-read (synthesizer):** `packages/cli/lib/callable.ts` (whole),
`packages/runner/src/runner.ts` receipt paths (270-315, 5343-5602,
5793-5960), `packages/runner/src/cell.ts` send path (1432-1541),
`packages/runner/src/scheduler/event-identity.ts` (whole),
`packages/runner/src/scheduler/events.ts` (300-385),
`packages/cli/lib/cell-selection.ts` (2480-2524 and structure),
`packages/cli/lib/piece.ts` (`getCellValue`, 2780-2960; traversal keys
670-724), `packages/cli/test/piece.test.ts` (790-950),
`packages/cli/test/piece-verbs-live.test.ts` (whole),
`packages/ts-transformers/src/transformers/schema-injection.ts` (286-353),
`packages/ts-transformers/src/closures/utils/schema-factory.ts` (225-263),
all design and plan documents named under Method, `docs/history/README.md`.

**Deep-read (delegated lanes, verified on load-bearing claims):** api
Stream/handler/CELL_RESULT_TYPE regions; builder `module.ts` handler
overloads; `verb-return-validation.ts`, `verb-tier-mark.ts`,
`object-formatter.ts`; scheduler `events.ts` queue/dispatch/disposition and
`facade.ts`; `runner.ts` receipt and gate paths; `cell.ts` 280-1560;
`cfc/schema-sanitization.ts`; `cell-selection.ts` (all 2640 lines);
`commands/piece.ts` (160-2090); `piece.ts` resolution/listing/help/read-guard
regions; `fuse/callables.ts`; `llm-friendly-ref.ts`; `session.ts`;
integration scripts (`integration.sh` scenarios and shard dispatch,
`verbs-over-the-cli.sh`, `verb-session-gaps.sh` whole); the named test files
in cli, runner, piece, schema-generator, api, patterns/topics;
`waiting-in-tests.md`; the live docs and skills named in F14-F17;
`tasks/check.sh`; the cli CI matrix in `.github/workflows/deno.yml`.

**Probes (outside the repo tree, except where the compiler requires a
root-relative path — those ran from a temporary untracked directory, removed
immediately after):** five transformer probes compiled with
`deno task cf check <probe>.tsx --show-transformed --no-run` (declared-result
overloads; Writable event fields named/inline × read/unread; docs and marks;
result-cell declaration; `verb-result:undeclared-return`); a scheduler-level
W4 reproduction (256-deep backlog, caller-pair send, queue inspected); a
projection probe at the derive layer (unsatisfiable/satisfied `required`,
typo widening/narrowing); a command-layer probe of `getCellValue` against a
runtime-built piece (F10); a clock-preload probe (frozen `performance.now`);
a Cliffy parse experiment (`--wait 5 --no-wait` refused at parse); and two
reconciliation probes of the schema-first `handler` overload (schema consts
and inline literals), both failing the CTS compile with the trusted-builder
diagnostic quoted in the Reconciliation.

**Test commands and results (all green at this commit):**

| Where | Command (abbreviated) | Result |
| --- | --- | --- |
| packages/runner | `deno test --no-check --preload=test/clock-preload.ts test/scheduler-event-receipts.test.ts test/scheduler-event-identity.test.ts test/receipt-schema.test.ts test/declared-result-e2e.test.ts test/cfc-defaulted-required-relaxation.test.ts` | 7 passed (82 steps), 0 failed |
| packages/runner | `deno task test` (whole package) | 1201 passed, 0 failed |
| packages/cli | `deno test --no-check` on piece-call, piece-verbs, invocation-session, declaredResultProjection, llm-friendly-ref, the three `-live` suites, exec | 25+ passed (207+ steps), 0 failed |
| packages/cli | `deno test -A --no-check packages/cli/test/piece-get-transform.test.ts` | 1 passed (110 steps), 0 failed |
| packages/piece | `deno test --no-check -A test/schema-compatibility.test.ts` | 3 passed (58 steps), 0 failed |
| packages/schema-generator | `deno task test` | 55 passed (295 steps), 0 failed |
| packages/api | `deno task test` | 25 passed, 0 failed |
| packages/ts-transformers | `deno task test` | 1137 passed, 0 failed |
| repo root | `deno task check-docs-history-index` | pass (116 entries / 143 documents) |
| repo root | `deno task docs-links --orphan` | no orphans |

`git status` at the end of the review: clean; no implementation file was
modified.

## Reconciliation with the PR #5765 review

(Added after the findings above were fixed; nothing above was changed
afterwards.)

PR #5765 ("docs: add verbs resulting-codebase review",
`docs/history/verbs-codebase-review-2026-08-13.md`, still open) reviewed the
same arc at `79b680725` — 33 commits behind this review's snapshot; #5740,
#5747, #5753, #5757, #5767, #5778, and #5782 landed in between. None of those
touched the files behind its transformer/runtime findings, so its claims were
re-verified against `5ca4c1296` rather than dismissed as stale. It reports
nine findings, V1-V9.

**Agreements — found independently by both reviews.**

- **V3 ≡ F1** (backlog collapse breaks invocation identity). Independent
  reproductions of the same defect, complementary in detail: #5765 shows
  several callers' settlement callbacks all answering under an older id;
  this review shows the caller-scoped `evt:caller:` id being discarded — so
  the receipt address the `{id, session}` pair derives never exists and a
  same-id retry re-executes — plus payload overwrite of a caller-id
  survivor, and the reachability analysis. Two independent reviews landing
  on the same scheduler branch is the strongest confirmation either report
  contains; the two repair sketches agree (exempt or refuse, never merge).
- **V9 ≡ F9b** (receipt suites poll under a decorative bound). This review
  adds the mechanism that changes the repair: under the package clock
  preload the bounds *cannot fire at all* (frozen `performance.now`,
  never-firing reject timers), so the regression failure mode is a hang
  with no test name — iteration-bounded loops, or #5765's
  defer-from-commit-callback, both fix it.
- **V8 ∩ F14-F17** (live guidance contradicts behavior). Overlapping on the
  receipt-schema rationale in the CLI README and cf skill. Each found
  citations the other missed — #5765: `session.ts:5` and
  `pattern-verb-contract.md:752` promising a retry does not re-execute, and
  `verb-result-selection.md` contradicting itself on re-execution (all
  three re-verified at `5ca4c1296`; folded into this review's docs
  batches); this review: the scheduler spec's "never reaching the runtime"
  sentence and §7.5 identity gap (F14), the rest of
  `verb-result-selection.md`'s pre-August "today" claims (F15), the
  receipt-schema paragraphs in the two read-model designs (F16), and the
  `of:`-strip trio (F17). #5765's point that "only writes its own space" is
  not a sufficient retry-safety criterion is accepted and folds into the
  same docs repair.

**#5765 findings verified here with refinement.**

- **V1** (schema-first `handler<E,T,R>(eventSchema, stateSchema, cb)`
  mis-lowers). Mechanism confirmed by code-read at `5ca4c1296`
  (`schema-injection.ts:3240` takes `arguments[0]` as the callback
  candidate; the injection unconditionally prepends both generated schemas
  to all authored arguments). The headline is refuted by full-pipeline
  probes, though: both spellings (schema consts and inline literals) FAIL
  the CTS compile loudly — "Trusted builder 'handler' must receive a direct
  callback, not an indirect reference" — so no malformed six-argument call
  reaches the runtime. The real defect is narrower and still real: a
  public, doc-commented, type-tested overload (`packages/api/index.ts`,
  the `<E, T, R>(eventSchema, stateSchema, handler)` member) cannot be used
  in any CTS pattern, and the diagnostic misdescribes the author's error.
  Reclassified major → minor (loud failure, no silent corruption; the
  overload remains usable for untransformed/direct builder callers).
  Repair options: teach the injection to recognize the schema-first
  authored form, or retire the overload from the authored surface and say
  so — plus a transform-level test either way.
- **V2** (`{ proxy: true }` lost under transform). Mechanism real and
  production callers confirmed at `5ca4c1296`
  (`default-app.tsx:54`, `bgAdmin.tsx:66,73`) — but this is the
  already-filed #5502, which the verbs plan explicitly records as a
  neighbouring-subsystem issue, predating the arc. Classified here as
  known-filed, not a new arc defect; this review adds (fork finding, F-info)
  that `withDeclaredResultSchema`'s options spread must be covered when
  #5502 is fixed. #5765's production-caller citations materially raise
  #5502's priority and belong on that issue.
- **V4** (receipt representation conflates absence with empty values;
  publishes undeclared returns). Split verdict. The "publishes undeclared
  incidental returns" half is a *recorded decision*, made twice in review
  (archived plan, 2026-07-31 amendment: receipts are runtime-honest;
  undeclared receipt content is advisory) — reporting it as a defect
  re-litigates a decision without naming it. The shape-test half is a
  genuine gap this review under-weighted: `callable.ts` treats any
  `Object.keys(value).length === 0` object as value-less, which swallows a
  deliberate `{}` result (recorded above as info) *and* any keyless
  instance result — a `FabricBytes` with private slots reads back as
  no-result (code-read verified; not runtime-reproduced). Adopted as a
  minor: distinguish presence by a marker or by the declared result rather
  than by key count, or document the boundary.
- **V5** (a selection error masks the verb-read refusal). Verified at
  `5ca4c1296` by code-read: `getCellValue`'s catch consults the verb guard
  only for `Cannot access path` errors, and `classifyReadPathVerb` runs
  only on success, so a real `--filter`-on-a-handler failure surfaces as a
  shape error instead of "use `piece call`". Adopted as a minor this
  review missed.
- **V7** (quoted wrapper verb names miss tier inference). Verified at
  `5ca4c1296`: the inference loop handles shorthand and identifier-named
  properties only, while the schema-mutation pass beside it accepts string
  literals. Adopted as a minor this review missed; the shared
  static-property-name helper is the right repair.
- **Link-equality duplication** (from #5765's refactor list, not its
  findings table): verified — `areNormalizedLinksSame` is defined in both
  `link-types.ts:289` and `link-utils.ts:192`. Link identity is a named
  domain in the repo's anti-duplication table; adopted, one canonical home
  with a re-export.

**Disagreement.**

- **V6** (unknown projection keys silently accepted) is plan item 2 — an
  unbuilt roadmap item whose design landed as #5753 — and #5765's own scope
  statement excludes open roadmap items from defect status, yet rates this
  Major. This review keeps it classified as roadmap (confirmed live by
  probe). More substantively, V6's claim that the acceptance "does not
  widen the read" is contradicted by measurement: with `type` stated, a
  misspelled `properties` sets `additionalProperties: true` and returns the
  whole object including fields the caller deliberately did not name, exit
  0 — the disclosure-shaped half, which is the stronger motivation for
  item 2 and which V6's account omits. Conversely, this review's F10 probe
  corrects the shared narrative's other half: an unsatisfiable `required`
  no longer exits 0 at the command layer; it is refused with a message that
  never names `required`.

**Unique to this review** (none appear in #5765): F2 (a verb's two divergent
event schemas and the design of record describing the wrong mechanism), F3
(shaped call readback re-coupled to global quiescence), F4 (the dead failure
exit and its diverged live copy), F5 (no end-to-end witness for the
`--no-wait` receipt address), F6 (the gap harness in no automated lane), F7
(the forced-stream path's inert gate), F8 (the third local-`$ref` resolver),
F10 (the #5734 exit-code correction), F11 (self-typed CLI doubles), F12, F13,
F14's spec-identity gap, most of F15, and the strengths/roadmap
verifications. #5765's report was also produced before #5740/#5747/#5757
merged and does not cover them; this review does.

**Additions to the follow-up sequence from the reconciliation:** fold V5 and
V7 into step 9's CLI/transformer batch; add the V1 repair (recognize or
retire the schema-first overload, with a transform test and an honest
diagnostic) to step 5's transformer batch; add the keyless-instance receipt
edge (V4's half) to step 13; add the `areNormalizedLinksSame` unification to
step 10's duplication batch; attach #5765's production-caller citations to
issue #5502.

**A mergeability note on #5765 itself:** it indexes its report by editing
`docs/history/README.md`, but at current main the index lives in
`docs/history/INDEX.md` (enforced by `deno task check-docs-history-index`);
the PR needs that moved on rebase. Its report is dated at `79b680725` and is
a valid point-in-time record as-is; nothing in this reconciliation asks it to
be rewritten.
