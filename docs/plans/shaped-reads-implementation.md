# Shaped reads and verb results — implementation plan

Sequences the read layer and the calls layered on it, as designed in
[Reading Fabric data](fabric-read-model.md) and
[Shaped reads and verb results](shaped-reads-and-verb-results.md). Read the
design first; this document assumes it and does not restate it.

The command surface — the third concern in that umbrella,
[CLI surface shape](cli-surface-shape.md) — is out of scope here and moves on
its own timeline. One piece of it is unavoidable: the concise selection syntax
needs its own flag before it can grow address notation, so `--select` lands in
WS-A rather than waiting.

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

## Two assumptions, and where they bite

Two design questions are unresolved
([shaped reads](shaped-reads-and-verb-results.md), "Open questions"). This plan
proceeds on the assumption that both resolve affirmatively, and confines the
work that depends on them to WS-D.

**Receipts carry a durable schema.** Assumed yes. What it gates is narrower than
it looks: without it, `piece call --select` still works — the selection is
applied after materialization instead of bounding the fetch. The feature stands;
the network win waits.

**Invocation ids are scoped to a session.** Assumed yes, and scoped by
*session* rather than by principal — an identity does not separate the callers
that actually collide, since agents are told to work under their human's key
rather than mint their own. This one is **address-changing**: a given id
resolves to a different receipt than it did before. Sequencing it last is
deliberate but not free, and the cost is recorded under Risks rather than
hidden.

If either resolves negatively, WS-D changes and WS-A through WS-C do not.

## Non-goals

Collection windowing, recovery of an outcome whose address was lost, batching,
a canonical locator, and the command-surface renames. Each is recorded as
deferred in the design documents, with the condition that would reopen it.

## Workstreams

### WS-A — the shared read step

**A1. Factor the read step out.** One implementation taking a cell and a
selection and producing structured output, with `piece get` as its first caller.
Pure refactor: no behavior change, no new surface. Everything below depends on
it.

**A2. `--select` for the concise syntax.** The concise path list moves to its
own flag; `--schema` keeps full schemas and `@file`. Concise input on `--schema`
continues to work as a deprecated alias — this step removes nothing.

*Exit:* `piece get` reads through the factored step, both flags work, and the
existing projection tests pass unchanged against either spelling.

### WS-B — addresses in results

**B1. `$link` in a selection.** The projection-only keyword, rejected today
alongside the treatment keywords, becomes meaningful: a marked position returns
its address instead of its contents. Rendering is the declared link shape, not
the runtime envelope.

**B2. Compose the rejecting selector.** A marked position contributes a
rejecting selector to the path union the projection already builds, so its
target is never loaded. This is what makes a marked collection cost one document.

**B3. `@` in `--select`.** The suffix desugars to `{"$link": true}` at the leaf,
in place. `topic@,topic.title` unions into a marker plus a projection and
renders as one result carrying both.

**B4. `--piece` accepts the entity URI.** `entityIdFrom` takes an `of:` scheme
and refuses `computed:` rather than stripping it. Independently testable, and
everything that composes an emitted address into a following command waits on it.

*Exit:* a created child's address survives a read, composes into the next
command without reshaping, and a marked collection is measurably one document.

### WS-C — calls inherit the read step

**C1. `piece call` gains the selection flags.** `--select`, `--schema`,
`--filter`, all routed through WS-A's implementation. No second output path.

**C2. `receipt` as a top-level envelope field.** Published from
`tx.handlingReceiptLink`, so a caller holds the address before the outcome
exists — including under `--no-wait`, which today returns none.

*Exit:* a verb's result and the same data read directly render identically, and
the walkthrough's `jq | sed` address extraction is replaced by reading the
rendered address.

### WS-D — the assumed decisions

Ordered last, and each lands only once its question is settled.

**D1. Receipt cells carry a descriptive schema.** Written to the durable schema
metadata at result-write time, in the same create-only transaction. Not the
`getCell` schema argument, which seeds link scope and the in-memory cell only.
Unlocks fetch narrowing on receipts.

**D2. Invocation ids scoped to a caller session.** A session identity joins the
hash `scopeCallerEventId` already computes, so `add-comment-1` chosen in one
agent's session and in another's land on different receipts.

*Why not a principal.* A DID separates nothing here: agents are directed to work
under their human user's identity rather than mint their own, so the collision
that actually happens is two agents under one key. A session distinguishes them;
an identity does not.

*Why not either session id that already exists.* The storage session
(`packages/runner/src/storage/v2.ts`) is minted with `crypto.randomUUID()` and
re-minted on close. It keys commit idempotency as `(sessionId, localSeq)`, and
because every `cf` invocation is a separate process it is fresh each time.
Scoping by it would destroy the property `--invocation` exists for: a same-id
replay from a new process would compute a different address and never deduplicate
against the original. `cf-harness`'s session store is durable but is harness
state, and not every caller is that harness.

