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
declared — which is also where `--help` would source a flag's prose and an
`Output:` line. Restating it in the verb comment would be the same content
twice, and the copy that goes stale when a parameter changes.

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
$NAME   handler result
addItem handler result
items   handler result
```

**Two of those three rows are not verbs.** `items` is the board's array of root
items and `$NAME` is its display name — data, not callables, and
`cf piece call --piece board items` will not do anything useful. The listing
over-reports: its forced-stream fallback answers the cast for values that are
not streams
([#5576](https://github.com/commontoolsinc/labs/issues/5576)). Only `addItem`
is real here.

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
```

**Structure is published; prose is not.** The flags are the whole of what `cf`
can currently say about a verb — there is no `Output:` section, because this
page cannot see a declared result and a fixed claim about output would be false
for every verb that declares one. The split is worth holding onto:

| | Where it comes from | Survives? |
| --- | --- | --- |
| flag name, placeholder, required-ness | the event's **type** — `{ title: string }` | **yes** |
| what `title` means, what the verb is for | the author's **doc comments** | **no** |

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
Flags, with no summary line.

So the help page shows `--title <string>  Required.` and stops.

### What the page becomes **[blocked]**

Every line below already exists as a doc comment in `tracker.tsx`. Nothing here
is invented for the illustration — this is that file's own prose, reaching a
caller:

```text
Usage:
  cf piece call --piece board addItem -- --title <string>

File a new root item on the board.

JSON input:
  { title: string }

Flags after `--`:
  --title <string>    Required. One line naming the work.

Output:
  item     The root item this call created.
```

**Three levels of documentation, three different fates.** An author writes each
one where the thing it describes is declared — the verb says what it does, and
each parameter describes itself:

| Level | Written on | Compiled? | Reaches `cf`? |
| --- | --- | --- | --- |
| the verb — *what it does* | the `Stream` property | **yes**, beside the `$ref` | no |
| an **input** parameter | a field of the event interface | **yes**, in `$defs.<Event>.properties` | no |
| an **output** parameter | a field of the result interface | **no** | no |

The first two are the same loss: emitted, then absent from the resolved schema
the CLI is served, so they come back together
([#5637](https://github.com/commontoolsinc/labs/issues/5637)).

The third is different in kind, and it is the one worth understanding. There is
no structured description of an output parameter *anywhere*, no matter what the
author writes — because the result type is not compiled at all. `Stream<E, R>`
compiles `E` and drops `R`, so `$defs` on this pattern holds
`AddItemEvent`, `AddChildEvent`, `BlockOnEvent`, `FinishEvent`,
`RecordNoteEvent` and no `Result` interface of any kind. A comment on
`AddItemResult.item` has nothing to be attached to.

That is verbs plan item 1 — a verb's declared result reaching the runtime —
and until it lands, output documentation has no home rather than a broken
pipe.

The summary is worth one more note. An event *interface's* comment would be the
other candidate for that line, and it is the one thing here that genuinely
never compiles — so sourcing the summary from the verb's own comment, which is
already emitted, is both the smaller change and the better place for an author
to write it.

Three things are wrong with that page rather than missing from it.

**`Output:` is false.** `addItem` declares a result and returns one; the value
arrives on `invocation.result`. The handler branch of `renderPieceCallHelp`
prints the fixed string regardless.

**A flag's prose never arrives**, per the measurement above — the renderer is
ready for it and the resolution does not carry it.

**The verb's purpose is absent** for the same reason, not a different one: its
comment is emitted and lost in the same step, and the page has no summary line
to print it on even once it survives. `cf` can say what `addItem` takes and not
what it is for.

## 3. Complete against the live piece **[today]**

```bash
cf piece call --piece board <TAB>
addItem  items  $NAME
```

Verb names and piece addresses complete against the space
(`shapeVerbCandidates` / `liveCandidates`,
`packages/cli/lib/completion/providers.ts`), in bash and zsh.

What does not complete is a result field — `--select 'it<TAB>'` has nothing to
offer, because nothing in the system knows the result has a field called `item`.

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

Neither route needs a verb to declare its result. A `$link` marker on a link
position renders the address and suppresses the fetch without consulting a
source schema at all. What a declared result would add is that `cf` could
derive the selection instead of the caller supplying it.

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
read — subject to the verbs plan's item 3, which is what makes a rejection below
a link propagate up through the containers holding it.

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
| `Output:` claims a handler returns nothing | Nothing — it is wrong, not missing |
| A flag's prose absent from its help page | Same loss as the row below — emitted into the `$def`, absent from the resolved schema the CLI is served |
| A verb's purpose absent from its help page | A genuine emission gap, then a renderer one — an event interface's comment never compiles, and the page has no summary line |
| A verb's own doc comment absent everywhere | Not emission — it is emitted and lost when the event `$ref` is resolved for the CLI |
| A result field's prose | Item 1 first — there is no declared result on the wire to hang it on |
| Result fields listed in help | A declared result |
| `--select` completion, and refusal before the call | A declared result |
| An address accepted as an argument | The round-trip property above |

Eight rows, six distinct gaps: the three prose rows are one problem seen from
three sides — an author writes about a verb on its event interface, on an event
field, or on the verb itself, and none of it reaches a caller. Of the six,
three need no decision from anyone.
