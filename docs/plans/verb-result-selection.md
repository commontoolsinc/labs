# Verb results: references, not expansions

This plan makes two things work from the CLI:

1. Call a verb that creates or returns a piece, then use that piece in the next
   command — without the response expanding to an unbounded document.
2. Re-read an earlier invocation's outcome without running the verb again.

The core change is one sentence: **a result renders references as references,
instead of expanding them into their values.** Everything else follows from it.

This continues the identity work from
[Pattern verb contract — implementation plan](pattern-verb-contract-implementation.md)
(WS-F), which shipped `--show-links` and left the selection interface open. The
user-facing surface it changes is
[Verbs over the CLI](../common/verbs-over-the-cli.md).

## Orientation

Skip this if you already work with patterns and the `cf` CLI.

| Term | What it is |
| --- | --- |
| **Pattern** | A user-authored program — a `.tsx` module, roughly a Solid.js component. Declares reactive state and, optionally, callables. |
| **Piece** | A *running instance* of a pattern, living in a space. The thing you address and call. |
| **Space** | A store identified by a DID. Every cell lives in exactly one space. |
| **Cell** | The reactive unit of storage. Its **backing document** is the storage record behind it. |
| **Link** | A pointer to a cell — `{ space, id, scope, path? }`. Identity, not value. |
| **Verb** | A piece's callable surface: a `Stream<Event, Result>` property in the pattern's output, invoked with `cf piece call`. |
| **Handler** (or `action`) | The function body that runs when a verb is invoked. |
| **Invocation** | One call to one verb. Its id is the idempotency key: replaying a settled id returns the original outcome instead of executing again. |
| **Receipt** | The durable cell the runtime writes when a handler dispatch settles. Carries the handler's return value, or `{}` when there is nothing to return. |
| **`of:`** | The URI scheme on an entity id (`of:fid1:<hash>`). The English preposition, from the memory protocol's fact record — `the` (type) / `of` (entity) / `is` (value) — so an entity id names the subject a fact is *of*. `of:` is the unkinded default. |
| **`computed:`** | The same slot, marking an entity whose contents are re-derivable. Not independently addressable. |

### What a verb looks like

```tsx
// Shown at module scope.

interface NoteOutput {
  title: string;
}

interface AddNoteEvent {
  title: string;
}

interface AddNoteResult {
  /** The note this call created — the piece itself, not a minted identifier. */
  note: NoteOutput;
}

// A verb is a `Stream` property on a pattern's output. Its result type is the
// second parameter; a verb that returns nothing stays `Stream<Event>`.
interface BoardOutput {
  addNote: Stream<AddNoteEvent, AddNoteResult>;
}

// `Note` is a pattern, so calling it produces a PIECE — a running instance with
// its own identity — rather than a plain object.
const Note = pattern<{ title: string }, NoteOutput>(({ title }) => ({ title }));

// The implementation of the verb `BoardOutput` declares above. `action` takes
// the SAME two type parameters as the `Stream` — event in, result out — and the
// body must return that result type. `Stream<E, R>` and `Stream<E>` are
// deliberately not interchangeable, so a declared result cannot be dropped
// silently on assignment.
//
// A real pattern creates this inside `pattern(…)` and returns it as `addNote`,
// alongside the state it mutates; it is standalone here to keep the example to
// the parts this plan is about.
export const addNote = action<AddNoteEvent, AddNoteResult>(({ title }) => {
  const note = Note({ title });
  // Return the piece itself. Patterns return references; rendering identity as
  // an address is the client's job.
  return { note };
});
```

`return { note }` hands back **the piece**, not an identifier for it. Patterns
deliberately never mint id fields — a pattern-authored id is a copy of runtime
state that can go stale.

## The problem

**Expansion destroys identity and bounds nothing.** Today the CLI reads a
result by materializing it, so `{ note }` comes back as the note's full value:

```json
{ "invocation": "0f4c…", "status": "settled",
  "result": { "note": { "title": "Notes", "…": "…" } } }
```

