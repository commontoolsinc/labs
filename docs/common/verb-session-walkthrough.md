# A verb session, end to end

What driving a pattern entirely through `cf` looks like when the verb surface is
complete: discovery, help, completion, and carrying an address from one call
into the next.

[Verbs over the CLI](verbs-over-the-cli.md) explains what a verb hands back.
This walks a whole session using it, and marks where the surface is still
incomplete.

The subject is a work-item tracker — items in a tree, plus typed cross-links —
sketched here rather than deployed. No pattern file backs it yet.

**Every step is marked for what is real.** The point of the document is the
line between them.

| Mark | Meaning |
| --- | --- |
| **[today]** | works against a current build |
| **[stack]** | built and merging incrementally: the `$link` marker has landed, so these steps are reachable today through a full `--schema`. What is pending is the concise `--select` spelling and its arrival on `piece call` ([the verbs plan](../plans/verbs-implementation.md) tracks the order) |
| **[blocked]** | needs something decided or built |

Section headers inside the help output below are the literal strings
`renderPieceCallHelp` emits (`packages/cli/lib/exec-schema.ts`). Their contents
are illustrative.

## 1. Arrive with a slug **[today]**

An address a person can type, rather than a fid from a previous command.

```bash
cf piece new tracker.tsx --slug board
cf piece verbs --piece board
```

```text
pattern  tracker.tsx @ src:9f2a…
NAME     KIND     ON
add      handler  result
block    handler  result
note     handler  result
remove   handler  result
rollup   tool     result
```

Slug resolution sits on the shared path (`resolvePieceConfigWithPieces`,
`packages/cli/lib/piece.ts`), so every command below takes `board` too.

The listing carries the deployed pattern's source identity, which is how a
client tells it is talking to a newer pattern than it was written against.

## 2. Ask what a verb wants **[today]**

```bash
cf piece call --piece board add --help
```

```text
Usage:
  cf piece call --piece board add --help
  cf piece call --piece board add <json>
  cf piece call --piece board add -- --title <string> [--parent <string>]

JSON input:
  Pass inline JSON as one positional argument or after `--json`.
  { title: string; parent?: string }

Flags after `--`:
  --title <string>    Required.
  --parent <string>   Optional.

Output:
  No output on success.
```

The flags, their types and their required-ness are derived. Nothing is authored
per pattern: `parseInputFlags` builds a descriptor per input-schema property.

**The prose is not there, and that is measured.** `specificFlagLines` *would*
render a `description` beside each flag — it reads one through
`schemaDescription` — but no description ever reaches it. Write both kinds of
JSDoc on an event and neither arrives:

```tsx
// Shown as interface or class members.
/** One line naming the work. */
title: string;
```

- A **property** comment reaches the compiled pattern, where
  `$defs.<Event>.properties.title.description` carries it, and is **stripped**
  from the schema `cf piece call … --help` reads. Same schema, no description.
- An **interface-level** comment — the one that would say what the verb is
  *for* — does not reach the compiled pattern at all. Its `$defs.<Event>`
  entry has no `description`.

So the help page shows `--title <string>  Required.` and stops.

Three things are wrong with that page rather than missing from it.

**`Output:` is false.** `add` declares a result and returns one; the value
arrives on `invocation.result`. The handler branch of `renderPieceCallHelp`
prints the fixed string regardless.

**A flag's prose never arrives**, per the measurement above — the renderer is
ready for it and the generator does not supply it.

**The verb's purpose is absent**, and unlike the flags it is absent from the
source of truth as well: an event interface's own doc comment is dropped in
emission, so there is nothing downstream to render. `cf` can say what `add`
takes and not what it is for.

## 3. Complete against the live piece **[today]**

```bash
cf piece call --piece board <TAB>
add  block  note  remove  rollup
```

Verb names and piece addresses complete against the space
(`shapeVerbCandidates` / `liveCandidates`,
`packages/cli/lib/completion/providers.ts`), in bash and zsh.

What does not complete is a result field — `--select 'it<TAB>'` has nothing to
offer, because nothing in the system knows the result has a field called `item`.

## 4. Create, and carry the address forward **[stack]**

```bash
EPIC=$(cf piece call --piece board add -- --title "Login rewrite" \
       --select 'item@' | jq -r '.result.item."$link".id')

cf piece call --piece "$EPIC" add -- --title "Session cookie handling"
cf piece call --piece "$EPIC" note -- --body "Blocked on the cookie spec"
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

## 5. Read the tree back, bounded **[stack]**

```bash
cf piece get --piece board items \
  --select 'title,status,children@' \
  --filter '.status != "done"'
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
cf piece call --piece "$EPIC" block --on "$OTHER"
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
`block`, `duplicates`, `move`, or a `remove` that names a child rather than an
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
| A flag's prose absent from its help page | An emission fix — the renderer already reads a `description`; the schema the CLI is served has none |
| A verb's purpose absent from its help page | An emission fix, then a renderer one — an event interface's doc comment reaches neither |
| Result fields listed in help | A declared result |
| `--select` completion, and refusal before the call | A declared result |
| An address accepted as an argument | The round-trip property above |

Three of the five need no decision.
