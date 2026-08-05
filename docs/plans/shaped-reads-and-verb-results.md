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

**A shape is written in schema syntax, but it is a request rather than a
contract.** Borrowing the syntax is deliberate — a caller can lift a source
schema and prune it into a request — but the two point in opposite directions: a
source schema declares what the data *is*, while a shape asks for what the
caller *wants back*. A shape is also a strict subset, since the annotations that
give a source schema its meaning are the source's to declare and the composition
keywords are unsupported. The flag carrying it is spelled `--schema` today;
[CLI surface shape](cli-surface-shape.md) proposes `--shape`, and this
asymmetry is why.

### What a shape can say today

`--schema` accepts three forms (`packages/cli/README.md`, "Output Conventions"):

```bash
--schema 'title,createdBy.name'                       # concise: a list of paths
--schema '{"properties":{"topic":{"properties":{"title":true}}}}'   # full form
--schema @shape.json                                  # the full form, from a file
```

The concise form is sugar for the flat case; the full form is a JSON Schema
object and is what expresses nested structure. `--filter` narrows array
membership with a predicate and runs before projection.

There are two kinds of thing a caller's shape may **not** contain, for two
different reasons (`FORBIDDEN_PROJECTION_KEYS` and
`UNSUPPORTED_PROJECTION_KEYS`, `packages/cli/lib/piece-get-transform.ts`).

**Fabric metadata is the source's: `asCell`, `default`, `scope`, `ifc`.** These
sit beside `type` inside a schema and say what the value at that position *is* —
a handle rather than a plain value, a fallback when the document is absent, which
storage partition to read, and who may see the data:

```json
"body": { "type": "string", "asCell": ["cell"], "default": "" }
```

They are the runtime's understanding of the value, not data stored in the cell,
so they are not a caller's to assert.

**Structural composition is unimplemented for caller shapes: `$ref`, `$defs`,
`anyOf`/`oneOf`/`allOf`/`not`, and the conditional keywords.** These are the
JSON Schema features for describing *possible* shapes — `$ref` points at a named
definition elsewhere in the document, and the combinators express "matches any
of these." Source schemas use them constantly: every named interface becomes a
`$ref` into `$defs`, and the projection resolves those while selecting. What a
caller cannot do is introduce its own. A disjunction has no single answer to
"return this subtree," so honouring one would mean picking a branch on the
caller's behalf.

### What a shape cannot yet say: which positions are addresses

Everything above selects *values*. What is missing is a way to say "at this
position, give me the address rather than what is behind it."

That is what preserves identity. If a verb creates a note and the result
flattens it into its contents, the caller cannot then call a verb on that note —
there is no address to pass along. If instead the position renders as an
address, the next command can use it directly.

Four spellings are available, and the choice is not cosmetic:

| Spelling | Where the address comes from |
| --- | --- |
| Omission-driven (`--add-ids`) | positions the shape did not project |
| Path list (`--id-for-paths`) | a second list, parallel to the shape |
| Marked at the position | a keyword beside `properties`, inside the shape |
| Selected as a field | a reserved name inside the selection set |

Two of them cannot do the job.

**Omission-driven cannot express the case that motivates this.** A caller
creating a topic usually wants its address *and* one field from it — the title,
to confirm the write landed. That needs both from the same subtree. If the shape
projects `topic.title`, then `topic` is on the path being traversed and renders
as a value, so no address is produced. Address or field, not both.

**A path list does not compose.** It is a second addressing language running
beside the shape, and it cannot describe nested structure the way the shape can.
It brings back path enumeration precisely where the shape exists to avoid it.

The other two both work, and both express the motivating case. They differ in
where the marker sits.

**Marking at the position** puts a keyword beside `properties`, so a position
can be descended into and rendered as an address at once:

```json
{ "properties": {
    "topic": { "$link": true,
               "properties": { "title": true } } } }
```

**Selecting it as a field** puts a reserved name inside the selection set,
alongside the fields that genuinely exist:

```json
{ "properties": {
    "topic": { "properties": { "$id": true, "title": true } } } }
```

Either returns the same thing:

```json
{ "topic": { "$link": { "id": "of:fid1:…", "space": "did:key:…" },
             "title": "New topic" } }
```

