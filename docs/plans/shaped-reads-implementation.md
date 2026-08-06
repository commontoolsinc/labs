# Shaped reads and verb results — implementation plan

Sequences the read layer and the calls layered on it, as designed in
[Reading Fabric data](fabric-read-model.md) and
[Shaped reads and verb results](shaped-reads-and-verb-results.md). Read the
design first; this document assumes it and does not restate it.

The command surface — the third concern in that umbrella,
[CLI surface shape](cli-surface-shape.md) — is out of scope here and moves on
its own timeline. One piece of it is unavoidable: the concise selection syntax
needs its own flag before it can grow address notation, so `--select` lands in
the first stage rather than waiting.

## Governing decisions

**One read step, several arrivals.** `cf piece get`, `cf piece call`, and
`cf wish` are different operations that end in the same place: a cell, and a
caller who wants structured output. That terminal step is factored out once and
shared. No arrival grows its own output handling.

**A selection is a schema.** Schemas are queries here; what a reader supplies is
a schema like any other, differing in authority rather than in kind. The
concise syntax is a shorthand that desugars into one.

**Addresses are marked, not inferred.** A `$link` marker beside `properties`
says "give me the address at this position rather than its contents". Nothing is
derived from what a selection omitted.

**Treatment keywords stay the source's.** `asCell`, `default`, `scope` and `ifc`
are never a reader's to supply, in either syntax, and this work adds no
carve-out.

**The address change lands before addresses are published.** Scoping invocation
ids to a session changes where a receipt lives. Doing that before anything hands
a caller a receipt address means no caller ever holds one that later moves.

## What is settled

Both questions this work once waited on are decided, and the design records
them.

**Receipts carry a descriptive schema**, distinct from the declared result
schema that waits for the Fabric-types stream design. The compatibility gate
compares only a pattern's argument and result schemas across versions, so it
never reaches a receipt and no permanence obligation attaches.

**Invocation ids are scoped to a session**, not a principal. An identity
separates nothing when agents work under their human user's key, and a minted
session is unguessable where a DID is public.

**An invocation id without a session is an error.** Naming an invocation is
asking for an outcome to be addressable and replayable; without a session that
address is shared with everyone using the same verb, so the request cannot be
honored as asked. Refusing is louder than scoping to a per-request session
nobody can reach, and both beat leaving an unscoped path that callers would
learn to rely on precisely because it lets them share receipts.

## Backlog

**Emit a verb's declared result schema onto `module.resultSchema`.** The field
exists, `lift()` already populates it, and the runner already consumes it; what
is missing is the transformer emitting one for `handler()` and the runtime
signature accepting it. It would give discovery — a caller could learn a result's
shape before calling — and turn C1's description into a declaration.

The permanence objection that withdrew result-schema emission in July does not
reach it: that put a `result` keyword *inside* a schema, sibling to `asCell`,
landing in `Pattern.resultSchema`, which the compatibility gate compares across
versions and would then refuse to let go. `module.resultSchema` is a separate
field on a node, and `assertPatternSchemasBackwardCompatible` only ever compares
a pattern's two top-level schemas. Baselines would gain content, which the
append-only gate permits — it forbids deleting baselines, not enriching new ones.

Worth its own conversation with the owner who made that call, since it is
adjacent work even though the objection misses.

## Non-goals

Collection windowing, recovery of an outcome whose address was lost, batching,
a canonical locator, and the command-surface renames. Each is recorded as
deferred in the design documents, with the condition that would reopen it.

## Stage 1 — foundation

Nothing here is visible to a caller.

**F1. Factor the read step out.** *(M)* One implementation turning a cell and a
selection into structured output, with `piece get` as its first caller.

Its shape is the thing to get right, because three more callers arrive later. It
takes a **cell**, not a piece address — resolving an address to a cell belongs to
the caller, which is what lets `piece call` hand it a receipt and `wish` hand it
a resolved target. It takes the selection already parsed, so each arrival owns
its own flag surface. It returns the structured value, leaving rendering to the
caller. The existing transform in `packages/cli/lib/piece-get-transform.ts` is
the body of it; this is an extraction, not a rewrite.

