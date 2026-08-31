# CLI surface shape

The **command surface**, one of the three concerns in
[Reading Fabric data](fabric-read-model.md), which defines the shared model. The
`cf` surface grew one command at a time and now expresses a model the code no
longer has. That costs more than tidiness: the names imply distinctions the runtime
does not make, which misdirects design work before it starts.

This document is about the command surface, not the machinery underneath.
Nothing here blocks [Shaped reads and verb results](shaped-reads-and-verb-results.md).

## Where this stands — read this first

This block is LIVE: the change that moves a step updates it here, so the plan
says what the surface has rather than only what it wants. The steps themselves
are in [How to get there](#how-to-get-there); this says only which of them
have landed.

**Arc one — what the commands are called.**

| step | state |
| --- | --- |
| 1–5 — the shared read step, the read options on every arrival, `--piece` taking the `of:` form, positional addresses with the `#argument` suffix, and `cf get`/`set`/`call` | on main |
| 6a — the old spellings warn, each naming its end date | on main |
| 6b — the old spellings are removed | on main |
| 7 — the duplicated nouns are merged | not started; it is last because each pair is two working commands |

**Arc two — how a caller writes what a command acts on.**

| step | state |
| --- | --- |
| 8 — `CF_SPACE` is ambient, and a write names the space it wrote to | on main |
| 9 — a reference takes a space by name and a piece by slug, positionally | not started; lands with 11, not alone |
| 10 — the verb opens the callable's section and `--` closes it | on main |
| 11 — `--url` decomposes into the transport it names and the reference it carries | not started; lands with 9 |

## What the surface is for

Sorting commands by what they are for makes the trouble visible. Seven
purposes, and one command — `view` — genuinely straddles two of them, which is
itself part of the problem.

| Purpose | Commands |
| --- | --- |
| **Authoring** — work on source files, never touching a live space | `check`, `test`, `view` (pager), `init`, `deps update` |
| **Identity and access** — who you are, and who may do what | `id` (new/did/derive/from-mnemonic), `acl` (ls/set/remove) |
| **Live data** — reading and writing running state | `get`/`set`/`call`, `piece apply`/`link`/`step`/`verbs`/`inspect`/`get-label`/`set-label`, `wish` |
| **Piece lifecycle** — deploying and managing running programs | `piece new`/`setsrc`/`getsrc`/`rm`/`ls`/`search`/`map`/`set-slug`/`recreate-root`/`set-home` |
| **Rendering** — turning things into something to look at | `piece view` (terminal), `piece render` (HTML), `view` (source pager) |
| **Storage forensics** — reading the database directly, mostly offline (`inspect pull` fetches from a remote) | `inspect` (22 subcommands), `space` (clone/verify/reset/fingerprint) |
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
| `--input` | a mode you switch on | an address — it follows a link stored in the document to reach the arguments cell |
| `--schema` | one input format | two — a full schema, and a concise path shorthand that is not a schema |
| `--url` | a transport address | a target reference — host, space and piece in one token, and the only spelling that takes a space by name |

The `--piece` case is not cosmetic. Believing the target had to be a piece is
what made a verb's receipt look like it needed purpose-built read machinery,
when it is an ordinary cell that any read already handles.

**One word, two jobs — twice.** `piece inspect` examines a running piece, while
`cf inspect` reads the database offline and has its own `piece` subcommand.
Separately, `piece view` prints an ASCII rendering of a piece while `view` is a
pager for source files. `piece map` and `cf inspect graph` both draw the graph
of entities and their connections — one live, one offline.

**Two commands, overlapping but not equivalent.** `piece apply` validates a
whole input against `argumentSchema` and re-executes the pattern with it;
`cf set` writes at one path. Both target the arguments cell, and the overlap
invites merging them, but they are not the same operation — which is why any
merge belongs in the last step rather than among the renames.

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
enough that nobody writes one to select two fields. It is modeled on
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

Both spellings are carried on every command that reads — `get`, `call`,
`wish` and `exec` — and a command naming both is refused rather
than resolved, because it has not said which shape it wants.

**What a reader may not supply, in either syntax.** `asCell`, `default`,
`scope`, and `ifc` stay the source's — they decide how a value is treated, not
which values come back. `$ref`, `$defs`, and the combinators are unsupported.
Neither syntax can express them, though not by the same route: the checks run
when a full schema is parsed, while the concise form is held to an identifier
grammar with no way to write a keyword. Writing the full form does not unlock
them.

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
something this shape decides. `get-label` and `set-label` (#5673) postdate this
accounting: whether CFC labels stay a piece subcommand or become a surface of
their own is a step-7-class decision this document leaves open.

`--select` and `--schema` everywhere, split per the reasons above.

## Naming the target

Every read and every call names a target, and it takes three words to do it: a
space, a piece, and — for a call — a verb. How those words are spelled looks
like decoration on the layout above. It is not: it decides whether that layout
can be written at all.

### The order is a dependency chain

Each word can only be resolved once the words before it are known. A piece is
named within a space; a verb is named on a piece; a verb's fields and the shape
of its result are named by the verb.

```text
space  ->  piece  ->  verb  ->  verb fields  ->  result shape
```

Anything that resolves one of those — a caller reaching for the documentation, a
tool offering candidates, a reader making sense of a line — needs every earlier
word already in hand. So the chain is not a convention. It is the order the
words become knowable, and a layout that contradicts it is one where a stage
cannot be resolved from what precedes it.

Read the target layout against it and every element sits in dependency order,
`<read opts>` last because the result shape is knowable only once the verb is:

```text
cf call <addr> <verb> <payload> <read opts>
```

Two things follow, and they are the reason this section exists.

**The verb cannot lead.** A layout naming the verb before the address puts it
ahead of the words that say which piece it lives on, so nothing can resolve it —
including the caller. The verb goes after the address, which is where the layout
already puts it.

**The read options go after the payload, and nowhere else.** They shape the
verb's result, so they are knowable only at the end of the chain — a projection
written before the verb names positions in a result nothing has identified yet,
which is a shape the caller cannot check and a reader cannot follow. The layout
above is prescriptive on this point: `<read opts>` is a position, not an
illustration, and a projection written before the verb is refused rather than
accepted quietly.

`cf call` reads them past the `--` that closes the callable's section, which
is the position the layout names: everything between the verb and the marker
belongs to the callable's own schema-derived parser, and the read options
follow. A projection written before the verb is refused rather than accepted
quietly, so the three flags sit in the same relative place on `call` as on
`get` — after the thing they shape.

### What names a target today

Four spellings, no two of which carry the same parts:

| Spelling | Carries | Piece written as | Space written as |
| --- | --- | --- | --- |
| `--space` plus `--piece` | space, piece | a handle or a slug | a name or a DID |
| `--url` | host, space, piece | a handle | a name |
| `/@did:…/of:fid1:…` | space, piece, scope, path | a handle only | a DID only |
| positional `/of:fid1:…` | piece, scope, path | a handle only | not carried |

Two of those columns are the whole problem, and they run in opposite
directions. The alias grammar is the one a person can write — it takes a slug,
and a space by name. The canonical reference is the one that carries the most
and is meant to lead, and it refuses both: a slug in that position is turned
away with "piece references must use handles, not human names."

So the form that composes is not the form anyone types, and the form anyone
types cannot carry a space at all. Neither is a spelling a caller can learn
once.

**Terseness lives in the identifier, not in the separator.** The same piece,
three ways:

```text
  7  tracker
 51  of:fid1:pOrTkvYX-…
110  /@did:key:z6MkiAwQ…/of:fid1:pOrTkvYX-…
```

Collapsing two flags into one token saves a handful of characters. Naming the
piece by its slug saves a hundred, and naming the space ambiently saves the
rest. A combined token is worth having for what it composes — one word to copy,
one word to pass on — rather than for its length, and the short spelling a
caller wants is mostly reachable already through parts that exist.

**A separator has to be one the parts cannot contain.** A handle contains a
colon (`fid1:…`) and so does a DID (`did:key:…`), so a colon-joined
`host:space:piece` cannot be split from either end without knowing which
segments are allowed to contain colons — and a host carries a port, which is a
third. `/` is contained by none of the three, which is why the canonical
reference already joins its parts with it. Its layout is the right structure
already: right-anchored, each level to the left a broader scope, omitted levels
supplied by context, the same shape a container image reference has.

**A host is not part of the referent.** `--url` carries one because it is a
browser URL, and that conflates a transport with a thing being addressed: the
same space and piece are the same space and piece whichever host serves them.
`--api-url` already names the transport. So `--url` does not want a better
name — it wants to decompose into the two things it is carrying, and survive as
a documented convenience for pasting a URL out of a browser rather than as the
only spelling that carries a whole target.

### Three moves, which compose

**Give the space an ambient source.** A parameter that is required everywhere
and identical across a working session is one a caller should state once. This
shortens the chain by a stage, so a piece resolves from a bare command, and it
removes the most-repeated word on the surface. `wish` already reads this way.

`CF_SPACE` is where it lives, beside the `CF_API_URL` and `CF_IDENTITY` the same
builder already reads, and `--space` overrides it. It serves reads and writes
alike, which is what every comparable tool does — a namespace, a project and a
profile are each ambient for deletes as much as for reads.

**A command that writes names the space it wrote to.** A wrong space is not an
error: it succeeds against data nobody meant to touch, and removing a piece from
one is indistinguishable at the prompt from removing it from another. Naming the
space in what the command prints is a receipt rather than a prompt, so it costs
a non-interactive caller nothing and leaves a wrong space visible the moment it
happens. Nothing in this CLI asks a caller to confirm anything, and this does
not introduce the first thing that does.

**Let one spelling carry the whole target, in the form a person writes.** The
canonical reference has the right structure and the wrong vocabulary; the alias
has the right vocabulary and carries less. Closing the gap means the reference
accepts a space by name and a piece by slug — `did:key:…` and `fid1:…` are both
self-identifying, so neither can be mistaken for a name — and that a reference
may be written positionally wherever `--piece` is accepted, which a slug cannot
be today.

The reference carries cells and stops there. A verb is not one, so it stays the
word after the reference rather than a segment inside it — which is where a
caller reads it anyway, the reference already in hand by the time they write it.

That is a change to the rule that new capabilities land in the canonical form
first and an alias never leads. The rule is right about direction and this does
not overturn it: the canonical form still leads, and what it gains is the
ability to say the same things the alias already says. What would break the rule
is leaving the human vocabulary in the alias and letting the alias grow, which
is the shape the surface has now.

A reference that carries the target also collapses the chain into one word,
where every part a later segment depends on sits to its left inside the same
token. Resolving one is then the segment-at-a-time walk a path within a cell
already needs, rather than a rule about the order of separate words. And it
gives `--url` somewhere to decompose to.

**Separate the three parties on the line.** A call is read by three: `cf`
resolves the target, the callable consumes its input, and the read step shapes
what came back. The chain says they run in that order, and the layout says they
are written in that order. What is missing is the marker between the second and
the third.

**The verb opens the callable's section; `--` closes it.** A positional already
marks where the callable's vocabulary begins, so no marker is written there —
the same boundary `docker run` draws at an image name and `ssh` at a host. What
a marker is needed for is the boundary the conventional shape does not have: the
one where the callable's section ends and the read step's begins.

```text
cf call <target> <verb> <verb input>
cf call <target> <verb> <verb input> -- <read opts>
cf call <target> <verb> -- <read opts>             # a verb that takes none
cf exec <mountedFile> <verb input> -- <read opts>
```

One marker at most, and it appears only on a call that asks for a projection.

`cf exec` already read this way — its arguments written directly after the
mounted file, with nothing between — so `call` was brought to the sibling's
spelling rather than a third one being invented. It is the smaller change of
the two: what the callable's section needs is not a new boundary at its start
but a way out at its end.

**This is one rule across every command that reads.** Six carry the read
options, and they divide by whether a callable's vocabulary stands between the
command and them. `get` and `wish` have none, so nothing separates their read
options from the rest of the line. `call` and `exec` have one, so a marker
closes it:

```text
cf get  <addr> [path]           --select …
cf wish <target>                --select …
cf call <target> <verb> <input> -- --select …
cf exec <mountedFile> <input>   -- --select …
```

The read options come after the thing they shape in all four, and the marker
appears exactly where something else owns flags in between. That is one rule a
caller derives rather than two they memorize.

Every example in the documentation writes it this way, on all four commands.
The split that used to run through them was imposed by the grammar rather than
chosen, and closing it converged the surface rather than giving `call` a
spelling of its own.

**Parsing what follows the marker needs nothing new.** The tokens past it are
the read options and only those, so they parse against a command carrying just
those three. Value typing, the near-miss suggestion for a misspelled flag, and
the refusal of `--schema` beside `--select` all come from the declaration that
already exists.

**The payload is verb input, whichever way it is spelled.** Inline JSON is the
same argument as the schema-derived flags that replace it, so it sits in the
same section, and no caller has to know which spelling of an argument changes
where it goes.

**Two reasons the closing marker earns its place**, and the second is the one
that generalizes. A verb has to be named before a projection is written, both
because a result cannot be shaped before it is produced and because nothing can
offer the positions of a result it has not identified. And a projection must not
be read where a verb's fields are read, because the two vocabularies are
independent and either may grow a name the other already has.

That second reason is why the boundary is not conditional on a collision
existing today. A rule that admits a projection into the callable's section
while no field shares its name is a rule that holds until an author adds one,
and then a line that worked reaches a different reader with no edit and no
warning. The boundary is drawn whether or not anything is currently standing on
it.

**A projection is refused before the verb**, and inside the callable's section,
and reported rather than absorbed in both places.

**`--help` reaches the callable from both spellings.** Written after the verb
it falls inside the callable's section and prints that verb's own page, which is
what it does today. Written as `<verb> -- --help` — the spelling the
documentation currently teaches — it would otherwise land among the read options
and print this command's page instead, with nothing to refuse it, since `--help`
is the one flag that is never an unknown one. That shape has no competing
reading: a caller wanting this command's help writes it without a verb. So it is
given the meaning it already has, as a rule about the grammar rather than a
window that closes.

**Every way to get this wrong is answered with the line that would work.** The
vocabularies on both sides of the boundary are known — `cf`'s flags are
declared, and the verb's fields arrive with its input schema — so a name in the
wrong section is recognizable as belonging to the other one. A refusal names
which section the flag belongs to **and prints the corrected command**, rather
than reporting that a name is unknown and leaving the caller to work out where
it should have gone:

| Written | What it should say |
| --- | --- |
| a `cf` flag after the verb | it is a `cf` flag, and that a projection goes past `--` |
| a verb field before the verb | it is a field of that verb, and that fields follow the verb |
| a projection before the verb | a result has to be named before it can be shaped |
| a second `--` | one boundary follows the callable's section, and it is already drawn |

The corrected line is what makes this survivable without a warned window. Every
one of these is a spelling that worked before, so the caller reading the refusal
is someone who learned the old one — and a message that says only what is wrong
asks them to rediscover the grammar, while one that prints the line asks them to
retype it. It is also what keeps a field named for a read option from being read
as one, which is the only case here that would otherwise pass quietly.
The repository already answers this way where it matters: a mounted callable's
result reports the whole command that reads it
back rather than the address alone.

`undeclaredFlagError` is where the first of those belongs: it already answers an
undeclared name with a near miss and the vocabulary the position takes, and
already carries one special case that searches a different candidate set. A name
that is a `cf` flag is another.

The rule for `cf` is one sentence: `cf` owns the flags it declares plus the
payload spellings it already forwards, up to the first marker. A verb declaring
a field that collides with a `cf` flag reaches it past that marker, which is
where every schema-derived flag already lives.

The three moves are independent and each stands alone, but they point the same
way: a caller states the space once, names the rest in one word, and writes what
follows in the order the words become knowable.

### Alternatives, and why they are not the design

Recorded so they are not proposed again by someone reading only the outcome.

**The verb leading the line.** Naming the verb first would give every later word
a verb to resolve against, which reads like the obvious fix for a projection
that cannot find one. It puts the verb ahead of the words that say which piece
it lives on, so nothing can resolve the *verb* — and that is the completion that
works today and the one worth most.

**A distinct marker for the second boundary.** A marker unlike `--` names its
own place, where a repeat of `--` is positional. It also cannot be written where
the argument parser is still parsing: a word shaped like a flag is refused
there, including one the command has declared. So the spelling that would make
it convenient — reaching the read step with no callable section before it —
costs a split of the arguments ahead of parsing, which the repeated marker never
needs because a second `--` only ever follows a first.

**Two markers, with the verb opening nothing.** Fencing the callable's section
on both sides is symmetric and puts every vocabulary behind an explicit
boundary. It also spends a marker on a boundary a positional already draws,
which is the boundary `docker run`, `ssh` and `cf exec` all leave unmarked, and
it forces an empty section on any verb that declares no input.

**Admitting a projection into the callable's section when no field collides.**
This costs a caller nothing today and holds only until an author declares a
field of that name, at which point a line that worked reaches a different
reader with no edit and no warning.

**A colon-joined `host:space:piece`.** A handle contains a colon, a DID contains
two, and a host carries a port, so the token cannot be split from either end.

**A bare `--` before the read options on the commands that have no callable
section.** Accepting it on `get`, `set` and `wish` would make the marker a
prefix introducing the read options rather than a boundary closing a section,
which is one mental model instead of two and lets a line move between `call` and
`get` unedited. It is refused on both counts it would have to earn.

The model contradicts the one flag it cannot govern: `--help` written past the
marker reaches the callable, deliberately, so a marker that introduces read
options would have to except the one flag that is never an unknown one. And the
marker stays mandatory on `call` and `exec` whatever the markerless commands
accept, so the rule becomes optional here and required there — weaker than
*the marker appears exactly where something else owns flags in between*, which
a caller derives rather than memorizes.

What the markerless commands owe is a refusal rather than acceptance. A `--`
written on one sets every word after it aside, and an action that reads none of
them returns an unprojected value and exits zero — the same silent
reinterpretation as a field named for a read option, and the reason the marker
is refused where it closes nothing.

### Precedent worth not re-deriving

Position deciding which entity a flag applies to is well-established.
`ffmpeg` scopes options by their position relative to `-i` — the same flag
before and after names an input setting and an output setting. `ld` resolves
`-l` against the objects to its left. `git` accepts `--no-pager` before a
subcommand and not after. The pattern is ordinary; what draws complaints in
those tools is that the rule is invisible where it is broken, which is an
argument about the error message rather than about the grammar.

Handing everything after a boundary to a wrapped command is the most
conventional shape on this list, and it divides on how the boundary is drawn.
Where a positional already marks it, no marker is written: `docker run` ends its
own options at the image name, as `ssh` does at the host and `env`, `nice`,
`timeout` and `sudo` do at the command. Where no positional marks it, a marker
is required and its omission is an error: `kubectl exec … -- <cmd>`,
`npm run <script> -- <flags>`, `cargo run -- <args>`. Neither family lets a
caller choose.

A `cf` call has the positional — the verb names it — and takes the first
family's shape for that reason. What neither family has is a section *after* the
wrapped command's, which is the one boundary a marker is spent on here. The
nearest precedent is `curl --next`, which separates one request's flags from the
next's: evidence for reading a line as a sequence of sections rather than as a
nesting.

A hierarchy in one token with optional parts is equally well-trodden, and
right-anchored optionality is its usual form: a container image reference
(`registry/namespace/image:tag@digest`) defaults the registry and namespace when
they are omitted, as `scp`'s `[user@]host:path` defaults the user. `kubectl`'s
`type/name` is the same idea one level shallower.

Ambient scope with a flag override is close to unanimous among tools that
address more than one tenant: `kubectl` has a current-context namespace beside
`--namespace`, `gcloud` a configured project beside `--project`, `aws` a profile
from environment or configuration beside `--profile`.

## How to get there

Additive, in dependency order. Nothing before 6b removes or renames anything a
caller depends on — steps 1 through 6a only add, and 6a adds a warning rather
than taking anything away.

1. **Factor out the shared read step** so a single implementation turns a cell
   and a shape into structured output.
2. **Give every arrival access to it** — `cf call` gains `--select`,
   `--schema` and `--filter`, `wish` gains them, and an address renders identically from each.
3. **`--piece` accepts the `of:` address form**, so an emitted address composes
   into the next command. This is where addressing stops being piece-flavored
   in practice.
4. **Add positional addresses and the `#argument` suffix** beside the existing
   flags, keeping both.
5. **Add `cf get`/`set`/`call`** as aliases of the existing
   implementations. Same code, honest names, both spellings working.
6a. **Warn on the old spellings**, each warning naming the date its spelling
   stops working — two weeks after this step reaches main. The date is a
   literal, fixed when this step merges, not a window recomputed per run: a
   caller who reads the warning today and acts on it next week must be told
   the same date both times.
6b. **Remove the old spellings** on the date the warnings named. Done: the
   piece-mounted `get`, `set` and `call`, the 6a notice and its dated
   constant, and the parity coverage that existed only while both spellings
   did, are gone.
7. **Merge the duplicated nouns** — the two `inspect`s, the two `view`s, `piece
   map` against `inspect graph`, and `apply` against `set`.

Steps 1–5 are mechanical. Step 7 needs real decisions and belongs last, because
each pair is two working commands whose merge changes behavior rather than
spelling.

**Naming the target is a second arc, not a later step.** Steps 1 through 7
decide what the commands are called; the work below decides how a caller writes
what a command acts on. The two are independent: 6b has removed the
spellings 6a warned about, so step 10 is free to change those same commands.

8. **Give the space an ambient source** in `CF_SPACE`, with the flag overriding
   it, serving reads and writes alike; and every command that writes names the
   space it wrote to.
9. **The reference takes a space by name and a piece by slug**, and may be
   written positionally wherever `--piece` is accepted. A slug is accepted
   positionally today only through the flag, which is the gap this closes.
10. **The verb opens the callable's section and `--` closes it**, on `call` and
    on `exec`. A projection is refused before the verb and inside the callable's
    section, and each refusal names the section the flag belongs to and prints
    the corrected line. The change takes effect at once rather than through a
    warned window.

    Printing the corrected line is what carries that, and it is worth being
    exact about which case needs it. A stray `cf` flag is refused as an unknown
    read option and the message adds the spelling that works. A stray *field* is
    not always refused: nothing reserves a field name, so a verb may declare
    `select`, `filter` or `schema`, and a line whose only fields are those reads
    as a projection instead — the handler runs with different input and exits
    zero. Recognizing words after an empty callable section as fields the verb
    declares is what turns that into a corrected line rather than a quiet
    reinterpretation, and it is the same recognition the message needs anyway.
    A caller writing the new grammar never produces the shape, since fields
    before the marker leave the section non-empty. It needs the verb's declared
    fields in hand, so it settles after the schema loads rather than during
    argument handling.
11. **`--url` decomposes** into the transport it names and the reference it
    carries, and survives as a convenience for pasting rather than as the only
    spelling that carries a whole target.

Steps 8, 9 and 11 add. Step 10 is the one that changes what a written line
means, and it is the one the rest of the surface reads against — a projection
cannot be written after the verb until it lands.

**9 and 11 land together, as one change.** Step 9 on its own gives the
canonical reference a vocabulary another spelling already has and retires
neither, so the surface it leaves is the same four spellings with more overlap
between them — capability added to the accretion this document exists to
reduce. What makes 9 worth doing is 11: the reference earns the human
vocabulary so that `--url` can decompose to it and stop being the only spelling
that carries a whole target. Landed as a pair, the surface ends with one fewer
way to name a thing; landed alone, 9 ends with one more.

Their ergonomics compound the same way, and mostly outside 9. Naming the space
ambiently is step 8's, and the slug is what saves the hundred characters — so
the increment 9 adds over 8 is that a slug also works in the canonical
position, not the whole distance between the long form and the short one.

**The prior question, which this document does not answer.** Whether a
reference grammar is the right home for this at all, or whether it stands in
for a naming and resolution layer that does not exist. Everything above assumes
the canonical reference's structure is right and only its vocabulary is
missing. That assumption is worth testing before 9 and 11 are built, because a
resolution layer would make both of them smaller — or unnecessary.

The sweep step 10 carried ran to twenty-one files across `docs/`, `skills/`,
`packages/cli/README.md`, and the CLI's own tests and integration scripts — the
count is worth recording because the estimate written before it was twelve, and
`git grep -E` reads `\b` as a literal rather than a word boundary, so a pattern
written that way finds nothing and says so silently. Two of the twenty-one are
the verb session documents, whose commands `check-verb-session-sync` holds to
what the demo script runs, so those changed in the same commit as the script.

**The trailing form is taught throughout.** The read options go after the thing
they shape on every command that has them, which is what `get` and `wish`
already showed and what `call` and `exec` gained.

**Each step carries its own documentation.** `--input`, `--piece`, and
`cf get` appear across the tutorial, `packages/cli/README.md`, and the
pattern documentation, so a single sweep at the end would leave every
intermediate state wrong. What each step owes:

| Step | Documentation owed |
| --- | --- |
| 2 | The read options gain a second host — `cf call`'s section in `packages/cli/README.md`, and [Verbs over the CLI](../common/verbs/over-the-cli.md) |
| 3 | Address forms wherever `--piece` is taught: the CLI README and the tutorial's workflow chapter |
| 4 | `#argument` beside every `--input` example, in the same places |
| 5 | The new spellings alongside the old ones everywhere both work |
| 6a | The old spellings marked deprecated wherever they are taught, each carrying the removal date |
| 6b | Removal of the old spellings, and of the deprecation notes 6a added |
| 7 | Whatever the merges decide |

**Old spellings stay as redirects, not errors, until the date 6a names.** A
deprecated spelling that still works costs a line of aliasing; one that fails
costs every script and skill file that used it, including ones outside this
repository.

A DATE rather than a traffic threshold, because the traffic is not observable.
Both spellings mount the same builder and emit identical requests, and the CLI
sends nothing that would let a server attribute one to either — so measuring
adoption means adding a marker to the wire, somewhere to collect it, and a
privacy decision about a tool that runs on other people's machines. The
condition that wording implied could not be checked, only estimated.

What IS checkable is this repository, and it is a precondition rather than a
gate: the sweep in step 5's documentation row should land before 6a, so the
warning does not fire on examples we ourselves still teach. Consumers outside
this repository are unmeasurable by any means available here, which is an
argument for a generous interval rather than for instrumenting one.

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

**That the position which once worked everywhere stopped working.** The read
options could precede the positional on all six commands. A projection before
the verb is now refused, so the one spelling a caller could carry between
commands was taken away and replaced by a spelling that works on all six. That
was the trade, and it is recorded rather than left to be discovered.