The address is gone — you cannot call a verb on that note — and the payload
grows with the transitive closure of everything the result references. The same
shape produced over 300k tokens when a headless caller reads a board through
`topics.crossrefs` ([pattern-verb-contract.md](pattern-verb-contract.md),
"Discovery"). Recovering the address then took a side-car annotation plus two
tools; step 5 of `packages/cli/integration/verbs-over-the-cli.sh`:

```bash
NOTE_ID=$(echo "$LINKED" | jq -r '.links["/note"].id // empty' | sed 's/^of://')
```

**And there is no durable readback.** The result exists in the invocation
receipt, but the only way to re-read it is to re-invoke with the same id — which
returns the original outcome, but re-runs the handler body, so effects outside
the transaction repeat.

## Goals and non-goals

1. One call returns every value the verb produced **and** identity for
   everything it referenced, bounded by the result's own declared shape.
2. A returned child's address composes into the next `cf piece call --piece`.
3. A settled outcome can be re-read without re-executing the verb.
4. A lost response can be recovered, given the piece, the verb, and an
   invocation id the caller chose in advance.
5. Callers depend on a **declared** output shape, not on the runtime's internal
   encoding, which is mid-migration.

Non-goals: server-side filtering, selection languages, projection flags,
changes to what patterns return, invocation listing, and batching (see Deferred
work — it is the answer to O(N) fan-out, and it is not this plan).

## Decision summary

| What you want | How |
| --- | --- |
| A child's address, to call it next | It is in the result, at its natural path |
| The values the verb computed | Also in the result, inline |
| A specific field | `jq` — the result is a normal JSON document |
| The content behind a reference | A second call against that address, or `--depth` |
| A settled outcome, again | `cf invocation get <handle>` |
| An outcome whose response was lost | `cf invocation get --piece --verb --invocation` |
| Certainty about an uncertain commit | Same-id `cf piece call` replay — not a readback |

There are **no selection flags**, and none are needed: with identity in-band,
`jq` reaches it like any other field. `--show-links` exists today only because
expansion destroyed the identity it annotates back on; it goes away with the
expansion.

## The result contract

### References render as references

A reference in a result renders as a `$link` node rather than its value:

```json
{
  "invocation": "create-note-7",
  "status": "settled",
  "receipt": { "$link": { "id": "of:fid1:…", "space": "did:key:…", "scope": "space", "path": [] } },
  "result": {
    "note": { "$link": { "id": "of:fid1:…", "space": "did:key:…", "scope": "space", "path": [] } },
    "writtenAt": "2026-08-04T…"
  }
}
```

`writtenAt` is inline because the handler computed it. `note` is a link because
it is a separate entity with its own identity. **Both of the verb contract's
stated payoffs — the address of a created child, and fields only the handler
could produce — arrive in one round trip.** What defers is content belonging to
a different document.

### Except where a reference is useless to the caller

**Expand what the caller cannot address; link what they can.**

A `computed:` reference is not usefully addressable, and the reason is sharper
than it first looks. A node the classifier marks `kind: "computed"` gets **two
binds over the same hash preimage**, differing only by scheme: a *value bind* at
`computed:fid1:<h>`, where the child's value actually lives, and an *identity
bind* at `of:fid1:<h>`, which the runner uses "purely as the `resultFor` CAUSE —
a stable coordinate, never read for a value." The runner states the consequence
outright: **reading the `of:` one returns `undefined` for a healthy piece**
(`instantiatePatternNode`, `packages/runner/src/runner.ts`).

So handing a caller a `computed:` link hands them something `--piece` cannot
take, and handing them its `of:` sibling hands them an address that reads empty.
There is no third option. Computed references therefore **expand** — they are
part of the value, not a boundary in it.

An `of:` entity that is not one of those coordinate siblings is stable and
independently identified, so a link suffices.

This also gives the scheme-stripping hazard a concrete symptom: normalizing
`computed:fid1:<h>` to `of:fid1:<h>` does not fail loudly — it silently
addresses the coordinate and reads `undefined`.

**Which nodes get a computed kind is the classifier's call.** It is a property of
the node, decided per instantiation, and not something a caller — or this CLI —
can predict from the shape of the pattern that produced it. The rendering rule
therefore keys on the **scheme it observes** in the link, which is the only
thing it needs and the only thing it can rely on.

