# Verbs over the CLI

A **verb** is a pattern's callable surface: a `Stream` property a caller invokes
with `cf piece call`. This document is about what a caller gets *back*.

A verb can declare a result, and the caller reads it off the call. That turns a
sequence of "mutate, then go looking for what happened" into a single
exchange — and the thing a verb hands back can be a **piece**, so a create tells
you where the thing it created lives.

For the authoring side, see [concepts/action.md](concepts/action.md) and
[concepts/handler.md](concepts/handler.md); for the general CLI loop, see
[workflows/development.md](workflows/development.md).

## Declaring a result

A verb's type carries its result as the second parameter, and the body returns
it:

```tsx
import {
  action,
  type Default,
  pattern,
  type Stream,
  type Writable,
} from "commonfabric";

interface NoteOutput {
  title: string;
}

const Note = pattern<{ title: string }, NoteOutput>(({ title }) => ({ title }));

interface AddNoteEvent {
  title: string;
}

interface AddNoteResult {
  /** The note this call created — the piece itself, not a minted identifier. */
  note: NoteOutput;
}

interface BoardOutput {
  notes: NoteOutput[];
  addNote: Stream<AddNoteEvent, AddNoteResult>;
}

export default pattern<
  { notes?: Writable<NoteOutput[] | Default<[]>> },
  BoardOutput
>(({ notes }) => {
  const addNote = action<AddNoteEvent, AddNoteResult>(({ title }) => {
    const note = Note({ title });
    notes.push(note);
    // Return the piece itself. Patterns return references; rendering identity
    // as an address is the client's job.
    return { note };
  });
  return { notes, addNote };
});
```

A verb that declares nothing stays spelled `Stream<Event>` and is a value-less
verb — the overwhelmingly common shape. `Stream<E, R>` and `Stream<E>` are
deliberately not interchangeable, so a declared result cannot be dropped
silently on assignment.

## What the CLI gives you

### Ask what a piece can do

`cf piece verbs` lists a piece's callables, and the listing carries the deployed
pattern's source identity — so you can tell which version you are talking to
before relying on any of its behavior.

```bash
cf piece verbs --piece <piece> --json
```

Each row carries the verb's input schema and, when the verb declares a result,
the schema of what it hands back — so both halves of "what may I send, and what
do I get" are answerable before the first call rather than by making one:

```json
{
  "name": "addNote",
  "kind": "handler",
  "on": "result",
  "inputSchema": { "…": "…" },
  "outputSchema": {
    "type": "object",
    "properties": { "note": { "$ref": "#/$defs/NoteOutput" } },
    "required": ["note"],
    "$defs": { "…": "…" }
  }
}
```

A value-less verb carries no `outputSchema` at all, which is how a caller tells
the two apart without calling.

### Call a verb and read its result

`cf piece call` prints one settled **Invocation JSON** object on stdout:

```bash
cf piece call --piece <board> addTopic \
  '{"title":"Ship the thing","body":"the initial document","agentName":"Sol"}'
```

```json
{
  "invocation": "0f4c…",
  "status": "settled",
  "result": { "topic": { "$NAME": "Ship the thing", "…": "…" } }
}
```

The `result` is what the verb returned. Here that is the created topic piece,
so the caller can address it directly instead of filing it and then searching
the board for the thing it just made — a search that is a guess the moment two
callers file concurrently.

Anything the *pattern* resolved comes back too. A verb that stamps a write time
or derives structured authorship from the event returns those in its record;
the caller could not have computed them.

### Asking for a smaller result

A verb decides what it returns; the caller decides how much of it to look at.
`--filter`, `--select`, and `--schema` — the same three flags `cf piece get`
takes, with the same grammar — shape the `result` before it reaches stdout, and
go before the callable name:

```bash
cf piece call --piece <topic> --select comment.writtenAt addComment \
  '{"body":"first","agentName":"Sol"}'
```

```json
{
  "invocation": "0f4c…",
  "status": "settled",
  "result": { "comment": { "writtenAt": "2026-08-07T09:15:27Z" } }
}
```

This shapes a result that already exists rather than deciding what travels: the
readback has the whole receipt in hand before the selection runs. So a
value-less verb keeps reporting no `result` at all — there is nothing for a
selection to be about — and `--no-wait`, which never reads the receipt back,
refuses all three flags. `--show-links` composes with a projection, because a
projection leaves every surviving path where it was; it does not compose with
`--filter`, which moves the positions a link names.

`packages/cli/README.md` has the grammar and the supported schema subset.

### Retries are safe, and cheap to reason about

`--invocation <id>` makes a call idempotent. The id is your own word for the
call — and `add-comment-1` is a word two agents both reach for, so an id on its
own does not say whose invocation it is. An **invocation session** does. Mint
one per agent run and carry it on every call of that run:

