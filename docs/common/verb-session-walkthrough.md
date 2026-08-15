# A verb session, end to end

What driving a pattern entirely through `cf` looks like when the verb surface is
complete: discovery, help, completion, and carrying an address from one call
into the next.

[Verbs over the CLI](verbs-over-the-cli.md) explains what a verb hands back.
This walks a whole session using it, and marks where the surface is still
incomplete.

The subject is a work-item tracker — items in a tree, plus typed cross-links.
It is a real pattern: `packages/cli/integration/pattern/tracker.tsx`, which
belongs to this document and the two scripts beside it, so a change to a
pattern the product ships can never break a demonstration of the verb surface.
Every measurement below was taken against it on a local toolshed.

**Every step is marked for what is real.** The point of the document is the
line between them.

| Mark | Meaning |
| --- | --- |
| **[today]** | works against a current build |
| **[blocked]** | needs something decided or built |

The read layer this document was drafted against has since landed in full: the
concise `--select` spelling, the `@` address suffix, and their arrival on
`piece call` all work today, so no step here is merely pending.

Section headers inside the help output below are the literal strings
`renderPieceCallHelp` emits (`packages/cli/lib/exec-schema.ts`). Their contents
are illustrative.

## Why this pattern

A fixture exists to be driven, and this one is shaped so that driving it is hard
in the particular ways the verb surface has to be good at.

**A tree with cross-links.** An item is filed under one item and can be waited
on by any other, so the same item is reachable by two different paths. That is
where an address stops being a convenience: handing a caller the item's contents
twice says nothing about whether they are looking at one item or two, and only
an address answers it.

**State a caller cannot set.** `title` is the only field supplied at creation.
`status`, `notes`, `children` and `blockedOn` belong to the pattern and change
only when a verb is called, which is what makes the verb surface the whole
interface rather than a convenience laid over a writable document.

**Six verbs, five shapes.** They are not six features. Each shape is a
different question a caller asks about what comes back, and the tracker carries
every one of them so that none goes undemonstrated. Only the first shape has two
verbs, and they differ in nothing but what the new item is filed under:

| Verb | The shape it exercises | Where |
| --- | --- | --- |
| `addItem`, `addChild` | returns a piece — an address the next command takes as its target, and a value that can be reached from inside itself | acts 4 and 8 |
| `recordNote` | returns what only the pattern could compute: the clock is a handler capability, so the stamp cannot come from the caller | act 7 |
| `finish` | returns a derived fact — `openBelow` takes a walk of the whole subtree, which a caller would pay N reads for | act 8 |
| `archive` | declares no result: the invocation settles carrying no `result` at all, and what it changed is a separate read | act 9 |
| `blockOn` | takes an address as an **argument** rather than as the receiver | act 10, **[blocked]** |

Those act numbers are `packages/cli/integration/verb-session-demo.sh`, which
drives the session and prints each command before running it — the transcript is
what that script is for. Beside it,
`packages/cli/integration/verb-session-gaps.sh` asserts the same surface as
pass/fail, and several of its steps assert that something does *not* work yet,
failing loudly the day it does. A verb added to the fixture wants a row above, an
act in the demo, and a step in the harness; a shape demonstrated in none of the
three is a claim this document is making alone.

## What you are driving

Two patterns. A **board** holds root items; an **item** holds its own subtree,
its own graph edges, and its own verbs — so the thing a create hands back is
itself callable, with no separate lookup.