**Where the decision is made.** Not in the selector — `SchemaPathSelector` is
`{ path, schema }` and nothing more, the schema is content-hashed and shipped
through a schema-ref table, and `traverse.ts` never imports `entity-kind.ts`. A
declarative kind gate would be a wire change across api → traverse →
schema-hash → memory-v2 → server.

It is made in **CLI code instead**, where the information is plainly available:
read shallow, `getRaw()`, and inspect each parsed link's `id` — the scheme is
right there. Expand only the `computed:` ones, with one more shallow sync each.

If a declarative gate is ever wanted, there is a precedent to copy rather than
invent: `canFollowScopedLink` (`traverse.ts` / `scope.ts`) already refuses a
follow based on a property of the *target* rather than the shape at the
position. A kind gate would sit in the same place and read the same object.

### Depth, for when you want content

`--depth N` follows up to N **`of:` hops**. Computed links are transparent and
do not count — they are not boundaries.

**Default 0**, on an asymmetry: depth 0 is bounded by the result's own shape,
which the pattern author declared and published. Depth ≥ 1 is bounded by data
the author never declared, and a single child can be arbitrarily large. At 0 you
can always ask for more; a depth-1 default has already spent the payload before
you can decline it.

Depth counts *reference hops*, not JSON nesting — plain nested objects cost
nothing. It is per-call, not per-path; per-path would be a selection language.

**Depth 0 needs no runtime change.** The shallow fetch already exists — a
schema-less `sync()` is the rejecting selector, and `getRawUntyped`
(`cell.ts`) resolves links without entering `SchemaObjectTraverser`, so it
cannot pull a child. Depth 0 is therefore *stop materializing*, not *change the
fetch*: sync the receipt, read `getRaw()`, render the stored links.
`followPointer`'s own comment states the property being relied on — "a
rejecting-selector sync delivers only the root doc, so a link can point at a doc
no selector ever walked."

Each hop above 0, and each `computed:` expansion, is one more shallow sync
issued from CLI code, where the target's scheme is visible on the parsed link.

### Fan-out must be bounded and asked for

Hidden N+1 traversal makes cost unpredictable. The rule is that a command's
network work is **bounded and proportional to what the caller asked for** — not
that it is always exactly one request.

That distinction matters because **today's read already fans out, invisibly.**
The sync is shallow: `StorageManager.syncCell` sends `schema: schema ?? false`
(`storage/v2.ts`), and `schema: false` is `REJECTING_SELECTOR` — a traverser
built with it follows no references. The expansion comes *afterwards*, from
`.get()` / `.pull()`: a schema-less cell resolves to a `true` schema, the client
walks the value, and every absent target hits `reportMissingLinkTarget`
(`traverse.ts`) → `Runtime.ensureLinkedDocLoaded`, which **kicks a fresh sync
per missing document** and re-runs the reader on arrival.

So the status quo is one sync per referenced document, unbounded by the result's
shape. This plan replaces that with one shallow read plus, at most, one hop per
`computed:` reference — bounded by the pattern's own derived graph and by a
depth the caller names. It reduces fan-out rather than introducing it.

## The `$link` shape

Wherever CLI output carries a reference, it emits one **declared** shape rather
than the runtime's internal encoding, which is dispatched on `modernCellRep`
and mid-migration (`cell-rep.ts`: legacy `{ "/": { "link@1": … } }` versus a
modern `FabricLink`). Owning a shape is not optional — the moment callers are
told to `jq` a result, *some* shape becomes a public contract. The only choice
is whether it is one we declared or one that leaked.

Spelling follows `state-inspector`'s `annotate()`, which already projects stored
values to `{ $link }` / `{ $ref }` / `"$stream"` for the same reason.

| Field | Default | Why |
| --- | --- | --- |
| `id` | always, **scheme included** | The scheme is part of the identity: `of:` and `computed:` over one hash are different entities. Dropping it is a silent retarget |
| `space` | always, **filled in** | Measured: the runtime does not always emit it — present on some links, absent on others — so a consumer cannot rely on it. Filling it means no `// "…"` fallbacks in jq, and a link stays meaningful when copied out of context |
| `scope` | always, defaulting `"space"` | `toInvocationResultLink` already does this. Absence silently meaning `"space"` is a trap |
| `path` | always, `[]` when empty | Uniformity: one shape, no optional-key branching |
| `overwrite` | **dropped** | A runtime write-redirect marker with no caller meaning. Measured present on every observed link |
| `schema` | `true`, **never inlined** | Measured: a cell link can carry a full JSON Schema with `$defs`. Inlining would make a bounded result unbounded — the defect this plan exists to fix |

