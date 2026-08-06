# Shaped reads and verb results

The **read layer** and **calls**, two of the three concerns in
[Reading Fabric data](fabric-read-model.md): the shared layer that turns a cell
into structured output, and what calling a verb adds on top. Read that document
first — this one uses its vocabulary. The third concern, the command surface, is
[CLI surface shape](cli-surface-shape.md).

## The shared read layer

### The problem, concretely

Ask a piece for one of its fields and you get back the data at that path:

```bash
cf piece get --piece <board> label
→ "My board"
```

Simple, because a label is a string. But most interesting fields are not
strings. A board holding notes stores each note as a **link** — a pointer to
another cell — rather than a copy of it. So reading `notes` means the runtime
has to decide how far to follow those pointers.

Today it follows them all the way. Reading a list of ten notes returns every
field of every note, plus every field of anything *those* notes point at, and so
on until the graph runs out. Two things go wrong:

- **The result is unbounded.** One read of a modest board produced over 300,000
  tokens of output.
- **Identity is destroyed.** You wanted to know *which* note was created so you
  could act on it next. What you got is a copy of its contents, with no address
  in it. There is nothing to pass to the following command.

The fix is to let the caller say how far to go, and to say "give me the address
here, not the contents."

### A read is a cell plus a shape

The unit of work is: *given a cell, and a description of what the caller wants
back, produce structured output.* Every way of arriving at a cell ends here.

That description is a **shape**. It names paths and returns the subtree at each
one. `properties` acts as an allowlist — anything you do not name is dropped,
unless you add `additionalProperties: true`.

Naming paths is what makes a shape more than an output filter. Those same paths
become the **selector**: the instruction sent to storage saying which documents
to load. So a shape does not merely trim a result that was already fetched — it
can stop the fetch from happening. Reshaping what comes back (renaming fields,
computing values) is `jq`'s job, downstream, where the data is already local.

**A shape is a schema, supplied for one read.** This is schema-on-read: a cell
carries a schema and a reader supplies one, and they are the same kind of
artifact. What differs is authority — the source's schema governs how a value is
treated, the reader's selects among what is there. A caller can lift a source
schema and prune it into a request, which is why the syntax is shared.

What a reader supplies is a strict subset, though: the annotations that decide
how a value is treated stay the source's, and the composition keywords are
unsupported. Both restrictions hold whichever syntax the reader writes in.

### What a shape can say today

There are two syntaxes, and today both ride `--schema`
(`packages/cli/README.md`, "Output Conventions"):

```bash
--select 'title,createdBy.name'                       # concise: a list of paths
--schema '{"properties":{"topic":{"properties":{"title":true}}}}'   # full form
--schema @shape.json                                  # the full form, from a file
```

The concise form is sugar for the flat case; the full form is a JSON Schema
object and is what expresses nested structure.
[CLI surface shape](cli-surface-shape.md) proposes giving them separate flags —
`--select` for the concise syntax, `--schema` for full schemas — and this
document writes them that way throughout. The measured facts at the end use
`--schema` for both, because that is the flag the measurements were taken
against.

**`--filter` is the other axis.** A shape names paths; it cannot say "only the
elements where `status == "open"`". That is `--filter`, a predicate over array
elements. The two do not collapse into one, because **filtering runs before
projection** — a predicate can inspect a field the result omits:

```bash
cf piece get ... topics --filter '.status == "open"' --select 'title,id'
```

`status` decides membership and never appears in the output. A single mechanism
would have to either leak the field or give up deciding on it. One constraint:
combined with an inline schema rather than the concise form, `--filter` requires
an array root, since the schema then describes the whole returned value rather
than each item.

There are two kinds of thing a reader's schema may **not** contain, for two
different reasons (`FORBIDDEN_PROJECTION_KEYS` and
`UNSUPPORTED_PROJECTION_KEYS`, `packages/cli/lib/piece-get-transform.ts`). Both
are checked against the parsed projection regardless of which syntax produced
it, so writing the full form does not unlock them.

**Fabric metadata is the source's: `asCell`, `default`, `scope`, `ifc`.** These
sit beside `type` inside a schema and say what the value at that position *is* —
a handle rather than a plain value, a fallback when the document is absent, which
storage partition to read, and who may see the data:

```json
"body": { "type": "string", "asCell": ["cell"], "default": "" }
```

They are the runtime's understanding of the value, not data stored in the cell,
so they are not a caller's to assert.