```bash
export CF_INVOCATION_SESSION=$(cf invocation-session new)
```

The environment is where a session belongs, because it is closer to a secret
than a setting: it is what keeps an outcome's address out of reach of a
stranger, and a command's arguments are readable in a process listing where its
environment is not. `--invocation-session <id>` overrides it for one call.

The pair is what names an invocation. Replaying a settled id **from the session
that chose it** returns the **original** result rather than re-executing:

```bash
cf piece call --piece <topic> --invocation add-comment-1 \
  addComment '{"body":"first","agentName":"Sol"}'

# Same id, same session, different payload: the original result comes back,
# and no second comment is recorded.
cf piece call --piece <topic> --invocation add-comment-1 \
  addComment '{"body":"different","agentName":"Sol"}'
```

That is the property an agent depends on when it retries a call whose response
it never saw.

That same id under a **different** session is a different invocation: it
executes, and returns its own result. So two agents that pick the same word are
never told each other's calls have settled, and knowing a piece, a verb and an
id is not enough to read someone else's outcome — the session is the part a
stranger cannot guess.

`--invocation` therefore requires a session, and a call naming an id without one
is refused, pointing you at `cf invocation-session new` and
`CF_INVOCATION_SESSION`. Pass neither and both are minted for that one call: a
random id names an outcome nothing else will ask for, and a call that never
intended to replay loses nothing.

A **rejected** call is different from a settled one: it never spends its id. If
a verb refuses the payload, correct it and retry under the same id.

```bash
# Refused: nonzero exit, nothing written — and `add-1` is NOT spent, because
# the payload never became an event.
cf piece call --piece <board> --invocation add-1 \
  addTopic '{"title":"","agentName":"Sol"}'

# The same id, corrected. This one executes; a settled id would have replayed
# instead.
cf piece call --piece <board> --invocation add-1 \
  addTopic '{"title":"Corrected","agentName":"Sol"}'
```

That is the difference worth holding onto: a **settled** id replays its original
result, while a **refused** id was never consumed and is still yours to use.

### Reading is not calling

`cf piece get` reads data. A path that lands on a verb is refused and redirected
to `cf piece call`, because reading a verb would return the stream's
serialization — never what a caller wanted.

### Watching where the time goes

`--verbose` streams per-phase wall-clock timings to **stderr**, leaving stdout
as clean Invocation JSON you can pipe into `jq`:

```text
timing: initial_sync → dispatched 424.5ms
timing: dispatched → committed 129.8ms
timing: committed → readback 0.0ms
timing: readback → settled 72.8ms
```

`--await` and `--no-wait` control whether the call waits for settlement and
readback or exits once the commit is acknowledged.

## Which results arrive, and when

Two paths deliver a result, and both arrive by default:

- A result **carrying cells or pieces** — like a create returning the piece it
  made — travels the result-pattern projection path.
- A result that is **plain JSON** — a record of what was written — projects into
  the receipt under the `plainResultReceipts` runtime option, which is on by
  default ([EXPERIMENTAL_OPTIONS.md](../development/EXPERIMENTAL_OPTIONS.md)).
  `EXPERIMENTAL_PLAIN_RESULT_RECEIPTS=false` restores the discard, which is a
  rollback switch rather than something a caller opts into.

So a verb that declares a result hands one back. Where a plain record is absent,
the option was explicitly turned off — the verb still performed its write.
**Treat an absent result as "not enabled here", never as "the mutation did not
land."**

One more caveat worth carrying: a verb's result shape is not part of the piece's
stored schema, so nothing validates it and nothing protects it across a pattern
update. Read the pattern's own documentation for what a verb returns, and check
`cf piece verbs` for which source a piece is actually running.

## Exercising all of it

Everything above is asserted by a walkthrough that lives with the integration
tests, not with this document:

- **`packages/cli/integration/verbs-over-the-cli.sh`** — the runnable
  walkthrough. Each step names the property it asserts, so a failure says which
  one broke. A fresh space per run, no prior state.
- **`packages/cli/integration/pattern/verb-results.tsx`** — the pattern it
  deploys, which exists for this walkthrough alone. Nothing else deploys it, so
  a change to a pattern the product ships can never break a demonstration of how
  the verb surface works.

Run it against any host:

```bash
API_URL=http://localhost:8000 packages/cli/integration/verbs-over-the-cli.sh
```

CI runs it in the `piece-call` shard. It takes under half a minute and around
two dozen `cf` invocations against a warm local toolshed.

Each step demonstrates one use case:

| Step | What it shows |
| --- | --- |
| 1–2 | Deploy a pattern, then ask what it can do |
| 3 | A create hands back the piece it created |
| 4 | A verb returns what it wrote, including what only it could compute |
| 5 | A call's result names the document behind each path, and that address calls |
| 6 | A read returns an address in place of what is behind it |
| 7 | A replayed id returns the original result within its session, and executes as its own call in another |
| 8 | A piece result survives `plainResultReceipts=false`; a plain record does not — and the write lands either way |
| 9 | A value-less verb settles with the empty witness |
| 10 | A refused call does not spend its invocation id |
| 11 | Reading a verb redirects to `cf piece call` |
| 12 | Timings on stderr, Invocation JSON still clean on stdout |
| 13 | An invocation id without a session is refused, and the refusal says how to mint one |

## Addressing a piece you were handed

A result carrying a piece gives you the piece's **value**. Calling a verb *on*
that piece needs its address, and `--show-links` supplies it: a dictionary of
RFC 6901 pointers into the result, each naming the document behind that path.

```bash
cf piece call --show-links --piece <board> createNote '{"title":"Notes"}'
```

```json
{
  "status": "settled",
  "result": { "note": { "$NAME": "Notes", "…": "…" } },
  "links": {
    "/": { "space": "did:key:…", "id": "of:receipt…", "scope": "space" },
    "/note": { "space": "did:key:…", "id": "of:fid1:…", "scope": "space" }
  }
}
```

`/note` is the created piece's own document, so it addresses directly:

```bash
cf piece call --piece <the id from /note, without the of: prefix> \
  append '{"text":"second line"}'
```

Entries appear only where a path's backing document differs from its enclosing
one, so a chain of references annotates each hop exactly once. The walk stops at
any non-plain object: a live runtime object reached through a result gets its
own entry and nothing below it, because its properties belong to the runtime
rather than to the result.

The links describe whatever result you were handed, so a projection composes
with them: a path `--select` or `--schema` dropped simply gets no entry.
`--filter` is refused alongside `--show-links` — a predicate leaves the elements
it keeps at positions that are no longer the ones they came from, and every
address below a filtered array would name the wrong element.

A pattern should not mint identifier fields to make any of this easier —
rendering identity is the client's job, and a pattern-authored fid is a copy
that can go stale.

### Asking a read for an address

A cell is a point in a graph, so a read that does not say where to stop follows
links onward and hands back a copy of everything behind them. A projection says
where to stop: a marked position returns that position's address rather than
its contents. A field list marks with a trailing `@`, and a JSON Schema marks
with `{"$link": true}`.

```bash
cf piece get --piece <board> notes \
  --schema '{"type":"array","items":{"$link":true}}'
```

```json
[
  { "$link": { "id": "of:fid1:…", "space": "did:key:…", "scope": "space", "path": [] } }
]
```

Those four fields are always present, so a caller indexes them without
branching. `id` keeps its scheme, because the scheme is the kind and dropping
it retargets the address silently. No schema is inlined: a stored link can
carry an entire one, and what was asked for is where the value lives.

Marking a position deeper than a link names the linked document and the path
below it — `notes[0].title`, where `notes` holds links, renders the note's own
`id` with `path` `["title"]`. A link is a durable identity; the slot that holds
it stops naming the same value the moment the collection is reordered.

The marker sits beside a projection when both are wanted, and the answer
carries both:

```bash
cf piece get --piece <board> notes --schema \
  '{"type":"array","items":{"$link":true,"type":"object","properties":{"title":true}}}'
```

```json
[{ "$link": { "id": "of:fid1:…", "…": "…" }, "title": "First note" }]
```

A field list unions the same way, and its two paths meet at the one position.
`noteCount` is computed, so the read steps the piece to bring it up to date:

```bash
cf piece get --piece <board> --step --select 'notes@,noteCount'
```

```json
{ "notes": [{ "$link": { "id": "of:fid1:…", "…": "…" } }], "noteCount": 3 }
```

A field list applies to each element wherever it crosses an array, and an
address is one of the things it applies: `notes@` answers with the address of
each note rather than of the slot it sits in, which makes it the concise
spelling of the `items` marker above. Where the marked position holds anything
else, the address is that position's own.

The suffix is special only at the end of a segment, and `\@` writes a literal
one, so a field named `user@home` stays reachable.

A path that is only `@` names the position the read is already at, which no
field path reaches because it sits above every field. `--select '@'` returns
the source's own address in place of its contents — one per element where the
source is an array — and `--select '@,title'` returns the address beside the
title.

A marked position is not fetched — the address is stored in the document that
contains it, so a marked collection of a hundred notes costs the one read that
document already needed. Where the marker is the whole selection, nothing
behind it is read at all.

The address a marked read returns is one `cf piece call` accepts, minus the
`of:` prefix, which is the reason to ask for it.