Three decisions inside F1. The `PieceGetTransform` type is renamed — it is the
caller's **selection**, and its current name asserts a piece where none is
required, which is the misnaming the CLI surface document objects to elsewhere.
`runtime` and `space` stay explicit parameters rather than being derived from
the cell: `runtime` is not on the public `Cell` interface, and the caller's
space is not always the cell's, so deriving would silently relocate where the
transform pattern runs. And the verb-read refusal stays with `piece get` rather
than moving into the shared step, which keeps the step free of policy and leaves
open whether call results should inherit it.

**F2. `--select` for the concise syntax.** *(S)* The concise path list moves to
its own flag; `--schema` keeps full schemas and `@file`. Concise input on
`--schema` continues to work, without a warning — there is no removal date yet,
and warning on every invocation would be noise in the skills that teach it.

*Exit:* `piece get` reads through the factored step, both flags work, and
`packages/cli/test/piece-get-transform.test.ts` passes **unchanged**. A moved
expectation means the extraction changed behavior and is wrong.

## Stage 2 — addresses in results

**A1. `$link` in a selection.** *(M)* The projection-only keyword, refused today
alongside the treatment keywords, becomes meaningful: a marked position returns
its address rather than its contents, rendered as the declared link shape and
not the runtime envelope.

**A2. Compose the rejecting selector.** *(M)* A marked position contributes a
rejecting selector to the path union the projection already builds, so its
target is never loaded. This is what makes a marked collection cost one document
rather than one per element.

**A3. `@` in `--select`.** *(S)* The suffix desugars to `{"$link": true}` at the
leaf, in place. `topic@,topic.title` unions into a marker plus a projection and
renders as one result carrying both. `@` is special only as the final character
of a path segment, and `\@` escapes it, so a field genuinely named `user@home`
stays reachable.

**A4. `--piece` accepts the entity URI.** *(S)* `entityIdFrom` takes an `of:`
scheme and refuses `computed:` rather than stripping it. Independent of
everything else here, and everything that composes an emitted address into a
following command waits on it.

*Exit:* a created child's address survives a read, composes into the next
command without reshaping, and a marked collection is measurably one document.

## Stage 3 — session identity

Ahead of anything that publishes a receipt address, so no caller holds one that
later moves.

**S1. Mint and plumb a session.** *(M)* `cf session new` emits a bare random
string on stdout — no file format, since unlike `cf id new` there is no key
material and a keyfile shape would only be cargo-culted. `--session` and
`CF_SESSION` carry it, following `CF_IDENTITY` and `CF_API_URL`. Accepted and threaded through, but **not yet joined to the
hash** — nothing observable changes, and the mechanism can be exercised before
it matters.

**S2. Join the session to the hash.** *(S)* The session enters the hash
`scopeCallerEventId` computes, so an id chosen in one agent's session and in
another's land on different receipts. `--invocation` without a session becomes
an error.

*What that breaks, measured.* Nothing relies on unscoped matching incidentally;
what relies on it is the tests of the property itself.
`packages/cli/integration/verbs-over-the-cli.sh` replays one id to assert
deduplication, and `packages/cli/integration/integration.sh` has four retry
scenarios doing the same across separate processes. All of them pass a session
after this, which is the change rather than a casualty of it.

This is the one address-changing commit in the plan. It carries nothing else,
lands in a single deploy, and does not roll out behind a flag that would leave
two addressing schemes live at once.

*Exit:* two sessions using the same invocation id against the same verb resolve
to different receipts; one session replaying an id resolves to the same one.

## Stage 4 — calls

**C1. Receipt cells carry a descriptive schema.** *(M)* Derived from the value
the runtime has just written and stored in the durable schema metadata, in the
same create-only transaction. Not the `getCell` schema argument, which seeds
link scope and the in-memory cell only. Structural — root container kind and
property names — since that is what narrowing needs, and recording link
positions would mean writing `asCell` onto a document nothing can be written
through. Lands before C2 so a selection over a receipt is bounded from the first
call that can express one.

*Why descriptive rather than declared.* A verb's declared result type does not
survive compilation: `handler()` takes an event schema and a state schema, its
`R` is type-level only, and the transformer emits nothing for it. The field it
would travel on — `module.resultSchema` — exists and is already populated by
`lift()`, so filling it for handlers is the better end state, and the receipt's
schema slot would then take a better-sourced value rather than a migration. That
work is on the backlog below, not here.