**Structural composition is unimplemented for caller shapes** — sixteen keys,
including `$ref`, `$defs`, `anyOf`/`oneOf`/`allOf`/`not`, the conditional
keywords, `patternProperties`, `prefixItems`, `propertyNames`, and
`contentSchema`. These are the JSON Schema features for describing *possible*
shapes — `$ref` points at a named
definition elsewhere in the document, and the combinators express "matches any
of these." Source schemas use them constantly: every named interface becomes a
`$ref` into `$defs`, and the projection resolves those while selecting. What a
caller cannot do is introduce its own. A disjunction has no single answer to
"return this subtree," so honoring one would mean picking a branch on the
caller's behalf.

### Saying which positions are addresses

Everything above selects *values*. A shape also needs to say "at this position,
give me the address rather than what is behind it."

That is what preserves identity. If a verb creates a note and the result
flattens it into its contents, the caller cannot then call a verb on that note —
there is no address to pass along. If instead the position renders as an
address, the next command can use it directly.

**A `$link` marker beside `properties`.** A position can be descended into and
rendered as an address at once:

```json
{ "properties": {
    "topic": { "$link": true,
               "properties": { "title": true } } } }
```

returning

```json
{ "topic": { "$link": { "id": "of:fid1:…", "space": "did:key:…" },
             "title": "New topic" } }
```

**Semantics: link *instead of* contents.** A bare marker returns the address and
nothing else. Address-plus-summary is spelled as two paths — `topic@,topic.title`
— which merge by union into the shape above and render as one result carrying
both. One rule, no special case: you get what you asked for, and asking for the
link is not asking for the contents.

**The concise syntax desugars one-to-one.** `createdBy.user@` rewrites the leaf in
place to `{"user": {"$link": true}}` — an annotation on the position, not a
structural change.

#### Why the marker sits at the position

The link is physically stored in the *parent* document, on the edge — which is
exactly why a list of marked addresses costs one document read. `$link: true`
beside `properties` annotates the position where the data actually is, and the
rejecting selector takes a positional instruction, so the marker maps onto it
directly.

The name says what the caller gets. Addresses are many-to-one over cells: a
holder of one cannot tell a canonical id from an alias, and nothing in normal
use requires them to. What comes back is a link to read next, not a claim about
canonical identity — and the rendered output is a link object, so the request
vocabulary matches the response.

#### Why not `asCell`

The marker is **projection-only**. Reusing `asCell` — the natural intuition,
since `@` reads as "as cell" — fails for a reason beyond the rule that bars
readers from supplying it.

`asCell` bundles two things: a traversal boundary, and a *handle contract*. What
comes back is a live cell — readable, writable, subscribable — and in a pattern,
asking for `asCell` is often how an author signals intent to mutate. A read
needs only the boundary and an address rendering.

Over a serialized channel the handle half cannot be delivered at all. A cell
does not cross a process boundary; the only faithful serialization of one is its
link. So a reader-supplied `asCell` would be a request the channel silently
degrades — a name promising handle semantics and delivering an address, which is
the same defect this work exists to remove. `asCell` also spans five variants,
only some of them boundaries; opening it to readers would import that whole
surface, and a reader asserting `writeonly` in a read is nonsense that would
then need refusing case by case.

`$link` names exactly what a serialized read can return, leaves `asCell` meaning
what it means in patterns, and keeps the rule that treatment keywords are never
a reader's at full strength, with no carve-out.

#### The mechanism already exists

A selector can be told to reject a position — load nothing there. Marked
positions get exactly that, composed into the same set of paths the projection
already builds, so the address comes back without its target being loaded. The
rejecting selector is used at roughly nine gate sites in `traverse.ts`; wiring
it into the projection's path mask is the work.

### Collections are all or nothing

A shape controls **depth** (how far in to go) and **width** (which fields to
take). It does not control how many elements of a list come back: a shape
reaching a collection takes every element that survives filtering.

`--filter` is not an exception to this. It decides which elements are in the
result at all, before any of the above applies; all-or-nothing governs how
deeply each *surviving* element expands, not how many survive. What is missing
is count-based windowing — "the first ten" — which no predicate expresses.

Two things make that acceptable at the sizes this serves. Cost is roughly
*things expanded × fields each × levels deep*, so cardinality only matters once
something is expanded — a list of marked addresses costs one document however
many entries it has, because the links are stored inline in the document being
read. And that same property makes the choice an informed one: the caller sees
every address before deciding to ask for contents.