```tsx
// Shown for illustration only.

/** What a caller supplies at creation. Everything else the board derives. */
interface BoardInput {
  items?: ItemOutput[];
}

/** The board holds ROOT items only. Everything deeper is reached through an
 *  item's `children`. */
interface BoardOutput {
  items: ItemOutput[];
  /** File a new root item on the board. */
  addItem: Stream<AddItemEvent, AddItemResult>;
}

/** A verb's event and result are named interfaces, not inline shapes, so each
 *  parameter has somewhere to be documented. This is the only pair spelled out
 *  here; the rest follow it. */
interface AddItemEvent {
  /** One line naming the work. */
  title: string;
}

interface AddItemResult {
  /** The root item this call created. */
  item: ItemOutput;
}

/** What a caller supplies. `status`, `notes`, `children` and `blockedOn` are
 *  the pattern's own state, not inputs — a caller changes them through verbs. */
interface ItemInput {
  title: string;
  parent?: ItemOutput | null;
}

/** One work item: what it holds, and what it can do. */
interface ItemOutput {
  title: string;
  /** "open" until a verb changes it — "done" or "archived". */
  status: string;
  /** Append-only. Each entry carries a time the pattern stamped, not the
   *  caller: reading the clock is a handler capability. */
  notes: { body: string; at: number }[];
  /** Null at a root. Carried so a caller can walk up as well as down. */
  parent: ItemOutput | null;
  /** The tree. */
  children: ItemOutput[];
  /** The graph. A blocker is any item anywhere on the board, not a
   *  descendant — which is what makes one item reachable by two paths. */
  blockedOn: ItemOutput[];

  /** File a new item beneath this one. */
  addChild: Stream<AddChildEvent, AddChildResult>;
  /** Append a progress note. Notes are append-only; nothing rewrites one. */
  recordNote: Stream<RecordNoteEvent, RecordNoteResult>;
  /** Mark this item done. Descendants are left alone — finishing a parent says
   *  nothing about its children, which is what `openBelow` reports. */
  finish: Stream<FinishEvent, FinishResult>;
  /** Record that this item waits on another. The blocker may be anywhere on
   *  the board — this is the edge that makes the tree a graph. */
  blockOn: Stream<BlockOnEvent, BlockOnResult>;
  /** Mark this item archived. Declares no result — the value-less shape. */
  archive: Stream<void>;
}
```

**A verb says what it does; its parameters describe themselves.** The comment
on `addItem` does not restate what it takes or returns, because
`AddItemEvent.title` and `AddItemResult.item` already say so where they are
declared — which is where `--help` sources both its `Output:` line and a flag's
prose. Restating it in the verb comment would be the same content twice, and
the copy that goes stale when a parameter changes.

**One interface, holding both.** An item's fields and its verbs sit together
because that is what an item *is*: a child in `children` is a full item, and
declaring it any narrower would be a claim the runtime contradicts — ask that
child what it can do and it lists all five.

**Every field is a reference, not a copy.** `children` holds links to item
pieces, and so does `blockedOn`. That is the whole reason addresses matter
here: the same item can sit under one item's `children` and in another's
`blockedOn`, and only an address tells a reader those are one item rather than
two.

**Which makes an unshaped read expensive, on purpose.** Reading `children` with
no selection carries every field *and* a link envelope per verb per element —
measured at 3183 bytes for a single child on this pattern. Naming what you want
brings it to 51:

```bash
cf piece get --piece <item> children --select 'title,status'
```

That is not a workaround; it is the read model working. A schema is a query,
and a caller who names nothing has asked for everything. The same flags shape a
verb's result, because
[a result is a read on a different cell](../plans/fabric-read-model.md) — 1743
bytes unshaped, 140 with `--select 'item.title'`.

**The prose above reaches a caller.** Each verb carries a doc comment saying
what it is for, which is where that documentation belongs, and `cf` serves it:
as a row's `description` under `cf piece verbs --json`, and as the summary line
of the verb's own help page. Step 2 has the measurement.


## 1. Arrive with a slug **[today]**

An address a person can type, rather than a fid from a previous command.

```bash
cf test tracker.test.tsx
cf piece new tracker.tsx --test tracker.test.tsx --slug board
cf piece verbs --piece board
```

```text
PATTERN cf:module/ZPxyGdkkv-YmizdHdNx5DIlqlpc9JRSm5iXTl4Tb2T0#default
NAME    KIND    ON     MARKS
addItem handler result
```

**One row, because the board declares one verb.** `items` is the board's array
of root items and `$NAME` is its display name; both are data, and data is not
callable, so neither is offered to a caller as something to call.

Slug resolution sits on the shared path (`resolvePieceConfigWithPieces`,
`packages/cli/lib/piece.ts`), so every command below takes `board` too.

