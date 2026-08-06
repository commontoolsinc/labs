# CLI surface shape

The **command surface**, one of the three concerns in
[Reading Fabric data](fabric-read-model.md), which defines the shared model. The
`cf` surface grew one command at a time and now expresses a model the code no
longer has. That costs more than tidiness: the names imply distinctions the runtime
does not make, which misdirects design work before it starts.

This document is about the command surface, not the machinery underneath.
Nothing here blocks [Shaped reads and verb results](shaped-reads-and-verb-results.md).

## What the surface is for

Sorting commands by what they are for makes the trouble visible. Seven
purposes, and one command — `view` — genuinely straddles two of them, which is
itself part of the problem.

| Purpose | Commands |
| --- | --- |
| **Authoring** — work on source files, never touching a live space | `check`, `test`, `view` (pager), `init`, `deps update` |
| **Identity and access** — who you are, and who may do what | `id` (new/did/derive/from-mnemonic), `acl` (ls/set/remove) |
| **Live data** — reading and writing running state | `piece get`/`set`/`call`/`apply`/`link`/`step`/`verbs`/`inspect`, `wish` |
| **Piece lifecycle** — deploying and managing running programs | `piece new`/`setsrc`/`getsrc`/`rm`/`ls`/`search`/`map`/`set-slug`/`recreate-root`/`set-home` |
| **Rendering** — turning things into something to look at | `piece view` (terminal), `piece render` (HTML), `view` (source pager) |
| **Storage forensics** — reading the database directly, offline | `inspect` (22 subcommands), `space` (clone/verify/reset/fingerprint) |
| **Filesystem projection** — exposing cells as files | `fuse` (mount/unmount/status), `exec` |

Four of these are coherent and want nothing: authoring, identity and access,
storage forensics, and filesystem projection. The trouble is concentrated in the
middle three.

## Where it has accreted

**`piece` carries four unrelated jobs.** Deploying a program, listing what is
deployed, reading live data, and rendering a UI all hang off one word. Someone
reading a value and someone deploying a pattern share a command prefix and
nothing else.

**Names imply distinctions the code does not make.**

| Surface | What the name says | What it actually is |
| --- | --- | --- |
| `--piece` | a piece | any cell address — the function that fetches a piece's result returns the piece unchanged, and the read path checks nothing piece-specific |
| `piece get` | reading a piece | reading a cell at a path |
| `--input` | a mode you switch on | an address — it follows a link stored in the document to reach the arguments cell |
| `--schema` | one input format | two — a full schema, and a concise path shorthand that is not a schema |

The `--piece` case is not cosmetic. Believing the target had to be a piece is
what made a verb's receipt look like it needed purpose-built read machinery,
when it is an ordinary cell that any read already handles.

**One word, two jobs — twice.** `piece inspect` examines a running piece, while
`cf inspect` reads the database offline and has its own `piece` subcommand.
Separately, `piece view` prints an ASCII rendering of a piece while `view` is a
pager for source files. `piece map` and `cf inspect graph` both draw the graph
of entities and their connections — one live, one offline.

**Two commands, overlapping but not equivalent.** `piece apply` validates a
whole input against `argumentSchema` and re-executes the pattern with it; `piece
set` writes at one path. Both target the arguments cell, and the overlap invites
merging them, but they are not the same operation — which is why any merge
belongs in the last step rather than among the renames.

### One flag, two syntaxes

`--schema` takes two different things, and that is what makes it confusing —
not that it takes a schema.

Schemas are queries here. The schema-on-read principle runs through the whole
system: you describe the shape of the data you want, and that description
decides what is loaded. A reader supplying a schema is doing exactly what a
subscription does. So the flag's *full* form is a schema in good standing, and
the syntax should stay schema-shaped so a caller can lift a source schema and
prune it into a request.

The **concise** form is a different thing wearing the same flag:

```
--schema 'title,createdBy.name'                        # a path list
--schema '{"properties":{"title":{"type":"string"}}}'  # a schema
```

