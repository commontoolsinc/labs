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

**Five verbs, one per shape.** They are not five features. Each exists because
a caller asks a different question about what comes back, and the tracker holds
one of each so that no shape goes undemonstrated:

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
declared — which is where `--help` sources its `Output:` line today, and where
it would source a flag's prose. Restating it in the verb comment would be the
same content twice, and the copy that goes stale when a parameter changes.

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

**The prose above does not reach a caller.** Each verb carries a doc comment
saying what it is for, which is where that documentation belongs — and it is
emitted correctly and then lost, so `cf piece verbs` can list a verb and never
say what it does. Step 2 has the measurement.


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

## 2. Ask what a verb wants **[today]**

```bash
cf piece call --piece board addItem -- --help
```

```text
Usage:
  cf piece call --piece board addItem -- --help
  cf piece call --piece board addItem <json>
  cf piece call --piece board addItem -- --title <string>

JSON input:
  Pass inline JSON as one positional argument or after `--json`.
  { title: string }

Flags after `--`:
  --title <string>    Required.

Output:
  The invocation's `result`:
    item <json>
```

**Structure is published; prose is not.** The flags and the result fields are
the whole of what `cf` can currently say about a verb. The split is worth
holding onto:

| | Where it comes from | Survives? |
| --- | --- | --- |
| flag name, placeholder, required-ness | the event's **type** — `{ title: string }` | **yes** |
| result field name and placeholder | the result's **type** — `AddItemResult` | **yes** |
| what `title` means, what the verb is for | the author's **doc comments** | **no** |

The `Output:` section names the position a caller collects the value from —
the settled Invocation JSON's `result` — because that is where a handler's
result arrives, rather than on stdout the way a tool's does. A verb that
declares nothing carries no such section at all, which is how the page tells
the two shapes apart without asserting anything false about either.

The structural half needs nothing authored per pattern:
`parseObjectInput` builds a `FlagDescriptor` per input-schema property, so
`--title <string> Required.`
falls out of the type. That is why the page exists at all.

The prose half is **emitted and then lost**, which is worth stating precisely
because the obvious guess sends the fix to the wrong place:

| An author writes… | In the compiled pattern | Served to `cf` |
| --- | --- | --- |
| a comment on an **event field** (what `title` means) | **yes** — `$defs.<Event>.properties.title.description` | no |
| a comment on the **verb itself**, as in the model above | **yes** — beside the `$ref` | no |
| a comment on the **event interface** (what the verb is for) | no | no |

So the generator handles two of the three correctly — one pattern here carries
descriptions on 36 `Stream` properties. What the CLI is served is the
*resolved* form of the event schema, with no `$defs` and no `$ref`, and the
descriptions are not in it. The loss is in that resolution, not in emission
([#5637](https://github.com/commontoolsinc/labs/issues/5637)).

The renderer is ready for two of the three: `specificFlagLines` reads a
`description` through `schemaDescription` and would print one the moment it
were given one, and a listing row would carry one as soon as it were supplied.
The verb's *purpose* needs a second change on top, because
`renderPieceCallHelp` has nowhere to put it — the page runs Usage, JSON input,
Flags, Output, with no summary line.

So the help page names `--title <string>  Required.` and `item <json>`, and
says nothing about what either means.

### What the page becomes **[blocked]**

Every line below already exists as a doc comment in `tracker.tsx`. Nothing here
is invented for the illustration — this is that file's own prose, reaching a
caller. The structure around it is what the page renders today; the prose is
what it does not:

```text
Usage:
  cf piece call --piece board addItem -- --title <string>

File a new root item on the board.

JSON input:
  { title: string }

Flags after `--`:
  --title <string>    Required. One line naming the work.

Output:
  The invocation's `result`:
    item <json>       The root item this call created.
```

**Three levels of documentation, three different fates.** An author writes each
one where the thing it describes is declared — the verb says what it does, and
each parameter describes itself:

| Level | Written on | Compiled? | Reaches `cf`? |
| --- | --- | --- | --- |
| the verb — *what it does* | the `Stream` property | **yes**, beside the `$ref` | no |
| an **input** parameter | a field of the event interface | **yes**, in `$defs.<Event>.properties` | no |
| an **output** parameter | a field of the result interface | **yes**, on the declared result | **yes**, under `--help --json` |

The first two are the same loss: emitted, then absent from the resolved schema
the CLI is served, so they come back together
([#5637](https://github.com/commontoolsinc/labs/issues/5637)).

The third travels furthest, and it is the one worth understanding. A verb's
declared result reaches `cf` **unresolved** — `--help --json` on `addItem`
serves `properties.item` as a `$ref` into `$defs.ItemOutput` carrying
`"description": "The root item this call created."`, the author's own comment,
verbatim. Nothing strips it, because nothing resolves it. Where the input side
loses its prose to `$ref` resolution, the output side keeps it.

What drops it is the last step: the text page renders each result property as
`name <placeholder>` and never reads the `description` beside it. So the prose
is on the wire and one line of rendering away, which is a different problem
from the two above and a much smaller one.

The summary is worth one more note. An event *interface's* comment would be the
other candidate for that line, and it is the one thing here that genuinely
never compiles — so sourcing the summary from the verb's own comment, which is
already emitted, is both the smaller change and the better place for an author
to write it.

Two things are missing from that page, and they are the same thing twice.

**A flag's prose never arrives**, per the measurement above — the renderer is
ready for it and the resolution does not carry it.

**The verb's purpose is absent** for the same reason, not a different one: its
comment is emitted and lost in the same step, and the page has no summary line
to print it on even once it survives. `cf` can say what `addItem` takes and
hands back, and not what either is for.

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
| A flag's prose absent from its help page | Same loss as the row below — emitted into the `$def`, absent from the resolved schema the CLI is served |
| A verb's purpose absent from its help page | A genuine emission gap, then a renderer one — an event interface's comment never compiles, and the page has no summary line |
| A verb's own doc comment absent everywhere | Not emission — it is emitted and lost when the event `$ref` is resolved for the CLI |
| A result field's prose absent from the text page | Only the renderer — the description is already served under `--help --json`, beside the field it documents |
| `--select` completion, and refusal before the call | A provider reading the declared result the help page already resolves |
| An address accepted as an argument | The round-trip property above |

Six rows, five distinct gaps: the three prose rows above the fourth are one
problem seen from three sides — an author writes about a verb on its event
interface, on an event field, or on the verb itself, and none of it reaches a
caller. The fourth is not that problem: an output field's prose does reach the
CLI, and only the text renderer drops it.