Every optional field becomes required with a filled default. That costs a few
bytes and buys a shape callers index without defensive branching.

The same discipline applies one level up, to the envelope around the result.
`deduplicated` is the exception that proves it: it is optional and **only ever
appears as `true`**, because `invocationJson`
(`packages/cli/commands/piece.ts`) spreads
`...(outcome.deduplicated ? { deduplicated: true } : {})`, so the key's absence
*is* the false case. That is an existing contract this plan does not change —
but never emit `"deduplicated": false`, which no code path produces and which a
caller branching on key presence would misread.

**`cf inspect` remains the route to the raw stored form.** This plan adds no
`--raw`: a second output contract would undo the stability the first one exists
to provide, and `cf inspect` already owns "what is actually stored."

## What using it looks like

Create a note and address it, with no side-car annotation and no `sed`:

```bash
R=$(cf piece call --piece "$BOARD" createNote '{"title":"Notes"}')

# The address is in the result, at its natural path. Note the bracket form:
# `$` is a variable sigil in jq, so `.result.note.$link` is a syntax error.
NOTE=$(echo "$R" | jq -r '.result.note["$link"].id')

cf piece call --piece "$NOTE" append '{"text":"second line"}'
```

Fields the handler computed need no second call — they were never behind a
reference:

```bash
echo "$R" | jq -r '.result.writtenAt'
```

Ask for the note's *contents* in the same call instead of following the link:

```bash
cf piece call --depth 1 --piece "$BOARD" createNote '{"title":"Notes"}'
```

Re-read that invocation later, without running the verb again:

```bash
cf invocation get "$(echo "$R" | jq -r '.receipt["$link"].id')"
```

Or, having dispatched detached and lost the response — recovering from the id
you chose:

```bash
cf piece call --no-wait --invocation my-id-7 --piece "$BOARD" createNote '{"title":"Notes"}'
cf invocation get --piece "$BOARD" --verb createNote --invocation my-id-7 --await
```

## Reading a receipt

### What produces one

Only JavaScript handler dispatches.
`handleJavaScriptHandlerResult` (`packages/runner/src/runner.ts`) mints the
receipt cell **unconditionally at its top**, before any branching, and all three
downstream sub-paths share that one cell: the receipt-only branch writes it, the
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
`id = args.eventId ?? mintEventId(eventLink, originTx)`. So the unit read here
is **a handler dispatch someone can name** — which is why it earns a top-level
noun rather than living under `cf piece`.

**Why `cf invocation`, not `cf receipt`.** CFC single-use grants write a
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

The reconstruction handle (step 4) must reproduce this exactly.

```text
receipt address = getCell(patternResultCell.space, { resultFor: cause })
cause           = { ...inputs, $event: tx.dispatchedEventId }
```

`inputs` is the handler node's bound closure. The receipt lives in the **pattern
result cell's space**, not necessarily the caller's, and is created with **no
scope argument**, so receipts are space-scoped today.

Two handles:

1. **Direct:** `cf invocation get <receipt-id>`, taking `--space`, `--identity`
   and the other addressing options as `--piece` does. It accepts exactly what
   the `receipt` field's `$link.id` emits, prefix included — and needs no dependency on the
   `entityIdFrom` fix, because the reader builds a link and loads it via
   `getCellFromLink`, whose `toURI` returns an already-schemed URI verbatim.
   **Do not route the receipt handle through `entityIdFrom` for symmetry with
   `--piece`; that imports the bug.** Slugs do not apply — a receipt is not a
   piece.
2. **Reconstruction:** `cf invocation get --piece <p> --verb <v> --invocation
   <id>`. Required, not convenient: goal 4 cannot use form 1, because the
   address came back only in the response that was lost. This form inherits
   `--piece`'s address forms, slugs included.