The concise form is a shorthand, and it exists because full schemas are verbose
enough that nobody writes one to select two fields. It is modelled on
[`llm`'s schemas](https://llm.datasette.io/en/stable/schemas.html), which is
worth recording so the next reader does not have to re-derive why it looks the
way it does.

`llm` keeps both syntaxes under one flag, so one flag is livable on its own
terms. What makes the split worth it here is that **our shorthand is growing
notation that is not schema syntax at all** — a suffix marking a path as an
address, below — and a separate flag gives that room without each addition
needing a justification as a schema dialect. A reader who sees
`--schema title,createdBy.name@` and asks "how is that a schema?" is right, and
will get righter.

**Give the concise syntax `--select` and leave `--schema` for full schemas.**
That resolves the ambiguity rather than papering over it, and it leaves room for
the
shorthand to grow notation a schema does not need — a suffix meaning "give me
the link at this path rather than its contents" is the obvious candidate, since
that is the common case and spelling it in full is painful.

`--select` is the name because it says what the syntax does, reads naturally
with the address suffix (`--select 'topic@,topic.title'`), and leaves "shape"
free as the word for what a caller asks for — covering both spellings rather
than competing with one of them.

Timing argues for doing it now: `piece call` does not have either form yet, so
splitting them costs one deprecation on a flag that is still young.

**What a reader may not supply, in either syntax.** `asCell`, `default`,
`scope`, and `ifc` stay the source's — they decide how a value is treated, not
which values come back. `$ref`, `$defs`, and the combinators are unsupported.
Both checks run against the parsed projection whatever syntax produced it, so
writing the full form does not unlock them.

That rule needs no carve-out for the address suffix. `asCell` carries a handle
contract as well as a boundary, and a handle cannot cross a serialized channel —
so a reader supplying it would be asking for something the channel silently
downgrades to an address. The suffix desugars to a projection-only `$link`
instead; see
[shaped reads](shaped-reads-and-verb-results.md) for the reasoning.

## What it should look like

Reading is one operation reached from several starting points, so the surface
wants one read command and distinct commands for the distinct ways of arriving:

```
# <read opts> = [--select S | --schema S] [--filter P] — identical everywhere

cf get   <addr> [path]           <read opts>
cf call  <addr> <verb> <payload> <read opts>
cf wish  <query>                 <read opts>   # a query, not an address
cf exec  <mountedFile> [args]    <read opts>   # reached through a filesystem mount

cf set   <addr> [path]                         # writes; nothing to shape

cf piece new|setsrc|getsrc|rm|ls|search|verbs|set-slug   # deploying and listing
cf space … | cf id … | cf acl … | cf fuse …
cf inspect …                                          # offline forensics
cf check | test | view | init | deps                  # working on source
```

Three properties earn their place.

**One way to write an address.** An entity id (`of:fid1:…`), a slug, or a URL,
with a suffix for navigating within it — `<addr>#argument` in place of the
`--input` flag. An address printed by one command is accepted by the next
without reshaping, which is not true today.

**Arrivals stay separate; the tail is shared.** `get`, `call`, `wish`, and
`exec` are genuinely different operations and none should absorb another.
But all of them finish by turning a cell into structured output, so they take
the same read options and an address renders the same way however you arrived at
it. A command that returns data gets the whole tail, not a subset — a result
worth shaping is a result worth filtering. `set` is the exception, because it
writes rather than returns. Today each command grew its own output handling and
they have drifted.

**`piece` keeps only what is genuinely about pieces.** Deploying, updating,
removing, listing, searching, slugs, and listing a piece's verbs. Reading and
writing cells are not piece operations and stop presenting themselves as ones.
`recreate-root` and `set-home` are space-level operations sitting under `piece`;
they belong under `space`, and moving them is part of step 7 rather than
something this shape decides.

`--select` and `--schema` everywhere, split per the reasons above.

## How to get there

Additive, in dependency order. Nothing before step 6 removes or renames anything
a caller depends on — steps 1–5 only add.

1. **Factor out the shared read step** so a single implementation turns a cell
   and a shape into structured output.
2. **Give every arrival access to it** — `piece call` gains `--select`,
   `--schema` and `--filter`, `wish` gains them, and an address renders identically from each.
3. **`--piece` accepts the `of:` address form**, so an emitted address composes
   into the next command. This is where addressing stops being piece-flavoured
   in practice.
4. **Add positional addresses and the `#argument` suffix** beside the existing
   flags, keeping both.
5. **Add `cf get`/`set`/`call`** as aliases of the existing
   implementations. Same code, honest names, both spellings working.
6. **Deprecate the old spellings** once the new ones carry traffic.
7. **Merge the duplicated nouns** — the two `inspect`s, the two `view`s, `piece
   map` against `inspect graph`, and `apply` against `set`.

Steps 1–5 are mechanical. Step 7 needs real decisions and belongs last, because
each pair is two working commands whose merge changes behaviour rather than
spelling.

**Each step carries its own documentation.** `--input`, `--piece`, and
`piece get` appear across the tutorial, `packages/cli/README.md`, and the
pattern documentation, so a single sweep at the end would leave every
intermediate state wrong. What each step owes:

| Step | Documentation owed |
| --- | --- |
| 2 | The read options gain a second host — `piece call`'s section in `packages/cli/README.md`, and [Verbs over the CLI](../common/verbs-over-the-cli.md), which is already stale |
| 3 | Address forms wherever `--piece` is taught: the CLI README and the tutorial's workflow chapter |
| 4 | `#argument` beside every `--input` example, in the same places |
| 5 | The new spellings alongside the old ones everywhere both work |
| 6 | Removal of the old spellings, once redirects have carried traffic |
| 7 | Whatever the merges decide |

**Old spellings stay as redirects, not errors, until step 6 has traffic behind
it.** A deprecated spelling that still works costs a line of aliasing; one that
fails costs every script and skill file that used it, including ones outside
this repository.

## Decisions this document does not make

**`wish` stays its own command.** A wish is a query, not an address: it resolves
to whatever satisfies it, and may match nothing. Folding it into a read over
addresses would be a category error. It shares the output step, not the way you
arrive.

**`exec` runs something reached through a filesystem mount.** Whether that
becomes an address form or stays its own command depends on how far the address
grammar should reach into the filesystem projection.

**`piece step` is not redundant with the `--step` flag.** A separate step
process cannot carry its work into a later read in another process, so the
standalone command and the flag are not interchangeable. Any merge has to
preserve that.

**`piece link` stays.** It writes a link with reactive-wiring meaning that a
general value write does not express.