The second borrows GraphQL's selection sets, where `{ topic { id title } }`
treats identity as a field you ask for rather than a special form. It needs one
mechanism instead of two and composes at any depth with no rule about where a
marker may sit. Its wrinkle is that our documents have no `id` field — identity
lives on the link, not in the data — so the name is synthetic and sits in an
allowlist beside names that are not. Only the idea transfers, not the syntax:
the argument for schema-shaped shapes is that a caller can lift a source schema
and prune it, which a different query syntax would break.

Whichever wins, the marker must be **projection-only**, not a borrowed `asCell`.
Callers are barred from supplying `asCell` by name, alongside `ifc`; reusing it
would either breach that rule or give one keyword two meanings depending on who
wrote it.

The mechanism underneath already exists either way, and needs no new traversal
machinery. A selector can be told to reject a position — load nothing there.
Marked positions get exactly that, composed into the same set of paths the
projection already builds, so the address comes back without its target being
loaded.

### Collections are all or nothing

A shape controls **depth** (how far in to go) and **width** (which fields to
take), but not **cardinality** (how many elements of a list). A shape reaching a
collection takes every element; there is no windowing or per-element limit.

Two things make that acceptable at the sizes this serves. Cost is roughly
*things expanded × fields each × levels deep*, so cardinality only matters once
something is expanded — a list of marked addresses costs one document however
many entries it has, because the links are stored inline in the document being
read. And that same property makes the choice an informed one: the caller sees
every address before deciding to ask for contents.

The limit of that argument is the address list itself. Once a collection is
large enough that rendering one address per element is the payload, seeing the
count costs what the count was meant to protect against. Windowing becomes
necessary there, and it has to window collections of **addresses**, not only
expanded ones.

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

### Defect: an unshaped read serializes live handles

A read with no shape loads the value and serializes whatever objects it finds.
Some of those objects are live runtime handles rather than data — a verb is
represented by a stream handle that holds a reference back to the runtime. So an
unshaped read of any cell containing a verb emits the scheduler: event queues,
handler tables, and a circular reference back to the runtime, around 16–17 KB
for an otherwise two-field result.

This affects cells that *do* declare their schema, not only ones that do not:
declaring a position as a stream does not prevent it, because the source schema
governs what is read rather than what is printed. It is independent of
everything else here and worth fixing on its own — a verb's rendered form should
be a marker, not its implementation.

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

Everything inside `result` is the read layer. A call should gain `--schema` and
`--filter` by reusing the shared implementation, not by growing a second one.

### The receipt is an ordinary cell created without a schema

Receipts are created with no schema argument (`handleJavaScriptHandlerResult`,
`packages/runner/src/runner.ts`), so the stored document carries an empty
`schema` field. Two consequences follow, and both are the read layer's mechanisms
failing to engage rather than anything special about receipts:

- The fetch narrowing above cannot engage, so a shape is applied after
  everything has been loaded.
- A caller's shape is matched against the runtime value rather than against a
  declaration — field names that happen to coincide, rather than a subtree of a
  declared structure.

Giving the receipt cell a schema when it is created addresses both.

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

## Open questions

**Which spelling marks addresses in a shape.** Two of the four are ruled out
above: omission-driven cannot express an address beside a summary field, and a
path list does not compose. The live choice is between marking at the position
and selecting identity as a field. The second is the smaller mechanism; the
first keeps the selection set free of synthetic names. Decide before
implementation, since the rendered output is identical either way and only the
request syntax differs.

**Whether a caller-supplied shape may fix the root container kind.** Narrowing
keys on the *source* schema today. A caller's shape states the root kind too,
and honouring it would let schema-less sources narrow. The rule barring caller
metadata covers `ifc`/`asCell`/`scope`/`default`; root container kind is
structure rather than metadata, so this may be a clean exception.

**Whether creating receipt cells with a schema is acceptable**, given the
compatibility gate does not reach them and the Fabric-types work would supersede
the source of that schema rather than the slot it fills.

**Invocation id namespace.** Nothing in a receipt's address identifies who
called. The address is derived from the verb's graph position plus the caller's
id string verbatim, so an invocation id is a read key shared by everyone using
that verb in that space: two callers picking the same id read one receipt, and a
guessed id reads someone else's result. Pre-existing, and reachable once
receipts are read deliberately. The consequences and the three ways out are
worked through in [Verb calls: working notes](verb-result-selection.md).