**The highest-risk item in this plan:** the CLI must not duplicate the runner's
cause-building logic. Byte-identical addressing is required across replicas, and
reaching the handler node's `inputs` from a stream cell is runner-internal. The
runner should export `receiptLinkFor(streamCell, eventId) ->
NormalizedFullLink | undefined`.

The reader loads that link through `runtime.getCellFromLink(link)` and `pull()`,
the same path `executeResolvedCallable` already uses. A raw storage read would
bypass the CFC checks attached to the stored result.

### Waiting, and detached calls

A detached caller knows the receipt address before the receipt exists, so the
reader **subscribes and wakes when it appears**; it must not poll
(AGENTS.md, "Avoid timeouts, retry loops, and sleeps";
[waiting-in-tests.md](../development/waiting-in-tests.md)). `--wait <seconds>`
bounds a caller's own patience, as on `cf piece call`.

`tx.handlingReceiptLink` is published at commit time, so `--no-wait` returns
`receipt` in its response. It also returns the invocation id — minted or
supplied — both on stdout and, once, on stderr at the dispatch phase before any
network work. So collect-later does **not** require supplying an id. Supplying
one buys something narrower: it is known *before* the call, so it survives
losing the process's output entirely.

### Retry versus readback

| What the caller knows | Correct action |
| --- | --- |
| The invocation committed or settled | `cf invocation get` |
| Uncertain whether the commit happened, or whether the handler failed | Repeat `cf piece call` with the same `--invocation` id |
| Response lost; piece, verb and caller-chosen id retained | Reconstructed `cf invocation get` |
| No caller-chosen id retained | Recovery is not guaranteed |

An absent receipt cannot distinguish never-dispatched, not-yet-committed,
threw, expired, or wrong-handle. Under uncertainty only same-id replay safely
finishes the work.

### What a repeated read costs

Each `cf` invocation is a separate process with a **cold replica** —
`loadManager` builds a `runtimePresets.remoteClient` runtime over a remote
`StorageManager`, and nothing persists between runs. Expect process start,
session setup, a connection, and a sync; the walkthrough's `--verbose` output
puts `initial_sync → dispatched` around 400ms against a warm local toolshed.

So: **ask broadly once.** One read returns the whole envelope. Repeated reads
are for questions you did not anticipate — recovery, detached collection, a
follow-up from another process — not a read-per-field idiom. A readback remains
far cheaper than the same-id replay it replaces, which pays all of the above
plus a handler execution and a refused commit.

## Errors and output conventions

This plan inherits `packages/cli/README.md` §"Output Conventions" rather than
restating them: **stdout carries command output only, with hints and diagnostics
on stderr**, and **`-q/--quiet` suppresses the hint and next-step blocks**
without touching the log floor, deliberately, because consumers parse `--quiet`
runs' stderr for runtime warnings.

stdout is always the Invocation JSON. Nothing narrows it to a bare value, so
no envelope field is ever displaced onto stderr and no rule is needed for
where it lands.

What this plan *adds* to stderr is one thing: the list of paths that could not be
expanded for a reason other than depth (below). That is advice about what you did
not get, and stdout already carries the honest answer in the form of a `$link`,
so **`--quiet` suppresses it** — the same test `resultRef` applies, where a value
is advisory until the protocol carries it on stdout.

Unchanged: the `invocation: <id>` line announced once on stderr at dispatch,
before any network work, so a caller whose process dies still holds the id.

### Exit status

Removing the selection flags removed most of the error surface with them —
there is no longer a "settled but the selection matched nothing" state, because
there is no selection. What remains is three cases.

**`cf piece call` is unchanged.** A refused or failed call reports on stderr with
the existing `invocation: <id> phase: <phase>` line and exits non-zero. A settled
call exits zero.

**`cf invocation get` reports the read.** Zero when it found the receipt,
non-zero when it did not — it is read-only, so there is no duplicate-write
hazard in saying so. The message is "no receipt at this address" and must **not**
claim the invocation never happened: absence cannot distinguish collected,
never-created, failed, and wrong-handle.

