# Pattern verb contract

**Status:** design draft — not implemented, not agreed. This document exists to
be argued with before any code is written.

**Summary.** A pattern's declared verbs are its agent API: the CLI is a generic
projection of them, so each pattern defines its own command surface and no
pattern-specific CLI code exists to write or drift. Today that projection is
lossy — a create returns no handle, a rejection looks like success, a retry can
duplicate. Part 1 is the authoring contract for verbs: named fields, atomic
units, declared results, typed rejections, no call-order dependence. Part 2
makes results durable and retries idempotent by exposing the scheduler's
existing event-id and receipt machinery through the callable layer. One small
runtime change; everything else is exposure.

## Goal

Any pattern drivable by an agent, with no pattern-specific CLI code. Filing one
topic on the team board takes six CLI invocations, returns no handle, hides
rejections, and duplicates on retry. The fix is smaller than it looks, because
the hard parts already exist in the runtime: a durable id per event, a
per-invocation result cell addressed by it, and an exactly-once receipt.

The design is two halves. **Part 1, the verb contract**: rules pattern authors
adopt so their verbs are drivable — pattern-owned vocabulary, no new machinery.
**Part 2, the invocation protocol**: the scheduler's existing invocation
machinery exposed through the callable layer — caller-supplied ids in, durable
results back. Patterns choose the words; the runtime carries them.

`topics` / `topic` is the running example and the intended first adopter.

## The problem

Filing one topic headlessly takes six CLI invocations:

| invocations | what | cause |
| --- | --- | --- |
| 1 | `addTopic {title, agentName}` | the create itself |
| 1 | `get crossrefs --step` to learn the new fid | create returns no handle |
| 3 | `setBody` / `addComment` / `addLink` | the body cannot ride the create; the comment and link are the real work |
| 1 | a verification read (`get … --step`) | no result to inspect |

Half of this is protocol tax: the fid lookup and the verification read exist
only because nothing is returned, and `setBody` rides every create only
because the create cannot carry a body.

Three consequences:

- **Create returns no handle.** `addTopic` returns nothing, so the caller reads
  `crossrefs` to learn which topic it made — and `TopicCrossref.fid` reads `""`
  until known. (Sub-piece addressability by fid itself works — #4758; only the
  return value is missing.)
- **Semantic rejection is invisible.** Runtime failures surface; a verb
  declining on its own terms does not. `addTopic` early-returns on an empty
  title and on a blank `agentName`, both indistinguishable from success.
  (Throwing instead would surface today — as prose in a failure message, not a
  typed code.)
- **Retries can duplicate.** One reported headless session saw creates report a
  sync timeout after the write had committed, so retrying minted duplicates.
  The topics skill advises "retry once" on an initial-sync timeout — safe only
  when initial-sync and post-send timeouts are distinguishable to the caller.

The redesign below starts from the machinery that already exists, states which
of its properties are load-bearing, and then changes only the rest.

## What already exists

The CLI has two callable contracts (`packages/cli/lib/callable.ts:260-286`), and
both of them block:

**`handler`** — default verb `invoke`, input schema only. Execution sends into
the stream, awaits `runtime.idle()` and `manager.synced()`, then inspects the
transaction and throws on runtime failure (`:294-320`). It returns nothing.

**`tool`** — default verb `run`, input schema plus `outputSchemaSummary`. A tool
is a *bound sub-pattern*: execution calls
`runtime.run(tx, pattern, mergeToolInput(input, extraParams), resultCell)` to
instantiate the pattern with the caller's arguments merged over the bound ones,
into a freshly minted result cell (`runtime.getCell(space, crypto.randomUUID(),
…)`), then returns that cell's value as `outputText` (`:330-391`).

And beneath the CLI, the scheduler already has invocation machinery that the
callable layer predates:

- Every event gets a **durable event id minted at send time**
  (`packages/runner/src/scheduler/event-identity.ts`; spec scheduler-v2 §7.5),
  and `queueEvent` already accepts a **caller-supplied id** —
  `opts.eventId?` (`packages/runner/src/scheduler/facade.ts:1308`), with its
  own passing test suite
  (`packages/runner/test/scheduler-event-receipts.test.ts`). The `cell.send()`
  path simply never passes one (`packages/runner/src/cell.ts:1276`).