**C2. `piece call` gains the selection flags.** *(S)* `--select`, `--schema`,
`--filter`, all routed through F1. No second output path.

**C3. `receipt` as a top-level envelope field.** *(S)* Published from
`tx.handlingReceiptLink`, so a caller holds the address before the outcome
exists — including under `--no-wait`, which today returns none.

*Exit:* a verb's result and the same data read directly render identically under
the same selection, and the walkthrough's `jq | sed` address extraction is
replaced by reading the rendered address.

## Dependencies

Stages are ordered, but not everything in them is blocked.

| Item | Blocked by | Note |
| --- | --- | --- |
| F1 | — | everything selection-shaped depends on it |
| F2 | — | independent of F1; grouped for one flag change |
| A1 | F1 | |
| A2 | A1 | |
| A3 | A1, F2 | needs both the marker and the flag |
| A4 | — | can land any time; grouped where its value shows |
| S1 | — | |
| S2 | S1 | must precede C3 |
| C1 | — | independent; ordered before C2 for the bound |
| C2 | F1, A1 | A1 for marked positions in call results |
| C3 | S2 | the ordering this plan exists to get right |

## Test strategy

**F1 is a refactor, so its test is that nothing changes.**
`packages/cli/test/piece-get-transform.test.ts` passes untouched.

**A1–A3 extend the CLI integration walkthrough.**
`packages/cli/integration/pattern/verb-results.tsx` is already a fixture with a
returned child, and `verbs-over-the-cli.sh` already drives it; the walkthrough
gains steps rather than a new fixture. Three assertions worth pinning: a marked
position renders an address and not its contents; a marker beside a sibling
projection renders both; a marked collection issues one document read. The third
wants a unit test in `packages/cli/test/` rather than the shell walkthrough,
since counting reads is not observable from stdout.

**A4 is testable by identity**, as a unit test: the same piece resolves through a
bare hash and through its `of:` form, and `computed:` is refused by name rather
than coerced.

**S2 wants two sessions and one verb** — an integration test, since it is about
addresses that differ across processes. The negative case matters as much: one
session replaying an id must still deduplicate.

**C2's test is symmetry.** The same note read through `piece get` and read out of
a `piece call` result produce the same rendering under the same selection.

**Waiting.** Anything that needs a receipt to exist subscribes rather than polls
(`docs/development/waiting-in-tests.md`).

## Risks

**F1 is a refactor over code with a live consumer.** `piece get`'s projection is
recently changed and load-bearing for the topics workflow. The mitigation is
that F1 adds no surface: if its test expectations move, it has gone wrong.

**S2 changes where receipts live.** The ordering removes most of this — nothing
has published an address yet, so no caller holds one that moves. What remains is
in-flight retries across the deploy: an id issued before the change and replayed
after resolves somewhere new and re-executes rather than deduplicating. Bounded
to that window, and the reason S2 lands alone.

**Session scoping puts one more thing in the caller's keeping.** After S2 an
address depends on the session it was created under, so a caller who loses that
session id cannot recompute where its outcome went. That is the recovery case
already deferred in the design, now with a second input to retain alongside the
piece, verb and id. It argues for the session identity being something a harness
persists rather than something a human types.

**`$link` is a wire contract from A1 onward.** Its field defaults are specified
in the design; changing them after callers read them is the breakage the
declared shape exists to prevent.

## Documentation owed

Each step carries its own, rather than a sweep at the end.

| Step | Owed |
| --- | --- |
| F2 | `packages/cli/README.md` output conventions: two flags, which syntax each takes |
| A1, A3 | The marker and the suffix, same file; [Verbs over the CLI](../common/verbs-over-the-cli.md), already stale |
| A4 | Address forms wherever `--piece` is taught — the CLI README and the tutorial's workflow chapter |
| S1, S2 | `cf session new`, `CF_SESSION`, and what an absent session means; the CLI README and the agent-facing skills that teach invocation ids |
| C1 | What a receipt declares, in the design document's open-question slot |
| C2, C3 | `piece call`'s section, and the envelope's fields |