The limit of that argument is the address list itself. Once a collection is
large enough that rendering one address per element is the payload, seeing the
count costs what the count was meant to protect against. A predicate covers much
of this — filtering down is usually available, and is the answer whenever
something discriminates the elements you want. Windowing is for when nothing
does: ten thousand entries with no predicate that selects among them. It has to
window collections of **addresses**, not only expanded ones.

### Pushing the shape into the fetch

The shape can bound network work, not just output size — but only under a
condition worth understanding.

When the runtime can build the selector *before* reading, the first storage
request asks only for the paths the shape names, and linked documents outside
that set are never loaded at all. Nothing is fetched and then discarded.

Building that selector means settling one question first: **is the value being
read an array or an object?** The same shape means different things either way.
Against an object, `title` selects that object's `title` field. Against an array,
it selects `title` from every element. Until that is known, the paths cannot
become a selector, because the runtime does not know whether to apply them at the
top level or one level down inside each element.

The answer comes from the outermost `type` in the cell's **declared schema** —
its *root container kind*. When the source carries no schema, or its outermost
type is a union such as "array or null", or is otherwise ambiguous, the runtime
falls back to loading the value first and shaping it afterwards. The projection
still returns the right answer; it just pays full loading before narrowing.

This is why a cell's declared schema matters beyond type-checking: it is what
lets a caller's shape become a fetch instruction instead of a filter applied
after the fact.

A caller's selection states the root kind too, so honoring it would let
ambiguous-root sources narrow as well — but no case has been shown that needs
it, and the source most likely to have wanted it is the receipt, which now
carries its own schema.

### An unshaped read emits the internal encoding

A read with no selection returns whatever the value serializes to, and a verb
position serializes to the runtime's own link envelope:

```json
{ "createNote": { "/": { "link@1": { "id": "of:fid1:…",
                                     "space": "did:key:…",
                                     "path": [], "scope": "space" } } } }
```

That is faithful — a verb is a channel, and a link is the only thing about it
that crosses a process boundary — but it is not a contract. The envelope is the
runtime's internal form, still selected by an experimental option
(`modernCellRep`), so a caller reading it builds on an encoding that can be
replaced underneath them. A declared shape is what turns the same information
into something a caller may depend on, which is why a rendered address has one.

## Calls, layered on the read layer

### What a call adds

When you call a verb, the runtime runs it and writes whatever it returned into a
new cell called the **receipt**. Reading the result of a call is therefore
reading that cell — an ordinary read, on a different starting point.

What genuinely belongs to the call, and to nothing else:

- **The envelope** — the `invocation` id, `status`, the receipt's address, and
  whether this attempt was deduplicated.
- **Safe retries** — calling again with the same invocation id returns the
  original outcome instead of running the verb a second time.
- **Collecting later** — dispatching without waiting, then picking the result up
  afterwards.
- **Recovering an address** — deriving where a receipt lives from the piece, the
  verb, and an invocation id the caller chose in advance, for when the response
  was lost.

Everything inside `result` is the read layer. A call should gain `--select`,
`--schema` and `--filter` by reusing the shared implementation, not by growing a
second one.

### Receipts carry a descriptive schema

A receipt is an ordinary cell, and like any other it should say what it holds.
Today it does not: receipts are created with no schema argument
(`handleJavaScriptHandlerResult`, `packages/runner/src/runner.ts`), so the
stored document carries an empty `schema` field. Two consequences follow, and
both are the read layer's mechanisms failing to engage rather than anything
special about receipts:

- The fetch narrowing above cannot engage, so a shape is applied after
  everything has been loaded.
- A caller's shape is matched against the runtime value rather than against a
  declaration — field names that happen to coincide, rather than a subtree of a
  declared structure.

Giving the receipt cell a schema addresses both. It goes in the durable schema
metadata — `setMetaRaw("schema", …)`, the field `piece get` reads back through
`asSchema` — not the schema argument to `getCell`, which seeds the link scope
and the in-memory cell only. The receipt is minted before the handler runs, so
there is no shape at that moment; it is written at result-write time, in the
same create-only transaction, from the value the runtime is already holding.

What is recorded is **descriptive**: what this receipt holds, never a contract
constraining anything later. That is a safe thing for a write-once document,
where description and authority cannot diverge.

This is **not** the same as emitting a declared result schema for a verb, which
is deferred to the Fabric-types stream design. That would be a published
contract: compared across pattern versions by the schema compatibility gate, and
permanent once shipped. A receipt's schema is per-invocation and describes what
that one receipt holds. The gate compares only a pattern's argument and result
schemas between two versions (`assertPatternSchemasBackwardCompatible`,
`packages/piece/src/schema-compatibility.ts`) and never reaches a receipt, so no
permanence obligation attaches. When declared result schemas do arrive, the same
slot takes a better-sourced value — a change to one argument, not a migration.