- Every handling gets a **canonical per-invocation result cell** addressed
  `{ resultFor: cause }`, where `cause = { $ctx: <bound closure>, $event:
  <event id> }` (`packages/runner/src/runner.ts:4098-4101`, `:3696-3745`) — so
  the address folds in the handler's binding, not the id alone. A return value
  **containing reactives or cells** is run as a result pattern into that cell
  (`navigateTo` is the existing UI consumer); a **plain JSON return is
  discarded** — the receipt-only branch writes `{}`.
- That result cell doubles as the **exactly-once receipt**: its create is
  create-only, so a second handling of the same id — including from another
  replica against a shared server — collides, and its commit is rejected as
  `PreconditionFailedError` / `precondition: "receipt-exists"`,
  programmatically distinguishable from a real failure (spec §7.6, invariant
  I11). The governing `commitPreconditions` flag is on by default on the CLI's
  runtime path (`runtime-presets.ts:207` →
  `experimentalOptionsFromEnv`). Exactly-once is **per commit, not per
  execution**: a colliding delivery still runs the handler body and then loses
  the commit, so a handler must keep side effects in its writes — which the
  model already demands.

Measured against the problem above, what is absent is not machinery but
plumbing through the callable layer:

1. **No caller-supplied id from the CLI.** `cf piece call` sends without an
   `eventId`, so a client retry mints a fresh event and re-executes rather than
   colliding on the receipt.
2. **No readback.** The CLI handler branch awaits commit and returns `{}`
   (`callable.ts:294-320`); the per-invocation result cell exists at a
   computable address, and nobody reads it.
3. **Patterns return nothing.** All of `topics` is handlers that return no
   value — `addTopic: Stream<AddTopicEvent>` on the board, and the
   `AgentAuthoredEvent` family (`addComment`, `addLink`, `setBody`) on the
   child — so the result cells that would carry their outcomes are empty.
   (Tools do return values, but a tool instantiates a bound sub-pattern into a
   fresh cell — external logic, not a mutation of the host piece. It is the
   wrong fit for verbs, and no third callable kind is needed: handlers already
   have the result channel.)

## What the current shape requires, and what is incidental

This section states what we take the current design to require, so a reader can
flag a wrong assumption before it becomes a wrong choice: the redesign keeps
what is load-bearing and changes only what is not.

**Fire-and-forget streams are essential** — in a narrow sense worth pinning
down, because the loom FUSE audit calls a neighbouring behaviour a bug.
Essential: a handler's *effect* is writes that propagate, not a value returned
into the stream. *Not* essential, and what the audit flags as a spec violation,
is *acknowledging a write before its transaction commits*. The runtime's own
result-cell path confirms this reading: a handler's outcome is itself a write —
the result pattern committed with the handler's transaction — never a
synchronous channel bolted into the stream. This design adds nothing to that
model; it exposes it.

**The CLI's silences are incidental.** Not passing an `eventId` and not reading
the result cell are omissions in the callable layer, not properties the system
relies on. Closing them is safe; what it costs is two commitments:

- **Honouring caller-supplied ids** obliges us to define what a repeated id
  means and to trust callers not to collide — though the collision behaviour
  itself (create-only receipt) is already the scheduler's invariant, not new
  machinery.
- **Handing out result-cell addresses** commits the runtime to those addresses
  still resolving later — a lifetime it does not owe today. Receipts already
  persist per event with no stated retention, so this obligation exists on the
  platform now, unnamed; this design inherits and names it rather than creating
  it.

### Obligations of idempotency

- **The retention window becomes the guarantee window.** Idempotency means
  "this id will not take effect twice"; how long that holds is exactly how long
  the record survives. A promise of idempotency without a stated duration is
  not a promise.
- **Repeated id, different payload** is already answered by the machinery,
  silently: the receipt address excludes the payload, so the second call
  collides regardless and the caller reads back a result computed from the
  *first* payload. The remaining decision is narrower — accept silent
  first-payload-wins, or carry a payload digest in the envelope so a mismatch
  is reported rather than masked.
