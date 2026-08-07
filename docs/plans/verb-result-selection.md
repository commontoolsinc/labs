# Verb calls: working notes

**Sketches and investigation notes, not a plan.** The design lives in
[Reading Fabric data](fabric-read-model.md) and the two documents it points at:
[Shaped reads and verb results](shaped-reads-and-verb-results.md) for the read
layer and what a call adds to it, and [CLI surface shape](cli-surface-shape.md)
for the command surface.

What is kept here is call-specific detail those documents do not carry: what
produces a receipt and what its existence proves, how a receipt's address is
derived, the entity-URI change to `--piece`, error and
exit-status conventions, sequencing, and deferred work. Draw from it; do not
treat it as a settled contract.

Anything about how a result *renders* — which positions are references, how a
shape bounds a read — has moved. A verb result is the shared read layer applied
to the receipt cell, not a contract of its own.

This continues the identity work from
[Pattern verb contract — implementation plan](pattern-verb-contract-implementation.md)
(WS-F). The user-facing surface it changes is
[Verbs over the CLI](../common/verbs-over-the-cli.md).

## Orientation

[Reading Fabric data](fabric-read-model.md) defines space, cell, address, link,
pattern, piece, verb, receipt, schema, and shape. Four more terms appear here:

| Term | What it is |
| --- | --- |
| **Handler** (or `action`) | The function body that runs when a verb is invoked. |
| **Invocation** | One call to one verb. Its id is the idempotency key: replaying a settled id returns the original outcome instead of executing again. |
| **`of:`** | The URI scheme on an entity id (`of:fid1:<hash>`). From the memory protocol's fact record — `the` (type) / `of` (entity) / `is` (value) — so an entity id names the subject a fact is *of*. The unkinded default. |
| **`computed:`** | The same slot, marking an entity whose contents are re-derivable. Reduced to a bare hash it aliases its `of:` sibling, which is a different entity — the reason `--piece` must refuse it rather than strip it. |

## The call-specific problem

**There is no durable readback.** A verb's result exists in the invocation
receipt, but the only way to re-read it is to re-invoke with the same id — which
returns the original outcome, yet re-runs the handler body, so effects outside
the transaction repeat. A caller that dispatched detached, or that lost the
response, holds no address at all, and nothing in the receipt is enumerable.

## What it looks like

Calling a verb with an id the caller chose, so the outcome stays recoverable:

```bash
cf piece call --piece <board> --invocation create-note-7 \
  createNote '{"title":"Notes"}'
```

The envelope carries the address of the cell holding this outcome. Field
spellings are the read layer's, not settled here:

```text
{ invocation: "create-note-7",
  status:     "settled",
  receipt:    <address of the cell holding this outcome>,
  result:     <what the verb returned, rendered by the read layer> }
```

Keeping that address means the result can be re-read later without running the
verb again — an ordinary read, since a receipt is an ordinary cell:

```bash
cf piece get --piece of:fid1:...
```