**An unfollowable hop degrades to a link, except when it cannot.** A `$link` at
a position means "not expanded here" — uniformly, whether depth ran out, the kind
rule kept it, or a hop failed to read. That uniformity is deliberate: no marker
field, no shape variance, and the caller still gets the address, which is the
part it can act on. Paths that failed *for a reason other than depth* are named
on stderr, since depth running out is expected and an unreadable target is not.

The exception is a **`computed:` expansion that fails**. There the caller is left
holding a link it cannot address and cannot read, with no recourse — so that one
fails loudly rather than degrading silently.

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

**One fix reaches everyone.** Every path turning an address string into a cell
goes through `entityIdFrom`: the CLI, the shell (`runtime-processor`, four call
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
nine files in five packages — `lib-shell`, `patterns` (three files, two in
user-space pattern code), `fuse`, `state-inspector` (two inside embedded browser
JS), and `runtime-client` — running in **both** directions. Removing them is
follow-up cleanup on a separate review path, and nothing here depends on it.

**A bare hash is not a complete identity**, which is why the emitted form keeps
its scheme. An entity's kind lives only there and the hash preimage is kind-free
([computed-cell-identity.md](../specs/computed-cell-identity.md)), so stripping
to `fid1:<h>` discards the distinction and re-resolving silently defaults to the
`of:` sibling.

## Other constraints

**No result schema is emitted.** `Stream<Event, Result>` carries a real
TypeScript result type, but the generator prepends `asCell: ["stream"]` to the
inner schema
([ts_to_json_schema_mapping.md](../specs/schema-generator/ts_to_json_schema_mapping.md)
§6.2) and that inner schema is the **event's** (§6.5), so the result type has
nowhere to go. Emission (C3) was built, proven, and withdrawn before merge
because the coming Fabric-types stream evolution is expected to replace the
shape. Two costs are inherited: result shapes have no update-gate protection,
and a caller cannot discover a result's shape before calling. It is also why
schema-driven narrowing of the *fetch* is not straightforwardly available.

**Receipts have no retention bound.** Permanent and unlinked today — which
[pattern-verb-contract.md](pattern-verb-contract.md) names as a defect in
waiting: "deterministic addressing without linkage is how storage becomes
permanent and invisible at once." This plan creates the first dependency on
reading them later, so it owns two things: state the window honestly as
unbounded, and **fail legibly on absence** — "no receipt at this address", never
a claim the invocation never happened, because absence cannot distinguish
collected, never-created, failed, or wrong-handle.

## Open questions

### Traversal mechanics — answered, pending owner confirmation

Investigated against the code; **not yet confirmed by the `traverse.ts` owner**,
so treat as strong rather than final.

**A shallow read exists, and we already use it.** `StorageManager.syncCell`
sends `schema: schema ?? false`, and `schema: false` is `REJECTING_SELECTOR`
(`packages/data-model/src/schema-utils.ts`) — a traverser built with it follows
no references. Combined with `getRawUntyped`, which never enters
`SchemaObjectTraverser`, that is the whole depth-0 mechanism, with three in-tree
precedents (ACL bootstrap, the sync path, conflict-retry doc pull). Note
`READ_NON_RECURSIVE_FOR_SCHEDULING` is *not* it — that governs conflict and
invalidation granularity, not link following.

**Bandwidth is genuinely bounded**, so the strong claim is available. One
caveat: the **meta closure** still travels — cfc / result / pattern / argument /
internal docs via `loadMetaLinkedDocs`, each tracked with the rejecting
selector. Bounded, but not zero.

**`asCell` is the wrong lever, and would have burned us.** `traverseCells` is
`context.includeMeta`; the server passes `true` and the client `false`, and
`traversePointerWithSchema` guards its `asCell` early-return behind
`!this.traverseCells` — with a comment saying so outright: "For the memory
system, where we do traverse cells, we will still walk into these objects
regardless of the schema flag." So `asCell` narrows only what the *client*
materializes; the server sends the closure anyway. This also explains why the
spike's hand-written `asCell` schemas returned `undefined` — wrong lever, not
wrong syntax.

**Kind-conditional traversal is not expressible declaratively**, but is
expressible in CLI code — see "Except where a reference is useless to the
caller".

**What still needs the owner's eye:** whether the meta closure is large enough
in practice to weaken the bounded claim, and whether a declarative kind gate
alongside `canFollowScopedLink` is worth the wire change later.

### Is the invocation id namespace per-user? — owner: Berni

**The finding: nothing in a receipt's address identifies the caller.** `inputs`
is graph structure, identical for every caller; `$event` is the caller's string
verbatim (`resolveInvocationId` applies no namespacing); scope is a symbolic tag,
not a user identifier; and the payload is excluded by design — which is what lets
a same-id retry replay instead of execute.

So an invocation id is a **read key shared per (space, verb binding)**, and it is
the read, not the write, that this breaks.

**Consequence 1: two callers sharing an id read one receipt.** Both resolve the
same address, both get the same bytes, and one is reading an answer to the
other's request. Nothing in the response says so, because the receipt records
what happened *under an id*, not *to a request*. It bites four ways: no caller
can verify a result is its own; the confusion propagates, since a caller holding
someone else's child address operates on that piece next; async reads strip the
last signal, because `deduplicated` belongs to an attempt and is not in the
receipt, so **the reader this plan adds cannot diagnose it**; and retrying
replays the same outcome forever. Concurrency adds a secondary effect — both
handler bodies run, so effects outside the transaction happen twice.

**Consequence 2: a guessed id reads someone else's result.** Reconstruction turns
piece + verb + id into an address, bounded only by CFC labels and cell scope,
never by authorship.

| Option | Effect | Cost |
| --- | --- | --- |
| Document the shared read key; require collision-resistant ids | Cheapest | Relies on compliance; guessed-id reads remain |
| Namespace the event id by caller DID | Makes the read key per-caller | Changes dedup semantics; breaks deliberate cross-agent id sharing |
| Keep the shared key, stop treating unguessability as privacy | Honest about what the address proves | Needs explicit authorization on receipt reads; does not address aliasing |

Pre-existing (WS-D), but this plan makes it reachable. The exposure is entirely
in caller-chosen ids — and the human-friendly ones current documentation teaches
(`add-comment-1`, `create-note-7`) are what two agents following one convention
derive *systematically*.

### Confirm the `$link` defaults — proposed above

The table in "The `$link` shape" is a proposal. Confirm or amend before
implementation: this is the surface that absorbs the `modernCellRep` migration
on callers' behalf, and changing it later is the breakage it exists to prevent.

**The key name deserves a second look.** `$link` matches `$stream` and `$NAME`,
and the `$` guards against a pattern author having a field literally called
`link`. But it costs jq ergonomics on the exact path this design optimizes for:
`$` is a variable sigil in jq, so every expression needs the bracket form —
`.result.note["$link"].id`, never `.result.note.$link.id`, which is a syntax
error. A bare `link` would read better and collide worse. Worth deciding
deliberately, since ergonomics was part of the argument for declaring a shape at
all.

### Should `--piece` accept a `$link`? — leave open

It would close most of the canonical-locator gap, since `$link` carries
everything but host. Two things stop it here: a path-bearing `$link` still does
not name a piece, and JSON as a shell argument quotes badly. Nothing is blocked
meanwhile — same-space composition is `jq -r '…["$link"].id'`, cross-space adds
`--space`.

## Migration

**`result` changes shape.** This is the breaking part, and it is deliberate: a
mode would leave the unbounded default reachable, which is the defect. Known
consumers are `packages/cli/integration/verbs-over-the-cli.sh` and the CLI
tests; both are updated in the same change. Any external script reading
`result.<ref>.<field>` gets a `$link` instead and must either use `--depth 1` or
follow the address.

**`--show-links` is deleted.** With identity in-band it has no job. It has no
consumers outside the walkthrough and CLI tests.

**Sequenced so each step is separately reviewable:**

1. **`$link` rendering and the shape** — the projection, its defaults, and the
   receipt as a top-level field.
2. **`--piece` accepts the entity URI** — the `entityIdFrom` change, refusing
   `computed:`. Lands before step 3 because step 3's acceptance test is
   `cf piece call --piece "$(… | jq -r '.result.note["$link"].id')"`, which
   cannot pass until `--piece` takes the emitted form. Independently testable:
   the same id works with and without its scheme.
3. **Reference rendering** — stop expanding `of:` references; expand
   `computed:`. Mechanically this is *stop materializing*: read the receipt
   through the shallow path and render `getRaw()`, then follow only computed
   links. `collectInvocationResultLinks` (`packages/cli/lib/callable.ts`) is
   worth reusing here — it already walks a result and produces exactly this
   identity map, but today it walks the *already-materialized* value, so it adds
   identity **on top of** the payload. Rebuilding that walk on the shallow read
   is what converts it from an annotation into a bound. Replacing the
   walkthrough's `jq | sed` with a `$link` read is the acceptance test.
4. **`--depth`** — the follow mechanism.
5. **`cf invocation get`** — direct handle, then reconstruction with the
   runner-exported `receiptLinkFor`.

Step 3 is where the wire contract changes, so it is the one to land alone. The
receipt reader does not depend on step 2: it loads through `getCellFromLink`,
not `entityIdFrom`, so the prefixed form already works there.

## Documentation this plan owes

- [Verbs over the CLI](../common/verbs-over-the-cli.md) is **already stale**:
  its `plainResultReceipts` note describes a default that has since flipped
  (`packages/runner/src/runtime.ts` sets it `??= true`). It documents the
  `--show-links` shape, and its examples teach hand-written invocation ids —
  which the namespace question may make actively harmful advice.
- `packages/cli/README.md` §"Output Conventions" is the source this plan
  inherits its stdout/stderr rules from; it gains the `$link` contract.

## Deferred work

- **Batching.** The answer to O(N) fan-out — resolving many references in one
  request. A parent's **compact index** (one row per child carrying a reference
  plus summary fields, per the verb contract's Discovery section) already covers
  the designed case in one read, and composes well here: the row's reference
  renders as a `$link` while its summary fields render inline. Batching is for
  the ad-hoc and exploratory cases an index does not anticipate.
- **A canonical locator** carrying host, space, id, scope and path in one string.
- **A local receipt cache.** Receipts are unusually good targets: `markCreateOnly`
  makes them **write-once**, so a cached copy cannot go stale, and addressing is
  deterministic. Three constraints decide it: identity-keyed (values inherit CFC
  labels), confidential at rest (the CLI persists nothing today), and it must not
  outlive server retention.
- **A retention policy** and the linked receipt collection that would make expiry
  distinguishable from error.
- **Removing the ten hand-rolled `of:` conversions.**

## Why the main alternatives were rejected

| Alternative | Why not |
| --- | --- |
| Keep expanding, add a side-car links map | Discovery costs the full payload, identity and value live in parallel structures, and the map is flag-gated — so callers need foresight to keep a handle |
| Add flags that select a link or an id out of the result | Unnecessary once identity is in-band; `jq` reaches it like any other field, and a flag would freeze one access pattern into the CLI |
| Value projection (`--schema`, `--filter`) | Same reason — and there is no result schema for a caller to discover what to select |
| Depth-limit expanded values instead of linking | Fidelity would depend on nesting depth, and identity would still be lost |
| Handle-then-poke, a round trip per field | Untenable when each read is a process plus round trip |
| Inline `@ID` annotation beside values | Cannot annotate a scalar, which can be its own document — the case where results are simplest. Replacing the node with a link is uniform |
| Have patterns mint id fields | A pattern-authored fid is derived from runtime-only surface, reads `""` while unresolved, and goes stale |
| Emit the raw runtime link encoding | It is dispatched on `modernCellRep` and mid-migration; exporting it makes every script a casualty of the flip |
| Use an `asCell`-bearing read schema to bound the fetch | `asCell` is a *client materialization* boundary, not a fetch boundary — `traversePointerWithSchema` skips its early-return when `traverseCells` is set, which is exactly the server's configuration. The fetch boundary is the selector's schema |
| A `--raw` escape hatch | A second output contract undoes the first one's stability; `cf inspect` owns the stored form |
| Derive receipt addresses in the CLI | Byte-identical addressing would become a hand-maintained two-place invariant |
| Address receipts by invocation id alone | The cause includes the handler's bound closure |
| Put readback under `cf piece` | Any named handler dispatch has a receipt, not only CLI piece calls |
| Name it `cf receipt` | CFC already has a different consumption-receipt concept |