The listing carries the deployed pattern's source identity, which is how a
client tells it is talking to a newer pattern than it was written against.

**The table is names; `--json` is the description.** The columns are a grid to
scan, so each row stays one line and a verb's prose — which runs to a sentence
or several — travels on the machine-readable spelling instead, as the row's
`description`, alongside the input and output schemas the table has no room for
either. A person asking what one verb is for reads its help page, where the
same words are the summary line.

## 2. Ask what a verb wants **[today]**

```bash
cf piece call --piece board addItem -- --help
```

```text
Usage:
  cf piece call --piece board addItem -- --help
  cf piece call --piece board addItem <json>
  cf piece call --piece board addItem -- --title <string>

File a new root item on the board.

JSON input:
  Pass inline JSON as one positional argument or after `--json`.
  { title: string }

Flags after `--`:
  --title <string>    Required. One line naming the work.

Output:
  The invocation's `result`:
    item <json>
```

**Structure and prose are both published, and they come from different
documents.** The split is worth holding onto, because only one half is free:

| | Where it comes from | Reaches `cf`? |
| --- | --- | --- |
| flag name, placeholder, required-ness | the event's **type** — `{ title: string }` | **yes** |
| result field name and placeholder | the result's **type** — `AddItemResult` | **yes** |
| what `title` means, what the verb is for | the author's **doc comments** | **yes**, read from the pattern |

The `Output:` section names the position a caller collects the value from —
the settled Invocation JSON's `result` — because that is where a handler's
result arrives, rather than on stdout the way a tool's does. A verb that
declares nothing carries no such section at all, which is how the page tells
the two shapes apart without asserting anything false about either.

The structural half needs nothing authored per pattern:
`parseObjectInput` builds a `FlagDescriptor` per input-schema property, so
`--title <string> Required.`
falls out of the type. That is why the page exists at all.

**The prose half is not on the wire with it**, and knowing why is what keeps a
reader from looking for it in the wrong place. A verb dispatches through a
callable cell, and that cell takes its schema from the link chain it resolves
through (`cell.ts:asSchemaFromLinks`). For a verb that link is the handler
node's `$event` input, and that schema is not the author's event type at all —
it is the handler's **read** of the event, narrowed to the fields its
implementation touches. A declared field the body never mentions is absent from
it whether or not the type marks it optional. So the served schema is not the
declared one with the prose taken out; it is a query, generated from usage,
which never carried an author's words in the first place.

So the prose is read from the **pattern**, which is the only place it survives
compilation:

| An author writes… | Where the compiled pattern keeps it |
| --- | --- |
| a comment on the **verb itself**, as in the model above | `resultSchema.properties.<verb>.description`, a sibling of the `$ref` naming its event |
| a comment on an **event field** (what `title` means) | `$defs.<Event>.properties.<field>.description` |
| a comment on the **event interface** | nowhere — this one does not compile ([#5559](https://github.com/commontoolsinc/labs/issues/5559)) |

`cf piece verbs` and `cf piece call <verb> --help` already load that pattern to
report what a verb hands back, so both read the prose from the same load. The
verb's own comment becomes the listing row's `description` and the help page's
summary line. The event fields' comments are folded into the input schema the
page renders flags from, at the positions that schema already has.

**Which means walking two documents that agree about almost nothing
structurally.** The same field can be a `$ref` in one and an inline object in
the other, and which it is depends on what the handler body happens to read — so
a walk that steps through `properties` key-for-key finds a bare `$ref` on one
side, no `properties` under it, and stops one level short of the prose. Both
sides' references are followed for that reason. A served reference is followed
without being inlined: it names a definition several positions can share, and a
caller's tooling reads that shape. A field's own prose is therefore written
where the field is, never into the definition it points at, which would
attribute one position's sentence to every other holder of the same type.

**Folded in, never substituted.** The two documents disagree about shape, by
construction: the declared type is what a caller may send, the read schema is
what the implementation looks at. Only `description` annotations cross between
them, so the served schema stays the authority on shape and takes only the
words. Substituting the declared type instead would offer a caller flags for
fields the running handler does not read — a page describing the source rather
than the piece being talked to.

Which leaves a real question this does not settle: a field an author declares
and the body never reads is a field a caller cannot discover. Whether the two
schemas should be reconciled, and in which direction, is open.

### What the page still owes **[blocked]**

Every line of prose on the page above already exists as a doc comment in
`tracker.tsx`. Nothing is invented for the illustration — it is that file's own
words, reaching a caller. One line is still missing, and it is the last one:

```text
Output:
  The invocation's `result`:
    item <json>       The root item this call created.
```

**Three levels of documentation, and one of them stops short.** An author writes
each where the thing it describes is declared — the verb says what it does, and
each parameter describes itself:

| Level | Written on | Compiled? | Reaches `cf`? |
| --- | --- | --- | --- |
| the verb — *what it does* | the `Stream` property | **yes**, beside the `$ref` | **yes**, as the summary line |
| an **input** parameter | a field of the event interface | **yes**, in `$defs.<Event>.properties` | **yes**, beside its flag |
| an **output** parameter | a field of the result interface | **yes**, on the declared result | **yes**, under `--help --json` — but not on the text page |

The output parameter's is the one still short of the page, and it is short by a
single step. A verb's declared result reaches `cf` **unresolved** — `--help
--json` on `addItem` serves `properties.item` as a `$ref` into `$defs.ItemOutput`
carrying `"description": "The root item this call created."`, the author's own
comment, verbatim. What drops it is the rendering: the text page writes each
result property as `name <placeholder>` and never reads the `description` beside
it. So the prose is on the wire and one line of rendering away.

The summary line is worth one more note, because an event *interface's* comment
would be the other candidate for it. That is the one level here that does not
compile at all ([#5559](https://github.com/commontoolsinc/labs/issues/5559)) —
so the verb's own comment is both the shorter road and the better place for an
author to write it, since it sits beside the type it describes.

## 3. Complete against the live piece **[today]**

```bash
cf piece call --piece board <TAB>
addItem
```

Verb names and piece addresses complete against the space
(`shapeVerbCandidates` / `liveCandidates`,
`packages/cli/lib/completion/providers.ts`), in bash and zsh. The candidates
map one-for-one over the listing in step 1, so completion offers what that
command names and nothing besides.

What does not complete is a result field — `--select 'it<TAB>'` has nothing to
offer. The knowledge exists now: the help page above enumerates `item`, off the
same declared result a completion provider would read. What is missing is the
provider consulting it, which is the same wiring a derived default selection
needs.

## 4. Create, and carry the address forward **[today]**

```bash
EPIC=$(cf piece call --piece board addItem -- --title "Login rewrite" \
       --select 'item@' | jq -r '.result.item."$link".id')

cf piece call --piece "$EPIC" addChild -- --title "Session cookie handling"
cf piece call --piece "$EPIC" recordNote -- --body "Blocked on the cookie spec"
```

**This is the composition the surface exists for.** A create hands back the
piece it made, the address renders in place, and the next call takes it as its
target. Identity survives the round trip instead of being flattened into a copy
of the item's contents.

`--show-links` is the **[today]** spelling of the same move: it returns a
dictionary of RFC 6901 pointers naming the document behind each result path, so
the address is one `jq` hop further away but reachable.

It differs from a marker in one way that matters: it **resolves**. A marker
renders the link as stored; `--show-links` follows the chain as far as the
links this replica has already materialized, and names the document it reaches.
That is not a terminal answer — a hop whose target is not local kicks off a
fetch nobody awaits, and a one-shot command exits before it lands, so the same
path can resolve further on a later read. For getting an address to compose
with, the two are interchangeable and an in-band marker is the shorter road.

**An address is not an identifier to compare.** Addresses are many-to-one over
cells, and a holder of one cannot tell a canonical id from an alias. Two
positions holding the same piece can render two different `id`s, and the two
spellings above can disagree with each other about one piece — a piece created
inside a handler and pushed into a collection is held through a link that
redirects to it, and the two routes stop at different points along that
redirect. Each address reads back the same contents, which is what an address
is for: something to read next, not a claim about canonical identity.

So compose with an address; do not compare one. Two ids differing does not mean
two pieces — and comparing contents does not rescue the question, since two
distinct pieces can hold identical contents and one piece's contents change
under it. **Asking whether two addresses name the same piece is not something
the CLI supports today.**

Neither route needs a verb to declare its result. A `$link` marker on a link
position renders the address and suppresses the fetch without consulting a
source schema at all. What a declared result would add is that `cf` could
derive the selection instead of the caller supplying it.

One case already works this way. `addChild` hands back the child it created,
and the child's `parent` points back at the item that holds it. That loop
means the result cannot be written out as plain JSON at all. So `cf` falls
back on the verb's declared result and renders that shape instead: the
child's fields come through as usual, and `parent` — the position where the
loop would start again — comes through as an address, the same address a
`$link` marker would have produced. If the verb declares no result, there is
nothing to fall back on, and the call fails with a clear message rather than
a stack trace.
[A result that points back at its container](verbs-over-the-cli.md#a-result-that-points-back-at-its-container)
shows the full exchange.

## 5. Read the tree back, bounded **[today]**

```bash
cf piece get --piece board items --select 'title,status,children@'

cf piece get --piece board items --select 'title,status' \
  --filter '.status != "done"'
```

Two commands rather than one, because **an `@` suffix and `--filter` are
refused together**, with a reason worth keeping:

```text
--filter cannot be combined with an `@` suffix in --select: a filtered array's
elements no longer say which positions they came from, and an address names a
position
```

`--filter` runs before projection, so `status` decides membership and need not
appear in the output. A marked collection costs one document read however many
entries it holds, because the links are stored inline in the document being
read, and a rejection below one of those links propagates up through the
containers holding it rather than being read past.

The same options work on a call's result, on a wish, and on a direct read: one
read layer, several arrivals.

## 6. Relate two items **[blocked]**

```bash
cf piece call --piece "$EPIC" blockOn -- --on "$OTHER"
```

This is where the session stops.

## The composition axis

Steps 4 and 6 are the same move — take an address out of one command and put it
into the next — and only one of them works.

| Direction | State |
| --- | --- |
| address → `--piece` (the receiver) | works |
| address → an argument field | refused |

A call payload is plain JSON. `normalizeCallableInputForExecution`
(`packages/cli/lib/exec-schema.ts`) does nothing with links, so `--on "$OTHER"`
arrives as a string the pattern cannot resolve into a reference.

A tree mostly hides this, because the natural shape is to call the verb *on* the
parent — the receiver carries the relationship, so no address needs to be an
argument. It surfaces the moment two items must be related to each other:
`blockOn`, a `duplicates` edge, a `move`, or a removal that names a child rather than an
index. Indices are not addresses; a position shifts under concurrent writes.

[CLI surface shape](../plans/cli-surface-shape.md) states the property for
commands — an address printed by one command is accepted by the next. This is
the same property one level in, on arguments. A second instance sits on
`cf piece set-slug`, whose source positional resolves through its own path
rather than the one `--piece` uses.

This gap is independent of whether a verb's declared result reaches the runtime.
Declared results make an **output** self-describing; this is about what an
**input** accepts.

## What the session is waiting on

| Gap | Needs |
| --- | --- |
| A result field's prose absent from the text page | Only the renderer — the description is already served under `--help --json`, beside the field it documents |
| An event interface's own comment absent everywhere | The one prose level that does not compile ([#5559](https://github.com/commontoolsinc/labs/issues/5559)). Nothing downstream can serve what was never emitted |
| A declared event field the handler body never reads is absent from the served input schema | A decision, not a patch: the served schema is the handler's read and the declared type is the contract, and which one a caller is owed is open |
| `--select` completion, and refusal before the call | A provider reading the declared result the help page already resolves |
| An address accepted as an argument | The round-trip property above |

Five rows and five distinct gaps, and the first three are worth reading
together because they look like one. They are not: the first is a renderer that
does not print what it is handed, the second is a comment nothing emits, and the
third is a *field* — not prose at all — and an open question rather than a
defect. Only the second is an author's words going missing.