- **Concurrent calls on one id must converge to one outcome** — but they need
  not serialize, and the platform does not: each executes optimistically and
  the create-only receipt arbitrates at commit. First committer wins; every
  loser is rejected with `receipt-exists` and reads the winner's outcome back.
  Harmless by construction, because a losing execution's effects roll back
  with its transaction.
- **The record and the effects must commit together.** Effects without a record
  make a retry duplicate; a record without effects makes a retry silently skip.
  The receipt's create-only write rides the handler's own transaction, so for
  same-space effects this holds by construction. The spec carves out the
  exception itself: cross-space child-first materialization is "a non-atomic
  phase with the current I11 gap" (scheduler-v2 §7.6), so a verb whose effects
  span spaces does not yet get this guarantee.

### Obligations of persistent results

- Storage grows with call volume and does not shrink on its own.
- Results embed whatever the handler read, so a stored record needs the same
  scoping and labels its source data carried.
- Stored results were written under older result schemas, and readers must cope.
- Once readable, invocation history is a feature people depend on, and its
  shape becomes a contract.

## Part 1 — the verb contract

1. **Named fields only.** Every argument is a named field in a declared input
   schema. A client may offer positional sugar when the schema has exactly one
   required field; the contract itself stays named.
2. **Valid on its own.** A verb leaves the piece in a state a reader can accept,
   without depending on a follow-up call to become correct.
3. **Declared result.** A verb that produces something declares a result schema
   and returns a value. A verb that produces nothing says so.
4. **Rejection is a value.** Invalid input, wrong turn, precondition unmet — a
   typed error with a stable code. (Authorization is not the contract's job:
   CFC already rejects unauthorized commits and the runner surfaces the error,
   `packages/runner/src/runner.ts:835-840`.)
5. **Address by identity, never by position.** `{ topicFid }`, not `{ index }`;
   indices shift under concurrent writes. `topics` already works this way —
   `crossrefs` rows carry their topic precisely so consumers never correlate by
   index.
6. **No implicit dependence on state set by an earlier call.** A verb may take a
   cell reference as an explicit argument; what it may not do is read state that
   some prior verb was expected to set. Verbs written for UI convenience may
   still wrap a contract verb and read a session draft — the rule governs the
   agent-facing contract.

Rule 6 has teeth: any "call A, then call B" sequence where A configures B is a
race under concurrency. Its canonical instance is attribution.

### Attribution: two parties, not one

A write carries two attributions — who authorized it and who performed it.
Conflating them in one settable display-name cell that each caller resets
before mutating is the rule 6 race in its purest form. They are separate
facts and are carried separately; `topics` is the template:

- The **principal** — whose key authorized the write — stays fabric-level:
  CFC carries it in its integrity labels (`packages/api/cfc.ts:829-841`). For
  display, the browser path resolves the viewer's canonical Profile
  (`wish({ query: "#profileName" })`;
  `docs/common/patterns/multi-user-patterns.md:263-272` — "the viewer is
  whoever the runtime says they are") and stamps a structured
  `TopicAuthor { kind: "person", name, avatar? }`.
- The **actor** — what performed the write on the principal's behalf — is a
  required field on every mutating event (`AgentAuthoredEvent { agentName }`),
  stored as `TopicAuthor { kind: "agent", … }`. Its own doc comment states the
  contract: display attribution only; write authority remains the principal's.

The actor as an explicit verb argument — per call, no prelude, no shared cell
to interleave on — is the interim form. The end state is Part 2's: carry the
actor in the invocation envelope, so `AgentAuthoredEvent` stops being
boilerplate every pattern re-declares on every mutating event. Either way the
actor is a claim, not an authenticated fact — the principal vouches for it,
the way a git signature vouches for an unverified author string. Whether an
actor can ever be *authenticated* is a separate question about keys (open
question 2).

### Discovery

A client holding only a board URL must reach the board's children without an
O(children) sweep of per-child reads. So a parent exposes a **compact index** on
its result — one row per child carrying its fid and the summary fields a survey
needs (name, author, timestamps, counts) — making the whole board one read and
every child addressable by the fid in its row. `topics` already has the shape in
`crossrefs`; the step is to treat that as the deliberate discovery surface, not
a by-product of the cross-reference graph.

Discovery is the parent's job; the child's own verbs are the child's. A comment
is addressed to the topic, not routed through the board — **but that depends on
the CLI dispatching a nested piece's streams, which today fails with
`Transaction required for .set()`** (`packages/runner/src/cell.ts:1294`; its own
board topic). Until that lands, board-level routing
(`addComment {topicFid, body}`) is the documented workaround — pragmatic, not
the target shape.

### Composition: the atomic-unit rule

**A verb's payload matches the atomic unit of the domain — no smaller, no
larger.**

- **Too small** is a verb whose intermediate state is *invalid* and needs a
  follow-up call to repair — a rule 2 violation. `addTopic` without a body
  argument is this: a topic born with a body should appear with it; no reader
  should observe the halfway state.
- **Too large** is a verb that bundles independently-valid units to save round
  trips. `setBody`, `addComment`, and `addLink` are three verbs because a topic
  without its links yet is a legitimate observable state — a human mid-edit
  produces it constantly. Bundling buys a combinatorial verb surface, muddier
  rejection semantics (which part failed?), and coarser authorization
  granularity.

The corollary: **round-trip cost is never a reason to change a verb's size.**
The loom arc's evidence for fat verbs (Prior art) was earned under ~25 s per
fresh-replica CLI call — a client pathology, since a session or batch pays boot
once — and a verb surface shaped around it would outlive it. The costs small
verbs surface belong elsewhere:

- **Call cost** → the client: batching or a persistent session, no pattern
  change.
- **Atomicity** → the transaction: a handler's writes already commit
  atomically (spec scheduler-v2 §7.6), so a domain unit that must appear at
  once is expressed as one verb — which is what the rule already says. A
  client-side boundary spanning *several* invocations is out of scope here and
  belongs to the invocation layer.

### Positional arguments

One obvious subject reads well — `git checkout <branch>`, `docker run <image>` —
and it cuts quoting burden for agents. The risk is evolution: a second argument
makes ordering silently significant.

The compromise: patterns declare named fields; a client may accept a single bare
value **only when the schema has exactly one required field**. Adding a second
required field later stops the sugar applying rather than silently misbinding.

### Applied to `topics`

`topics` already satisfies the attribution rules; filing is six invocations.
The rest of Part 1 — a body argument on `addTopic` so `setBody` becomes an
editing verb rather than part of every create, and thrown rejections in place
of silent early-returns — makes it five. The remaining waste — the fid lookup
and the verification read — is exactly what a returned result removes, and
that is Part 2's job: with it, filing is `addTopic`, `addComment`, `addLink` —
one call per thing the author meant to do.

## Part 2 — the invocation protocol

Part 2 is the machinery from "What already exists" exposed through the callable
layer: the caller supplies the id `queueEvent` already accepts, and reads back
the record the runtime already writes.

### Shape

Every invocation is addressable by an id the caller supplies. The runtime
builds the `Invocation` and hands it back as the verb's return value:

```typescript
// Shown for illustration only.
interface Invocation<Out> {
  /** Caller-supplied. Doubles as the idempotency key. */
  id: string;
  /**
   * The second attribution party — the agent when acting under a human's key,
   * the human when the agent holds its own. The principal always comes from
   * the write, never from here. An object rather than a bare string so a
   * `verified: true` field can be added once delegation exists (absent means
   * unverified) — additive only because this schema is authored open-world
   * (see Results and schema evolution).
   */
  actor?: { name: string };
  status: "pending" | "settled" | "failed";
  result?: Out;
  error?: { code: string; message: string };
  startedAt: number;
  settledAt?: number;
}
```

The `Invocation` is both the value a caller receives from the call and the
durable entry that same caller can revisit later by id — deliberately not
named a result, which would capture only the first half. It is a **view over
the existing receipt cell** — per the
scheduler spec, "the receipt is the handling's result cell", not a new document
kind — plus envelope fields (`actor`, timestamps, the error shape) that the
receipt does not carry today.

What it provides:

- **Per-invocation isolation.** Each call has its own slot, so concurrent
  callers never collide. (Already true: one result cell per handling.)
- **Idempotency.** Same id, same slot; a retry after a timeout collides on the
  create-only receipt instead of re-committing, and the client reads back the
  original outcome. (The collision is the scheduler's existing I11 invariant;
  what is new is only that a *caller's* retry reuses the id and so takes the
  same path as a redelivery. Reading back the original result additionally
  requires the result to be in the receipt — the plain-return gap, open
  question 3.)
- **Durability.** An agent that dies mid-call reads its settled result
  afterwards. (Settled only: a failed handling commits no record — see Retries
  and failure.)
- **Rejections are values.** A declined verb returns a typed error to its
  caller rather than looking like success.

### Settlement and waiting

An invocation is **settled** when the verb's own execution has completed and its
transaction committed: `return` settles, `throw` fails. Effects that propagate
downstream are not part of settlement, which keeps the term bounded for verbs
with fan-out.

This is not a new semantic — it is when the receipt commits today. The work is
exposure: the CLI currently awaits the commit and then discards everything
(`callable.ts:294-320`).

Waiting is a caller-side choice — whether to wait at all, and for how long. This
replaces the current fixed 15 s `DEFAULT_TOOL_RESULT_TIMEOUT_MS`, and the wait
observes settlement rather than polling for it.

### Choosing an id

Caller-supplied opaque string; the client generates a UUID by default and lets
the caller pass one explicitly. It flows through as the durable event id —
`queueEvent` already accepts `opts.eventId`, and `mintEventId`'s own contract
anticipates it: "ingress callers that already own a durable delivery id pass it
through instead." The CLI becomes such an ingress caller; the gap is one
plumbing hop in `cell.send()`, which today passes no id.

Content-derived ids are available to a caller that wants them, but are not the
default, since posting the same message twice is a legitimate thing to want. A
stable caller-chosen key suits operations that are logically once-only, such as
`import-run-3/row-7`.

### Retention

Retention has three parts:

- The pattern declares an **allowable range and a default** for how long its
  invocation records are kept.
- A client may **request a value** within that range.
- A client may **request early expiry** — most usefully read-and-expire, where
  successfully collecting the result releases the record.

Because retention bounds the idempotency guarantee, these are correctness
parameters as much as storage ones.

### Storage and privacy

The underlying receipt cells already exist per event, addressed
deterministically from the event id **plus the handler's bound closure**
(`cause = { $ctx, $event }`) — verified byte-identical across independent
replicas, because a bound closure serializes to stable content-addressed links.
Reachable by a caller that can reconstruct that cause from the callable cell,
but enumerable by nobody. What retention needs on top is a **collection linked
from the piece**, so records can be listed and expired without touching piece
state. (This mirrors the unlinked-tool-result-cell defect below: deterministic
addressing without linkage is how storage becomes permanent and invisible at
once.)

Records carry the same scoping as the callable that produced them. Tool result
cells already inherit `resultScope` from the callable cell
(`packages/cli/lib/callable.ts:340-346`), so the mechanism exists; today those
cells are unlinked and merely unguessable.

Scope is not the whole confidentiality story: a result derived from labelled
data carries CFC confidentiality labels of its own, so a stored invocation
record is subject to the same label rules as any other cell
(`docs/specs/cfc-label-metadata-confidentiality.md`). Retention and readback
therefore need checking against those rules, not only against cell scope.

### Retries and failure

The existing machinery's semantics stand — **decided**. The receipt rides the
handler's own transaction, so a failed handling commits no receipt: same id
after a failure re-executes, safely, because nothing committed; same id after
success collides and returns the original. At-most-once *success* — which is
what a caller retrying effects actually wants.

The consequence accepted with it: a failure is **returned, not recorded**. The
caller sees the typed error; fabric storage keeps nothing. A durable failure
record would have to commit despite the verb's transaction failing — new
machinery, adopted only if a concrete need for fabric-side failure
observability appears. Until then, watching for failures is the client's job.

A caller that wants to hide retries from its own consumers can create a durable
request cell and populate it once an attempt succeeds. That composes from the
same primitives and needs no core support, so it belongs in guidance as a
pattern to follow rather than in the runtime.

### Results and schema evolution

A verb's result schema declares whether it carries a live piece reference or a
self-contained snapshot — the pattern knows which is meaningful for that verb.

The result schema is part of the piece's public contract, and the repo already
checks pattern schema evolution: `assertPatternSchemasBackwardCompatible`
(`packages/piece/src/schema-compatibility.ts:125`) runs on every `setsrc` unless
`--dangerously-allow-incompatible-schema` is passed
(`packages/piece/src/ops/piece-controller.ts:2723-2724`). It checks arguments
and results in **opposite directions** (`:151-183`):

- **Arguments**: previous ⊆ candidate. Inputs may widen but not narrow; a new
  required field is incompatible.
- **Results**: candidate ⊆ previous. Results may narrow freely — but *adding* a
  result field is only compatible if the previous schema was open-world.

That second direction matters here: a declared result is easier to shrink than
to extend, so the result shape wants to be right early, or deliberately
open-world. The `Invocation` shape is the first schema this applies to — it
must be authored open-world so fields like `verified` can be added later.

### Authoring

```tsx
// Shown for illustration only.
const addTopic = action(
  ({ title, body }: AddTopicInput): AddTopicResult => {
    const trimmed = (title ?? "").trim();
    if (!trimmed) throw new VerbError("EMPTY_TITLE", "title must be non-empty");
    const piece = Topic({ title: trimmed, body, mentionable: topics });
    topics.push(piece);
    return { topic: piece };
  },
);
```

`throw` becomes `status: "failed"` with the code; `return` becomes
`status: "settled"` with the result. Only settlement is durable — a failed
status is returned to the caller, not recorded (Retries and failure).

### Verb discovery

An agent holding a piece URL must be able to ask "what can I call here?"
without reading pattern source. The pieces exist:

- **Per verb**, `cf piece call <piece> <verb> --help --json` already emits the
  machine-readable command spec — kind, default verb, input schema — derived
  from the pattern's own types (`packages/cli/lib/callable.ts:260-286`).
- **Enumeration** exists only through FUSE, which classifies a piece's result
  entries (`packages/fuse/callables.ts:88`) and projects `.handler` / `.tool`
  files plus a `.handlers` listing — flagged on the board as neither universal
  nor complete. The CLI has no listing at all; `cf piece call` requires the
  name. The topics skill compensates by hand-listing the verbs in prose — a
  maintained copy of what the durable result schema already knows.

Two additions close it:

1. A CLI listing (`cf piece verbs --json`, or a `callables` section in
   `piece inspect --json`): name, kind, and schemas per verb in one read —
   the same classification FUSE already performs, exposed generically.
2. **Result schemas for handlers.** The command spec carries an output schema
   only for tools, because handlers return nothing today. Rule 3's declared
   result must reach the piece's **durable schema** — otherwise introspection
   can name a verb and its arguments but never what it returns. This rides
   staging step 4, where verbs first return values.

**What gets listed: everything is publishable; hiding is a view default, never
a boundary.** The verbs live in the durable schema, which any reader of the
piece can already enumerate — so omission from a listing removes nothing and
must not pretend to. Whether a call is *permitted* stays where it is: CFC
decides at commit; the listing shows availability, not permission. The useful
distinction is instead rule 6's two tiers, which `topics` already exhibits:
contract verbs (`addComment`, `setBody`, `addLink`) versus UI-convenience
wrappers (`submitComment`, `startEditBody`, `saveBody`, `cancelEditBody`,
`submitLink`) that read session-local drafts and therefore silently no-op in a
headless replica — listing them unmarked hands an agent five trap verbs. A pattern may mark that
wrapper tier (a schema annotation, plausibly a type-level marker in the
`PerSession` family — apt, since reading per-session state is very nearly the
tier's definition); the default view shows the contract tier, and `--all`
always shows everything. The marker can ship after the listing; these
semantics are settled now so the unmarked v1 does not harden into the
contract.

### Client surface

```text
$ cf @topics addTopic --title "Verb contract" --body @body.md
{ "invocation": "inv_7f3a", "status": "settled",
  "result": { "topic": "fid1:abc" } }

# The client mints the id before sending and prints it even when its wait
# times out. Retrying with it returns the original — no re-execution.
$ cf @topics addTopic --title "Verb contract" --invocation inv_7f3a
{ "invocation": "inv_7f3a", "status": "settled",
  "result": { "topic": "fid1:abc" } }

# The caller chooses whether and how long to wait
$ cf @topics summarize --topic fid1:abc --no-wait
{ "invocation": "inv_9c1b", "status": "pending" }
$ cf @topics invocation inv_9c1b --await
{ "invocation": "inv_9c1b", "status": "settled",
  "result": { "summary": "..." } }
```

`@topics` is a client-side binding of a name to a piece URL, stored by the
invoking tool: different clients may want different names, and the binding has
to resolve before the fabric is reachable. Slugs (`cf piece set-slug`) provide
fabric-side naming within a space; a binding supplies the host and space half.

## Defects and unknowns in the current machinery

- **The tool result wait is a poll.** `defaultWaitForResult`
  (`packages/cli/lib/callable.ts:206-222`) calls `resultCell.pull()` every 25 ms
  up to a 15 s timeout, then throws — a timeout, a sleep, and a retry loop, the
  trio `AGENTS.md` says to flag. An observation mechanism is already present:
  `running.sink(…)` at `:353` is used as a fast path when it fires before
  commit. Settlement should await the sink.
- **Tool result cells are unlinked, and their collection status is unknown.**
  Created with a random UUID whose address is never returned. A search of the
  memory and storage layers turned up no collection of unreferenced cells; that
  search was not exhaustive, and the answer should be confirmed before the
  retention design is settled.

## Checking the design against other patterns

| pattern | verb | stresses | holds? |
| --- | --- | --- | --- |
| `topics/` | `addTopic` | returning a handle | yes |
| `battleship/` | `fire` | conditional rejection ("not your turn") | yes — a typed code lets the agent decide whether to wait or stop |
| `scoped-group-chat/` | `postMessage` | append-only under concurrency | yes, and this is where the idempotency key earns its keep: a blind retry double-posts today |
| `lunch-poll/` | `vote` | naturally idempotent update | yes; the key is harmless where it is unnecessary |
| `deep-research.tsx` | LLM-backed verb | result unavailable at return time | yes — the verb settles with a reference and the caller waits on that cell separately |
| `counter/` | `increment` | single-user, trivial verb | yes |

The chat case is the sharpest test: it is the one where today's behavior is not
merely inconvenient but wrong, and where client-side care cannot fix it.

## Prior art

The loom fuse-fabric-access arc (loom PR 4183) reached this territory first: it
put an agent handle on loom's mobile root piece and wrote down the conventions
that made it drivable. Its topics-board incarnation — the board topic *"Give
the topics board an agent handle"* (Ben + Claude, 2026-07-22) — asks for five
things: atomic `addTopic {title, body?}` returning the new fid, idempotency on
create, a board index cell, board-level `addComment {topicFid}`, and an
identity guard on mutating verbs. Every ask maps to a section above — the
identity guard is the required `agentName` on every mutating event. This
document is their pattern-agnostic generalization. Deeper detail lives in the
arc's defect register and
`docs/development/projects/fuse-fabric-access/topics-agent-ergonomics.md` on
the loom PR.

Two refinements relative to the loom conventions: "complete-payload verbs" is
absorbed into the atomic-unit rule (Composition), and child-owned verbs are
preferred to parent-routed ones, with board-level routing as the documented
workaround until nested-stream dispatch lands (Discovery).

## Open questions

1. **What is the right default retention window**, given that it bounds the
   idempotency guarantee?
2. **Can the actor ever be authenticated — does an invocation need two keys?**
   Three arrangements, unequal:

   | arrangement | cost | authenticated |
   | --- | --- | --- |
   | agent uses its human's key, declares itself | none | human only |
   | agent holds its own key | a DID, home space and profile per agent | agent only |
   | agent signs under a delegation from its human | delegation credentials | both |

   Only delegation authenticates both, and it is infrastructure — issuance,
   expiry, revocation. A standalone agent key is cheaper but inverts the
   problem, leaving the accountable human unverified; it is also not small,
   since a key is a DID, a DID is a home space
   (`getHomeSpaceCell = getCell(did, did)`), and homes are private under
   now-default ACL enforcement — an agent key implies a home and profile, not
   just a credential. Until this settles, every actor claim is unverified: the
   record stores the actor as an object so a `verified` field can be added
   without migration, and a renderer should lead with the authenticated
   principal and mark the actor unverified. Nothing here forecloses delegation
   or delivers it.
3. **How do plain JSON returns reach the receipt?** A return value containing
   reactives/cells projects into the receipt, while a **plain JSON return is
   discarded** (the receipt-only branch writes `{}`, `runner.ts:3713-3725`).
   For `topics` this mostly does not bite — `{ topic: piece }` carries a
   cell — but "retry reads back the original result" is incomplete without it.
   Options: a small runtime change writing the validated plain return into the
   receipt instead of `{}`, or a contract rule that results carry at least one
   reactive. The first looks right; it is the one place this design asks the
   runtime for new behaviour rather than exposure.

## Design decisions worth recording

- **Positional arguments stay out of the contract**, available as client sugar
  under the one-required-field rule.
- **Retry composition lives in clients**, as guidance rather than runtime
  support, keeping the core small.
- **No `cf topic` command.** `packages/cli` is a layer-4 package (Operation) and
  patterns are layer 7 (End-User Programs); a pattern-specific command inverts
  that dependency and has no principled stopping point once the first one lands.
- **No third callable kind.** Tools are bound sub-patterns — external logic,
  the wrong fit for verbs that mutate their host piece — and handlers already
  have per-invocation result cells at the runtime level. The protocol exposes
  the handler path rather than inventing beside it.
- **Failures are returned, not recorded.** The receipt's
  at-most-once-*success* semantics stand as built: no receipt commits on
  failure, the same id safely re-executes, and failure observability is the
  client's job unless a concrete fabric-side need appears.
- **Every verb is listable; hiding is a display default.** Omission from the
  listing is never a capability boundary — the schema already publishes every
  verb to any reader, and permission stays with CFC at commit. Patterns may
  mark UI-convenience wrappers so the default view shows the contract tier;
  `--all` always shows everything.

## Staging

The engineering breakdown — workstreams, phases, issue graph — lives in
[`pattern-verb-contract-implementation.md`](pattern-verb-contract-implementation.md);
the steps below are the design-level order.

1. Agree this document — particularly the open questions.
2. Finish the Part 1 rework of `topics` / `topic` — the attribution rules
   already hold. Remaining, with no runtime change: a body argument on
   `addTopic`, and thrown rejections in place of silent early-returns — empty
   titles and blank agent names both drop without a trace today. (A thrown
   handler error already surfaces as a nonzero CLI exit; stable codes arrive
   with the protocol.)
3. Replace the tool-result poll with sink-based settlement and return the
   result cell's address to the caller. Standing fix, useful regardless.
4. Plumb the id and the readback: pass a caller-supplied `eventId` from
   `cf piece call` through `cell.send()` to `queueEvent`; have `topics` verbs
   return values; have the CLI reconstruct the cause and read the
   `{ resultFor }` cell after commit (explicit sync — a cold plain read
   returns `undefined`), and reclassify `precondition: "receipt-exists"` as
   success-with-readback rather than failure. Plus the one runtime change from
   open question 3 if plain returns are to survive.
5. Add the envelope fields the receipt does not carry — `actor`, timestamps,
   the typed error shape, the linked retention collection — and retire the
   per-event `agentName` fields (`AgentAuthoredEvent`) in its favor.
6. Add the client-side binding (`@name`), the client surface around invocation
   ids (mint-and-print, `--invocation`, `--await` / `--no-wait`), and the verb
   listing (Verb discovery).

Steps 2 and 3 stand on their own regardless of how the open questions land.