Losing that address is the case these notes do not solve; see
[Recovering a lost outcome](#recovering-a-lost-outcome--deferred).

## Reading a receipt

### What produces one

Only JavaScript handler dispatches.
`handleJavaScriptHandlerResult` (`packages/runner/src/runner.ts`) mints the
receipt cell **unconditionally at its top**, before any branching, and all three
downstream sub-paths resolve to that one address — a second `Cell` object is
minted later for it, so the sharing is address-level, not object-level: the
receipt-only branch writes it, the
`deferForNavigate` branch is the **sole** caller of
`setupDeferredHandlerResultPattern` (the navigateTo case, not the reactive one),
and ordinary reactive results go through `runWithStartOwnership`. Other
`{ resultFor: … }` cells in the same file take a resolved output-redirect spot
as cause and are **not** receipts — do not pattern-match on `resultFor` alone.

Tools take a different path — `runtime.run` into a fresh result cell, surfaced
as `resultRef` — and produce no receipt.

Publication also requires `commitPreconditions`, on by default and not
env-reachable
([EXPERIMENTAL_OPTIONS.md](../development/EXPERIMENTAL_OPTIONS.md)). When the
runtime produces none, the response omits `receipt` — absent, never fabricated.

**Not every receipt comes from `cf piece call`.** Shell clicks,
background-piece-service runs, and pattern-internal chains all dispatch handlers
and write receipts with deterministic ids: `queueSchedulerEvent`
(`packages/runner/src/scheduler/events.ts`, behind the `queueEvent` facade) sets
`id = args.eventId ?? mintEventId(eventLink, originTx)`. The fallback branch is
a per-transaction key plus a sequence, or a random UUID — so those receipts are
**not** re-derivable, and only dispatches that supply an id are nameable at all.
That bounds any recovery scheme to callers who chose an id in advance, and is a
reason to prefer fixing replay in the runner over deriving addresses in a
client: replay safety helps every dispatch, nameable or not.

**Should recovery ever get a name, `invocation` not `receipt`.** CFC single-use grants write a
*consumption receipt* under the reserved `grant:cfc:` scheme
(`packages/runner/src/cfc/grants.ts`), deliberately avoiding the `resultFor`
idiom so `noteSystemWrite` gates it. `cf receipt` would be ambiguous between the
two and invite the expectation that it reads the policy-state kind.

### What its existence proves

Settlement — not that the handler ran. Two cases with opposite behavior:

- **The handler throws.** The error is rethrown out of
  `invokeJavaScriptImplementation` and never reaches `postRun`, so no receipt is
  written. At readback, failure is indistinguishable from never having happened.
- **The argument fails validation** (`isValidArgument` false). The handler does
  not run, but `result` stays `undefined` and `postRun(undefined)` runs anyway,
  writing `{}` — exactly the shape a value-less success writes.

`cf piece call` catches the second in its pre-dispatch payload gate, so CLI
callers see a refusal that does not spend the id. Other dispatchers may not.

| Question | Answer |
| --- | --- |
| Did this invocation settle? | yes |
| What value is in the receipt? | yes |
| Did the handler fail? | no — failure and absence look alike |
| Did the handler body run? | no — validation non-runs write `{}` |
| Was this attempt deduplicated? | no — that belongs to the attempt |
| What invocations ran on this piece? | no — receipts are not enumerable |

This is result readback, not invocation history.

### How addresses are derived

Any scheme for re-deriving a receipt's address has to reproduce this exactly.

```text
receipt address = getCell(patternResultCell.space, { resultFor: cause })
cause           = { ...inputs, $event: tx.dispatchedEventId ?? <random uuid> }
```

`inputs` is the handler node's bound closure. The receipt lives in the **pattern
result cell's space**, not necessarily the caller's, and is created with **no
scope argument**, so receipts are space-scoped today.

**`$event` is not the caller's id.** A caller-supplied id is bound to the stream
it was sent to before it becomes an event id: `scopeCallerEventId`
(`packages/runner/src/scheduler/event-identity.ts`) hashes
`{caller, id, path, space}` — the id string plus the stream link — into
`evt:caller:<hash>`, and `Cell.send` routes every supplied id through it. That
binding is deliberate: two verbs sharing input bindings must not collide on one
receipt. The hash is deterministic across processes, so a retry from a fresh CLI
invocation derives the same id — which is what makes any re-derivation scheme
possible at all.

Where no id is supplied, `mintEventId` produces
`evt:<per-transaction key>:<seq>:<stream link id>` or
`evt:<random uuid>:<stream link id>`. Both end in the stream link's id, and
neither is re-derivable.

Holding the address already, a caller needs nothing verb-aware: a receipt is a
cell and reading it is an ordinary read. Deriving the address without it is the
deferred case below.

Either way the reader loads the link through `runtime.getCellFromLink(link)` and
`pull()`, the same path `executeResolvedCallable` already uses. A raw storage
read would bypass the CFC checks attached to the stored result.

### Waiting, and detached calls

A detached caller knows the receipt address before the receipt exists, so the
reader **subscribes and wakes when it appears**; it must not poll
(AGENTS.md, "Avoid timeouts, retry loops, and sleeps";
[waiting-in-tests.md](../development/waiting-in-tests.md)). `--wait <seconds>`
bounds a caller's own patience, as on `cf piece call`.

`tx.handlingReceiptLink` is set during handling — before the commit, and only
when receipts are enabled — so `--no-wait` *can* return `receipt`; that is what
migration step 2 adds. Today its exit returns
`{invocation, status: "committed", deduplicated?}` and no receipt field. It also
returns the invocation id — minted or supplied — both on stdout and, once, on
stderr at the dispatch phase. So collect-later does **not** require supplying an
id. Supplying one buys something narrower: it is known *before* the call, so it
survives
losing the process's output entirely.

### Retry versus readback

| What the caller knows | Correct action |
| --- | --- |
| The invocation settled, and its receipt address was kept | Read that address — an ordinary read |
| Uncertain whether the commit happened, or whether the handler failed | Repeat `cf piece call` with the same `--invocation` id |
| Response lost, including the receipt address | Replay, or accept the loss — see the deferred section |
| No caller-chosen id retained | Recovery is not guaranteed |

An absent receipt cannot distinguish never-dispatched, not-yet-committed,
threw, expired, or wrong-handle. Under uncertainty only same-id replay safely
finishes the work.

### What a repeated read costs

Each `cf` invocation is a separate process with a **cold replica** —
`loadPieces` builds a `runtimePresets.remoteClient` runtime over a remote
`StorageManager`, and nothing persists between runs. Expect process start,
session setup, a connection, and a sync; the walkthrough's `--verbose` output
puts `initial_sync → dispatched` around 400ms against a warm local toolshed.

So: **ask broadly once.** One read returns the whole envelope. Repeated reads
are for questions you did not anticipate — recovery, detached collection, a
follow-up from another process — not a read-per-field idiom. A readback remains
far cheaper than the same-id replay it replaces, which pays all of the above
plus a handler execution and a refused commit.

## Errors and output conventions

These notes inherit `packages/cli/README.md` §"Output Conventions" rather than
restating them: **stdout carries command output only, with hints and diagnostics
on stderr**, and **`-q/--quiet` suppresses the hint and next-step blocks**
without touching the log floor, deliberately, because consumers parse `--quiet`
runs' stderr for runtime warnings.

stdout is always the Invocation JSON. Nothing narrows it to a bare value, so
no envelope field is ever displaced onto stderr and no rule is needed for
where it lands.

Advisory notices about what a read could not materialize belong to the read
layer and follow its conventions, not a call-specific rule.

Unchanged: the `invocation: <id>` line announced once on stderr at the dispatch
phase, so a caller whose process dies past that point still holds the id. Note
what that does and does not survive: dispatch comes after the initial sync, so
the id outlives a lost commit but not a sync that never completes.

### Exit status

Two call-specific cases. Failures inside a shaped read report under the read
layer's rules.

**`cf piece call` is unchanged.** A refused or failed call reports on stderr with
the existing `invocation: <id> phase: <phase>` line and exits non-zero. A settled
call exits zero.

**A read that finds no receipt says so, and no more.** The message is "no
receipt at this address" and must **not** claim the invocation never happened:
absence cannot distinguish collected, never-created, failed, and wrong-handle.

One property worth carrying into the read layer's design: a position that could
not be materialized should still yield its address rather than an error, so a
caller retains the part it can act on. Whether that degradation is uniform, and
what is named on stderr, is the read layer's call.

## Teaching `--piece` the entity URI

`--piece` gains the entity-URI form, so an address emitted by one command is
accepted by the next without reshaping. This is the one change here that reaches
beyond the CLI, and it is a bug fix rather than a new capability.

`isSlugAddress` is `!value.includes(":")`, so the input forms are unambiguous:

| Form | Example | `--piece` today | After | Denotes |
| --- | --- | --- | --- | --- |
| Slug | `my-board` | accepted | unchanged | a **stable name** that redirects; reassignable |
| Bare hash | `fid1:…` | accepted | unchanged | a hash — **not a complete identity** |
| Entity URI | `of:fid1:…` | **throws** | **accepted** | this entity, in its stored spelling |
| Kinded URI | `computed:fid1:…` | throws | **refused, by name** | a *different* entity from the `of:` one over the same hash |

**Why the prefixed form throws today.** `--piece` reaches `entityIdFrom` and
thence `FabricHash.fromString`, which splits on the first colon and
base64-decodes the rest — so `of:fid1:<b64>` parses as tag `of` with hash
`fid1:<b64>`, and the colon is not valid base64url. It surfaces as a decode
error, which is why it has never been reported as a missing feature.

**The change.** Accept an `of:` scheme at `entityIdFrom`
(`packages/runner/src/create-ref.ts`) and **refuse `computed:` rather than strip
it** — stripping would rename an id to its `of:` sibling, a different entity.
`pageIdForRouting` (`packages/runtime-client/backends/runtime-processor.ts`)
already implements exactly that shape; lift it rather than write a third copy.

Not one layer lower: `FabricHash.fromString` has non-entity users
(`packages/memory/fact.ts` parses a cause with it), and `of:` is a URI scheme,
not a hash tag. `entityIdFrom` is the entity-specific wrapper and the right seam.

**One fix reaches most callers.** The address-string paths that matter here go
through `entityIdFrom`: the CLI, the shell (`runtime-processor`, four call
sites), the background piece service, and slug resolution. That breadth is a
reason to make the change carefully, not a reason to avoid it — the alternative
is the CLI hand-stripping on its own, which is the eleventh copy of a conversion
that already exists ten times.

**Safety.** Additive: strings that threw now resolve, and nothing that already
worked changes spelling or meaning. Three things to verify rather than assume:

1. **`computed:` throws, not strips** — coercing renames an id to a different
   entity.
2. **String-keyed lookups get audited.** Once two spellings resolve, anything
   keying on the *raw input* has two keys per entity. The cell layer keys on the
   normalized URI and is fine; CLI-level raw-string comparisons are where to look.
3. **The existing workarounds stay correct**, since stripping `of:` from an
   already-bare id is a no-op.

**What stays out of scope.** Ten hand-rolled prefix conversions exist across
eleven files in five packages — `lib-shell`, `patterns` (three files, two in
user-space pattern code), `fuse`, `state-inspector` (two inside embedded browser
JS), and `runtime-client` (three) — running in **both** directions, with roughly
eight more hand-rolled sites outside those packages in `shell`, `toolshed`,
`memory`, and `runner`. Removing them is
follow-up cleanup on a separate review path, and nothing here depends on it.

**A bare hash is not a complete identity**, which is why the emitted form keeps
its scheme. An entity's kind lives only there and the hash preimage is kind-free
([computed-cell-identity.md](../specs/computed-cell-identity.md)), so stripping
to `fid1:<h>` discards the distinction and re-resolving silently defaults to the
`of:` sibling.

## Open questions

### Is the invocation id namespace per-user? — owner: Berni

**The finding: nothing in a receipt's address identifies the caller.** `inputs`
is graph structure, identical for every caller; scope is a symbolic tag, not a
user identifier; and the payload is excluded by design — which is what lets a
same-id retry replay instead of execute.

`$event` *is* namespaced, but not by principal: `scopeCallerEventId` hashes the
supplied id together with the stream link, so the same id sent to two different
verbs yields two receipts. What the hash does not contain is any identity — no
DID, no session — so two callers passing the same id to the same verb still
compute one address, and a guessed id still computes it from public inputs.

So an invocation id is a **read key shared per (space, verb binding)**, and it is
the read, not the write, that this breaks.

**Consequence 1: two callers sharing an id read one receipt.** Both resolve the
same address, both get the same bytes, and one is reading an answer to the
other's request. Nothing in the response says so, because the receipt records
what happened *under an id*, not *to a request*. It bites four ways: no caller
can verify a result is its own; the confusion propagates, since a caller holding
someone else's child address operates on that piece next; async reads strip the
last signal, because `deduplicated` belongs to an attempt and is not in the
receipt, so **a reader of receipts cannot diagnose it**; and retrying
replays the same outcome forever. Concurrency adds a secondary effect — both
handler bodies run, so effects outside the transaction happen twice.

**Consequence 2: a guessed id reads someone else's result.** Reconstruction turns
piece + verb + id into an address, bounded only by CFC labels and cell scope,
never by authorship.

The scope is a **session**, not a principal. A DID separates nothing: agents
work under their human user's key rather than mint their own, so the collision
that happens in practice is two agents under one key. A session distinguishes
them, and because it is minted rather than derived it is also unguessable —
which a DID is not, so identity scoping would have left an address computable
from a piece, a verb, and a conventional id.

Deliberate sharing then moves to passing the address rather than two callers
deriving one id from a convention. That is unambiguous, and it removes the only
thing the shared key was good for.

What is unresolved is the mechanism, not the direction. Neither session
identifier already in the tree serves: the storage session is minted per process
and re-minted on close, so scoping by it would break the same-id replay the id
exists for; `cf-harness`'s is durable but is harness state, and not every caller
is that harness. A new caller-supplied session identity is wanted — minted
explicitly, so a caller always knows which session an outcome belongs to —
along with a decision about what an absent one means.

Pre-existing (WS-D), but reading receipts deliberately makes it reachable. The exposure is entirely
in caller-chosen ids — and the human-friendly convention
[Verbs over the CLI](../common/verbs-over-the-cli.md) teaches (`add-comment-1`,
`add-1`) is what two agents following it derive *systematically*.

## Migration

**`result` changes shape** when the read layer lands, since a reference stops
arriving as its expanded value. Known consumers are
`packages/cli/integration/verbs-over-the-cli.sh` and the CLI tests, which assert
on expanded fields today and are updated in the same change. `--show-links`
becomes redundant once references render in band — it exists to annotate
identity back onto a payload that destroyed it — but retiring it is the read
layer's call, not this half's.

**The call-specific steps, each separately reviewable:**

1. **`--piece` accepts the entity URI** — the `entityIdFrom` change, refusing
   `computed:`. Independently testable: the same id works with and without its
   scheme. Everything that composes an emitted address into a following command
   waits on this.
2. **`receipt` as a top-level envelope field**, published from
   `tx.handlingReceiptLink` so a detached caller holds an address before the
   receipt exists.
3. **Receipt cells created with a schema**, so a shape over a receipt matches a
   declaration and can be pushed into the read.
4. **`piece call` gains the read options** — `--select`, `--schema`, `--filter`
   — by reusing the shared read implementation rather than growing a second
   output path.

Reading a receipt directly needs no step of its own: it is an ordinary cell
read, reachable once step 1 lands. Step 4 depends on the read layer having a
factored implementation to reuse; steps 1–3 do not. Recovering an outcome whose
address was lost is deliberately absent — see below.

## Recovering a lost outcome — deferred

**The problem.** A verb settled, and the caller no longer has its receipt
address — the process died, output was lost, or a detached dispatch was never
collected. The outcome exists and is durable, but nothing enumerates receipts,
so without the address it is unreachable.

**Why this is narrower than it sounds.** Three ways to want an outcome you do
not have, and only the third is unserved:

- *Dispatched detached.* `--no-wait` returns the invocation id on stderr before
  any network work, and once migration step 2 lands it returns the receipt
  address too. Keeping that address is the answer — but this bullet is
  conditional on step 2, not on today's behavior.
- *Lost the response, verb has no effects outside its transaction.* Replaying
  with the same invocation id returns the original outcome. The body re-runs and
  loses the create-only race, so the commit is refused and nothing is duplicated.
- *Lost the response, verb has effects outside its transaction.* Replay would
  re-send the mail or re-spend the model call. This is the case with no answer.

**Option A — derive the address in the client.** Rebuild the cause from piece,
verb, and a caller-chosen invocation id, per "How addresses are derived" above.
The cost is coupling: addressing must be byte-identical across replicas, and a
handler node's bound `inputs` are runner-internal, so the runner would have to
export something like `receiptLinkFor(streamCell, eventId)` purely to serve this.
Duplicating the cause-building in a client instead would create a two-place
invariant that silently breaks addressing when either side drifts.

**Option B — make replay safe instead.** If the harm is a re-executed effectful
body, the fix may belong in the runner rather than the client: the receipt cell
is minted unconditionally at the top of a dispatch, before any branching, so its
address is known before the body runs. Checking for an existing receipt there
would let a replay return the original outcome without re-executing — and would
cover shell clicks, background-service runs, and pattern-internal chains, not
only callers holding a terminal.

**Option C — keep the address.** Treat the receipt address as the thing worth
persisting, and make losing it the caller's problem to avoid. Costs nothing and
is what the detached path already assumes.

**When to revisit.** When a verb exists whose body has effects outside its
transaction *and* whose caller cannot retain the address. Until both hold,
Option C covers the ground and Option B is the better place to spend if the
first condition arrives on its own.

## Documentation owed

- [Verbs over the CLI](../common/verbs-over-the-cli.md) is **already stale**:
  its `plainResultReceipts` note describes a default that has since flipped
  (`packages/runner/src/runtime.ts` sets it `??= true`). It documents the
  `--show-links` shape, and its examples teach hand-written invocation ids —
  which the namespace question may make actively harmful advice.
- `packages/cli/README.md` §"Output Conventions" is the source these notes
  inherit their stdout/stderr rules from. It also carries the projection and
  filter contract the read layer extends.

## Deferred work

- **Batching.** The answer to O(N) fan-out — resolving many references in one
  request. A parent's **compact index** (one row per child carrying a reference
  plus summary fields, per the verb contract's Discovery section) already covers
  the designed case in one read, and composes well here: the row's reference
  renders as a `$link` while its summary fields render inline. Batching is for
  the ad-hoc and exploratory cases an index does not anticipate.
- **Collection windowing.** Carried by the read layer; see
  [Shaped reads and verb results](shaped-reads-and-verb-results.md).
- **A canonical locator** carrying host, space, id, scope and path in one string.
  This absorbs the question of whether `--piece` should accept a rendered
  address directly: a path-bearing one does not name a piece, so the locator is
  where that belongs rather than the `--piece` parser.
- **A local receipt cache.** `markCreateOnly` makes a receipt **write-once** and
  its address deterministic, so the *document* is safely cacheable. Its rendered
  value is not: the receipt holds links into live cells, so a materialized copy
  goes stale the moment a referenced child changes. Cache the links, never the
  materialization. Three further constraints decide it: identity-keyed (values
  inherit CFC labels), confidential at rest (the CLI persists nothing today),
  and it must not outlive server retention.
- **A retention policy** and the linked receipt collection that would make expiry
  distinguishable from error.
- **Removing the hand-rolled `of:` conversions** — a dozen in the packages
  inventoried above, plus more outside them.
- **Recovering an outcome whose address was lost** — discussed above, with its
  three options and the condition that would make it worth building.