Discoverability is a separate gap that this does not address: a caller still
cannot learn a verb's result shape before calling it, and the interim answer
remains prose in the verb's description.

### What dissolves, and what survives

`cf piece get` already reads a receipt — its target is a cell, a receipt is a
cell, and `--schema` projects it correctly. Once `--piece` accepts the `of:`
address form, reading a receipt directly is an ordinary read and needs no
command of its own.

What survives as genuinely verb-specific is **reconstruction**: turning a piece,
a verb, and a caller-chosen invocation id into an address, for when the response
was lost and no address was kept. That is deriving an address, not reading one,
and it is what earns a verb-aware command.

## Measured facts

Recorded so they are not re-derived. Observed against a running local server
unless noted.

**Addressing**

- The function that fetches a piece's result returns the piece unchanged
  (`PieceManager.getResult`, `packages/piece/src/manager.ts`) — a piece *is* its
  result cell, and the read path checks nothing piece-specific. Its counterpart
  `getArgument` follows a link stored in the document and throws when absent,
  making it the only piece-shaped operation of the pair.
- `cf piece get` against a receipt address returns its value, and
  `--schema note.title` projects it to `{"note": {"title": …}}`.

**Documents and links**

- A piece's stored document is `{argument, internal, patternIdentity,
  patternSetupIdentity, schema, value}`. A plain-data target is `{result,
  value}`; a bare indirection is `{value}`. `patternIdentity` is therefore a
  positive marker that a link points at a piece — at the cost of reading it.
- A stored link carries `{id, path, scope}`, plus sometimes `space` and
  sometimes a schema. `overwrite: "redirect"` appears on links to children and
  links to plain fields alike, so it distinguishes nothing.
- A link to a child piece has an empty `path`; a link to a field within a
  document carries one. Observed across two fixtures at every link position,
  including a field deliberately declared as a cell over plain data, whose link
  carried a path and whose target had no `patternIdentity`.
- One link was measured carrying an entire result schema with its `$defs`, which
  is why a rendered address must never inline a schema.

**Schemas**

- A verb declared as `Stream<Event, Result>` compiles the event type and drops
  the result type. The emitted property is the event schema plus
  `asCell: ["stream"]` — nothing describes the result.
- `asCell` is not one concept: `["cell"]`, `["stream"]`, `["opaque"]`,
  `["readonly"]`, and `["writeonly"]` all appear, and only some are boundaries.
  A writable array places `asCell` on the array itself, leaving its items plain.
- A sub-pattern instance cannot be declared as a cell — it lacks the cell
  surface — while a cell handle cannot be declared as its plain type. So the
  cell wrapper is expressible for exactly the values that are *not* child
  pieces.
- Of the shipped patterns, four verbs declare a result type and one returns a
  reference.

**Rendering**

- An unshaped read renders a verb position as the runtime's link envelope,
  `{"/": {"link@1": …}}` — faithful, but the internal form rather than a
  declared one.

## Open questions

**What a receipt's schema should record.** The root container kind alone is
enough for narrowing to engage; a verb's result is a record, so
`{"type": "object"}` would do — assuming a non-record return is impossible,
which the contract has not been checked for.

Recording the full structure — including which positions hold links — is what
makes a reader's selection match a declaration rather than coincide with a
runtime value, which is the second reason for giving receipts a schema at all.
The cost is deriving it from the value at write time rather than writing a
constant.

One detail either way: a link position in a source schema is spelled `asCell`,
and `["cell"]` asserts a writable handle on a document nothing can be written
through. Whether a receipt should say that, something narrower, or nothing about
link positions, is open.

**Should an invocation id be namespaced by its caller?** Nothing in a receipt's
address identifies who called: a supplied id is hashed together with the stream
link, so it is namespaced per verb binding but not by principal — no DID or
session enters the hash. An invocation id is therefore a read key shared by
everyone using that verb in that space. Two callers picking the same id read one
receipt, and a guessed id reads someone else's result.

Adding the caller's DID to that hash is mechanically cheap — identity into a
hash that already exists. The cost is that it changes deduplication semantics
and breaks deliberate id-sharing between agents, if that is worth keeping. The
consequences and the three ways out are worked through in
[Verb calls: working notes](verb-result-selection.md).