*So this needs a new concept*: a caller session identity, supplied to the CLI
and stable across the invocations that belong to one agent's working session.
Three things it has to satisfy, and they pull against each other:

- **Stable across invocations**, or same-id retry stops deduplicating — the
  feature it is scoping.
- **Distinct between concurrent callers**, or it does not solve the problem.
- **Supplied, not derived.** Nothing in a `cf` process can infer which agent
  session it belongs to; it arrives as a flag or environment variable, following
  `CF_IDENTITY` and `CF_API_URL`.

*Minted explicitly, by `cf session new`.* The session is a **namespace, not an
entity**: it is only ever hashed into the event id, so nothing stores it,
registers it, or expires it. Minting is a random opaque string on stdout, which
makes it cheaper than `cf id new` — no key generation — and it follows the shape
that command already established:

```bash
cf session new > cf.session
export CF_SESSION=$(cat cf.session)
cf piece call --invocation add-1 ...
```

Explicit rather than implicit, for two reasons. A session managed automatically
is one a caller cannot answer questions about — *which session am I in, and is
this retry landing where the last one did?* — and the two obvious automatic
schemes each break something: minting per process destroys same-id replay, and
persisting to a dotfile puts the answer somewhere the caller never looks.

The second reason is stronger, and it is why a minted session beats any derived
one. The exposure has two halves: two callers colliding on an id, and a third
party *guessing* an id to read someone's outcome. A scope derived from identity
closes only the first, because a DID is public — an address stays computable by
anyone holding the piece, the verb, and a conventional id. A minted random
session closes both, because it cannot be guessed.

*The design question inside it* is what an absent session means. Treating it as
unscoped preserves today's behavior and today's collision; refusing without one
makes every caller opt in before they can name an invocation at all. Given the
minting is explicit, the reasonable default is unscoped-with-a-documented-gap
rather than an implicit mint, but this plan does not decide it.

Address-changing; see Risks.

## Phases

| Phase | Contents | Blocked by |
| --- | --- | --- |
| 1 | A1, A2 | — |
| 2 | B1, B2, B3, B4 | A1 for B1–B3; B4 independent |
| 3 | C1, C2 | A1; C1 also on B1 for marked positions in call results |
| 4 | D1, D2 | the open questions |

B4 has no dependency on the rest and can land at any point in phases 1–3; it is
grouped with WS-B because that is where its value appears.

## Test strategy

**A1 is a refactor, so its test is that nothing changes.** The existing
`piece-get-transform` suite passes untouched. Any diff in its expectations means
the factoring changed behavior and is wrong.

**B1–B3 want a fixture with a returned child**, which
`packages/cli/integration/pattern/verb-results.tsx` already is. Assertions worth
pinning: a marked position renders an address and not its contents; a marker
plus a sibling projection renders both; a marked collection issues one document
read rather than one per element.

**B4 is testable by identity**: the same piece resolves through a bare hash and
through its `of:` form, and `computed:` is refused by name rather than coerced.

**C1's test is symmetry.** The same note read through `piece get` and read out of
a `piece call` result produce the same rendering under the same selection.

**Waiting.** Anything that needs a receipt to exist subscribes rather than polls
(`docs/development/waiting-in-tests.md`).

## Risks

**Scoping ids late is address-changing.** Once WS-C publishes `receipt`, a
caller can keep an address; when D2 lands, the same invocation id resolves
somewhere else. Old receipts stay readable at their old addresses, but a replay
spanning the change stops deduplicating and re-executes. The window is the
deploy boundary and the exposure is same-id retries in flight across it. It
lands in one deploy rather than gradually, and does not roll out behind a flag
that could leave two addressing schemes live at once.

**Session scoping puts one more thing in the caller's keeping.** After D2 an
address depends on the session it was created under, so a caller who loses that
session id cannot recompute where its outcome went. That is the recovery case
already deferred in the design, now with a second input to retain alongside the
piece, verb and id. It argues for the session identity being something a harness
persists rather than something a human types.

**A1 is a refactor over code with a live consumer.** `piece get`'s projection is
recently changed and load-bearing for the topics workflow. The mitigation is
that A1 adds no surface: if its test expectations move, it has gone wrong.

**`$link` is a wire contract from B1 onward.** Its field defaults are specified
in the design; changing them after callers read them is the breakage the
declared shape exists to prevent.

## Documentation owed

Each step carries its own, rather than a sweep at the end.

| Step | Owed |
| --- | --- |
| A2 | `packages/cli/README.md` output conventions: two flags, which syntax each takes |
| B1, B3 | The marker and the suffix, same file; [Verbs over the CLI](../common/verbs-over-the-cli.md), already stale |
| B4 | Address forms wherever `--piece` is taught — the CLI README and the tutorial's workflow chapter |
| C1, C2 | `piece call`'s section, and the envelope's fields |
| D1 | Whatever the receipt declares, in the design document's open-question slot |
