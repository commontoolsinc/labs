# Shuttle — line grammar and place resolution

Satellite of [`README.md`](README.md): the command line's shape, how
references resolve against the place, what listings show, and the write and
redirection surface. Ruled points are stated plainly; anything marked
*proposed* awaits a ruling.

## The line

```text
<verb> [reference] [arguments…] [options…]
```

Navigation verbs are shuttle-native: `cd`, `ls`, `pwd`, `watch`,
`unwatch`, `watches` (`cd -` returns to the previous place). Data verbs
are `cf`'s own — `get`, `set`, `call`, `wish`, `verbs`, `describe`, … —
accepting their existing
read and projection options (`--filter`, `--select`, `--schema`, `--json`),
with the place supplying target options. `!` marks "this runs on the local
machine" everywhere it appears: line-initial `! <cmd>` runs any local
program, `|!` is the same escape in a pipeline, and `!cf …` is the special
case that also injects place-derived flags.

## Splitting the line

`cf` never splits a line: it is handed `Deno.args`, already split by the
operating system's shell, and the reference grammar it reads those words
through has no rule for one. Shuttle is handed the line itself, so the split
is shuttle's, and it is POSIX's:

- **Whitespace separates tokens**, and a run of it separates no more than
  one. Whitespace is JavaScript's own class, which is what `trim` removes,
  so a no-break space and the Unicode line separator separate a line as a
  space does — a reader cannot see either, and the realistic way an operand
  acquires one is a paste out of a document. The pair stays consistent about
  them: what separates here is what the printer quotes, so a value holding
  one still reads back whole.
- **Single quotes are literal**: what sits between them is the token's,
  whatever it is.
- **Double quotes group**, and a backslash between them escapes a double
  quote or another backslash and is otherwise a character of the token, so
  `"C:\path"` keeps its backslash. Outside quotes a backslash escapes
  whatever follows it.
- **Runs that touch are one token**, so `a"b c"d` is `ab cd`, and an empty
  pair of quotes is a token that is the empty string.
- A quote that never closes, and a trailing backslash with nothing to
  escape, are refused with the reason. Nothing else refuses a line: one
  that splits says only that, and whether its tokens name anything is
  every later reading's question.
- **A line is one line**, and a terminator on it is whoever read it to
  strip. Line terminators are in the separator class, so text carrying one
  splits across the break into a single run of tokens: a pasted second line
  arrives as more operands of the first command rather than as a command of
  its own. That is a choice and not a necessity — every value the printer
  writes that holds a line break lands inside quotes, so refusing an
  unquoted one would leave the round trip below whole. The round trip says
  the choice is safe, not that it was forced.

Quoting is what makes a value holding whitespace one operand, which is what
the write surface below needs. `set draft '{"title": "a b"}'` is three
tokens; the same line with the quotes left off is four, and the JSON's own
quotes come off two of them, so what `set` would read is `{title:` rather
than an object. A verb reads a token, and nothing reassembles one.

**On output, a value is printed as a token**: bare where nothing in it would
end the token early or read as structure, and quoted where something would.
GNU `ls` has printed names this way since 8.25, so the habit is already in
every terminal user's hands, and the point of it is that the common case
stays bare — a slug, a handle, a flag and a path each print as themselves.

What forces quoting is whitespace, either quote, the backslash, and the
characters this grammar spends on structure rather than on data: the pipe,
the `!` that marks a local program, the two redirection operators, the `#` a
wish target and an argument suffix are written with, and the `%` a numbered
handle is. Each is ruled elsewhere in this document; collected here, they
are the set a printed value is held against, and a value holding one is
quoted wherever in the value it sits — a printer is handed a value and no
position, so it quotes on the character rather than on the reading.

The characters an operand writes an address with — the `/` between segments,
the `@` of a scope suffix, `-`, `..` — are deliberately not in that set, and
that exclusion is what makes the output rule worth having rather than a
detail of it. Those characters are read inside a token by the place
resolution below rather than by the split, so quoting on them would buy the
split nothing and would cost the bare printing of every handle, every slug,
every path and every flag — which is to say nearly everything shuttle
prints, leaving nothing conditional about conditional quoting.

Some characters this grammar spends on structure are left out all the same,
and the same cost is the reason. `:` marks a scheme and the `x:` base, and
it also sits in every handle — `of:fid1:…` — so reserving it would quote
every reference that prints. `-` is the previous place and the stdin
sentinel, and it opens every long flag. Each of them is read at the head of
an operand, or as the whole of one, rather than by the split, which is what
puts them with the address characters rather than with the reserved ones.

The two halves are one decision: what the printer writes, the split reads
back as the one value it was given. That is the whole of the guarantee, and
it stops there: **a quote reaches no reading**. The split returns plain
strings, so a reading sees the characters a token holds and never how they
were delivered, and `cd '..'` and `cd ..` are one operand. What names a key
whose own characters a reading would take is therefore a different spelling
rather than a different quoting — the reference below, which reads none of
the relative readings — and that is what a listing prints for such a row.
Ruling the other way has a known shape and a known cost: the split would
start carrying which parts of a token were quoted, which grows the value it
returns rather than adding a layer over it, and every reading that consults
quoting reads that value.

## Place resolution

A reference on the line resolves against the place, right-anchored, exactly
as the canonical grammar's context rule already works:

- `/of:…` — a **rooted** reference: it names the piece and path from the
  root, so no part of the position is read from the place — but it omits
  the space and the scope, and the place supplies both. Rooted is not
  place-independent.
- `/@did:key:…/of:…` — a **complete** reference: piece, path and space are
  its own, and the scope is still the place's. It is place-independent in
  one dimension and not in the other, so the same string read at `@user`
  and at `@session` names two different cells. Denoting is not reaching,
  either: a connection serves one space, so a reference naming a different
  space than the place's is refused rather than followed —
  `validateEmbeddedSpaces` (`packages/cli/lib/llm-friendly-ref.ts`) already
  holds `cf` to that, and shuttle v1 holds one connection.
- `/@did:key:…/of:…@scope` — a **fully qualified** reference: every level
  is its own and nothing is read from the place, so it denotes the same
  cell read from anywhere. This is the form a printed address or a shared
  link should be, and it is what `pwd` prints, for that reason.

  The scope a complete reference omits is not a hole in it. Canonically an
  absent suffix *means* the base, which is why the serializer writes none
  for a base-scoped link. The two layers read the same absence differently
  — canonical says base, shuttle fills it from the place, the way a shell
  reads a relative path — and that difference is why `pwd` writes the
  suffix rather than trusting it to be inferred.
- `#…` — a wish target (entry point), resolvable from anywhere within
  the connected space. A target anchored elsewhere — profile and
  favorites resolve against the reading identity's home space regardless
  of the connected space (`packages/cli/lib/wish.ts`) — is refused with
  the reason in v1, which holds one connection to one space.
- `/` — the space's own root, the leading `/` of a rooted reference
  with nothing following it; `..` — up one level; `cd -` — the
  previous place.
- Anything else — relative: resolved as a child of the current position
  (a facet at a space root, a key or index inside a piece, a slug inside
  `slugs/`).

The distinction is the parser's, not shuttle's: `parseLLMFriendlyLink`
(`packages/runner/src/link-types.ts`) takes the space as a separate
argument and uses it whenever the reference carries no `@did:key:…`
prefix, overriding it with the embedded space when one is present. A
rooted reference is therefore exactly as space-dependent as a relative
one; it is the piece and path it fixes, not the space.

How a reading is matched says where it holds.
`-` and a lone `/` are matched against the whole operand exactly, so
neither governs a segment: a key named `-` is reachable relatively
wherever it is not the whole operand. `@scope` and a lone leading `#` are
matched against the operand's head, and each takes the whole operand with
it: `cd @user/board` refuses rather than moving the scope and descending,
and `cd #favorites/topics` hands on the whole string as one target. So
each is an ordinary data character in every later segment that is data —
inside a piece. A later segment naming a piece is read by the canonical
grammar instead, so a scope suffix there moves the scope. A fragment there
is refused too, but by shuttle rather than by that grammar, which carries
the `#argument` suffix on a piece designation and would take one. `..` is
matched segment by segment as the walk splits them, so it is reserved in
all of them and a key named `..` has no relative spelling — it reaches a
place through a reference, the door that reads no `..` at all. `/` is the
separator besides, so no segment of an operand holds one, and a key that
does is spelled `~1`, which a reference unescapes and a walk does not.

The property every door is held to is that a rendering may be refused but
may never name a cell other than the one it was printed for. Characters go
missing between a place and the rendering that names it. Reading a
rendering back is a parse of a reference, which trims the string and drops a
trailing empty segment. Writing one separates its lines with a newline. Both
reach a path segment, so an empty segment, one ending in whitespace, and one
holding a line break are refused, while one that merely starts with
whitespace survives and is not. The first two are refused wherever they sit
and not only last, because `..` makes any segment the last one.

Only the newline reaches a piece that has one. The scope suffix the
rendering always writes sits between the piece and the end of the string,
so the trim takes the suffix rather than the piece, and the parse's split
at the last `@` takes the suffix's own. An empty piece is the exception,
and one fact generates it: its rendered id segment is the suffix and
nothing else, so the split finds no id in front of it and the parse refuses
the whole reference rather than handing anything back.

The piece is nonetheless held to more, for a different reason: one that is
empty, ends in whitespace, or holds an `@` is refused because no slug or
handle carries such a name. The reason covers all three. The mechanism
behind it covers two: for a piece shaped like a handle — a colon, and
twenty characters — the parse takes it, its handle test being a length rule
rather than an alphabet one, and hands back verbatim a name the `fid1`
encoding could not have produced, a rendering that round-trips exactly and
denotes nothing. That is neither a wrong address nor a dead one, which is
why the reason cannot be either. For an empty piece, and for anything
shaped like a slug, the parse refuses it already; refusing at the door
moves the refusal earlier and names the vocabulary where the parse names
only the failure.

One rule rather than three is a choice about wording, not about safety: the
redundant cases cost nothing.

**Every door holds the piece to the two vocabularies** besides, and the check
is the canonical parse's own — `validatePieceSegment`
(`packages/cli/lib/llm-friendly-ref.ts`), called rather than copied, so that a
name in neither vocabulary is refused with one sentence whichever door read
it. The doors are the reference, a walk into a piece, a target the fabric
resolved, and a settled move, which is every door a piece reaches a place
through:
`cd slugs/Board` is refused, and the reason it gives is the reason `cd /Board`
gives. That is what makes a listing's job possible: a name printed as an
operand is one `cd` takes, and a name the rule refuses is one nothing offers
an operand for.

The vocabulary rule still buys no guarantee that every rendering is
followable, and it and the rendering rules above catch different names. A
handle-shaped piece holding an `@` or ending in whitespace is caught by the
rendering rules above rather than by the vocabulary, `isPieceHandle` being a
length rule that takes either; and a path segment holding a `#` reaches a
place under the readings below and renders as a reference the parse then
refuses.

A segment lifted out of a rendering is an operand in its own right, so
these readings decide it rather than the key it was printed from.

The `#` character has three readings, and they share nothing but the
character. A lone `#name` token is a wish target, as above. `#argument` is
a suffix on a target, whichever way that target is written — a reference, a
bare id, a slug — and it selects the piece's arguments cell, the same
selection `--input` spells as a flag. `splitArgumentSuffix`
(`packages/cli/lib/llm-friendly-ref.ts`) is that one reading: it takes the
suffix off before anything parses what it followed, and refuses every other
fragment. And inside a piece `#` is an ordinary character of a data key,
under the rule above: the wish reading is decided on the whole operand, so
it governs the head and nothing else.

Those two readings between them leave one key with no **direct** spelling. A
key whose *first* character is `#` is a wish target when it is the whole
operand, and a reference carrying a `#` anywhere is refused, so neither door
names it on its own. Some multi-segment operand still reaches it — `#` is data
in a segment that names a data key, and `slugs/board/#key` names it from the
space root — and which routes reach it from where is not characterized here. That is
what the quoting ruling above costs: the key is reachable by a route rather
than by a name, and a listing prints no name for such a row, a row's name
being what it is called and not how to get to it.

A container renders without the leading `/` that marks a reference, so a
space root and a facet cannot be read back as a piece whose slug happens to
match their name; `cd` refuses such a rendering rather than following it.

A place is **result-rooted**, and holds exactly space, piece, path, and
scope. `cd` refuses a target carrying `#argument`, in every spelling that
takes one, rather than dropping the suffix silently: a place that could
root at the arguments cell would leave every later relative read ambiguous
about which side of the piece it addressed, and the prompt would have to
carry the distinction for as long as you stood there. Arguments are
reached per operand instead — `get topics/3#argument`, and `--input` on
the `cf` verbs that take it — so the choice is one visible token at each
use.

## The space root and facets

A space root lists **facets**, never pieces directly — a populated space is
too large for a flat root. The starting facet set:

- `slugs/` — the slug index: named pieces, the primary human view.
- `pieces/` — pieces by id.

A `fuse/` facet mirroring the FUSE layout is designed and deferred past v1
([`futures.md`](futures.md)); shuttle leverages `packages/fuse`'s naming
and hydration work regardless of when that facet lands.

Facet names are reserved segments at the space root only; inside a piece
no name is reserved at all, and a facet name is an ordinary data key
there. The readings above are spellings rather than names, and are what
they are wherever a piece's path admits them. A piece's callables need
no reserved name: they surface inline in listings, annotated as
callable, exactly as the FUSE layout marks a handler an executable file
inside the piece's tree (and the `verbs` verb lists them on demand).

The facet set stays deliberately small; growing it is a design decision,
not a convenience.

## Listings, pagination, search

`ls` lists what stands at the place: a space root's facets, the slugs the
space's index records, the space's pieces, or the keys directly under the
cell the place names. A row that failed on its own account is still a row —
a slug the index names and nothing resolves is a name the space has — so it
carries what went wrong rather than being dropped, and one failed row never
takes the listing down with it. A read that failed outright is no listing at
all and raises.

A listing says what it is a listing of wherever its rows are not everything
standing there. `slugs/` is the case that has such a bound: the index names
slugs assigned since it existed, so a slug it never recorded still resolves
and is not listed (`listSlugs`, `packages/piece/src/slugs.ts`), and a listing
that implied completeness would be false.

**Every name a listing prints is one `cd` takes back to that row**, and a row
it has no name for prints none at all. Most rows print their own name,
written as a token by the rule above — a slug, a handle and an ordinary key
each print as themselves. A row whose name's own characters are readings —
a key called `..` or `-`, one holding the separator, one beginning with `@` —
prints the reference that names it instead, which reads none of them and
unescapes `~1`.

The name is the first thing on its line, and the whole of it where the row
has nothing else to report. What a reader copies off the front is therefore
what `cd` takes, and that is the claim rather than anything about the whole
line: an error written after a name is text the fabric produced, and an odd
quote in it leaves the line as a whole refusing to split.

A row with no name prints a marker in its place, and says no more than that:
a key whose first character is `#` is reached by a route, as above, and a
listing prints names rather than routes. Everything on a listed line that is
not a name is written between angle brackets. A name holding an angle bracket
is printed quoted, the grammar reserving it, so a line opening with `<` carries
no name — while a marker's own payload is not escaped, those brackets
delimiting for a reader and not for a parser. Nothing parses a listed line.

A row is one line, and the lines are separated by a newline, so a name holding
one is described rather than written and a message holding one has it written
as a space. The newline's is the only rewrite there is, so a carriage
return and the Unicode line and paragraph separators are printed as they
stand, because a name is printed to be typed back and a rewritten one no
longer names its row — a carriage return returns a terminal's cursor to the
start of the line, and that is a thing a terminal does rather than a thing the
name says, the same bound the rendering of a place is held to.

Large collections appear everywhere (a space's pieces, an array of
thousands). `ls` prints one height-fit page — what the terminal shows
minus chrome, `--limit` overriding — plus a status line
(`412 items — more, or browse`), and never takes the screen over
uninvited, so piped output stays clean by construction. `more` continues
the same listing and its numbering (`%39`…`%76`); backward at the prompt
is scrollback's job, and real two-way navigation is `browse`'s.
A `search <query>` verb at any place is designed and deferred past v1
([`futures.md`](futures.md)); pipes over `ls` cover the interim.

Listings number their rows, and numbered handles are references: `%1`,
`%2`, … stay valid until the next new listing resets them (`more`
continues the current one), so `cd %3` and `get %1/title` act on what a
view showed without retyping anything. Handles are how a view feeds the
next command without the view being a place; an interactive picker can
layer on later and produce the same handles.

A handle carries structure rather than a string. The listing records each
row's kind as it mints one, and for a callable row the receiver and the
verb name it stands for — which is what lets `call %4` invoke without a
hand-split reference, and lets arity resolve locally (the "Calling a verb"
section below).

**A view is not necessarily a place.** A page of results, a search hit
list, a filtered projection — these are things to look at and pick from,
and they need no path-shaped address of their own. Requiring every viewable
thing to be a place would constrain the interface for no gain. When a
derived set earns an address, that is the virtual-places extension the main
document holds open — the abstraction allows it; nothing requires it.

## Run state

Reaching in warms: `cd` into a piece, `watch` on anything inside it, or
any read aimed into it — `get topics/3/title` from the space root warms
`topics/3` exactly as `cd` would — starts the pattern in this process, and
reads are live from then on. A piece is cold only while it is merely
listed, so there is no unlabeled stored-state read path.

That is v1's whole run-state story. A **cold-browse mode** — walking with
no computation, stored reads labeled — is designed and deferred past v1
([`futures.md`](futures.md)).

## Scope is the cwd's second dimension

A cell can carry per-identity overlays — `@user`, `@session` — so the same
piece reads differently per identity (`cf inspect scopes <space>` shows that
ground truth offline). Scope is a way of seeing every place, not a
location, so the cwd is a **pair**: position and scope. Both stick while
you navigate, both render in the prompt, and `pwd` prints both.

`cd` is the door to both dimensions, applying whatever components its
operand carries: `cd board@session` is a full reference and moves position
and scope in one step, `cd topics/3` moves position alone, and `cd @session`
moves scope alone. There is no separate scope verb; the general door is
`where scope …`, like any other ambient dimension. The active scope fills
the omitted `@scope` of every reference as the place fills omitted
position levels, and an explicit suffix on an operand overrides it for
that operand alone.

A scope-only `@scope` is shuttle **navigation syntax**, not a reference. It
sits with `/`, `..` and `-`: spellings that `cd` accepts to move the cwd,
and that the canonical grammar does not parse. `parseScopedIdSegment`
(`packages/runner/src/link-types.ts`) requires an id in front of the
suffix and throws without one, so `@session` alone addresses nothing, and
`parseReferenceParts` in the same module throws on a lone `/`, which names
no piece handle, so the space root has no canonical spelling either. The
no-growth rule holds because the scope spelling never leaves the verbs that
move and print the cwd — `cd`, `where`, and `pwd`: an operand and a full
reference always carry an id, no link endpoint can hold a scope-only
suffix, and nothing serializes one. Setting the ambient scope
is all `cd @session` does, and ordinary references pick it up from there.

The canonical grammar bounds what a suffix on a reference can say
(verified against `parseScopedIdSegment` in
`packages/runner/src/link-types.ts`):

- The suffix is a `CellScope` word — `@space`, `@user`, `@session` — with
  no identity component; those are never spelled in a reference. `@session`
  and `@user` therefore mean the **reading identity's own** overlays,
  composed with the caller's identity at resolution.
- `@space` is a canonical scope value, not shuttle's addition:
  `CELL_SCOPE_VALUES` holds it beside `user` and `session`, the parser's
  rejection text names all three, and `piece1@space/path` parses to
  `scope: "space"` distinct from an omitted suffix
  (`packages/cli/test/piece.test.ts`). The base is therefore nameable, and
  `cd @space` sets the ambient scope back to it.
- The serializer never emits `@space` (the base renders as a bare id), so
  the prompt and `pwd` render the scope dimension themselves rather than
  round-tripping through the reference serializer.
- Standing in **another** identity's overlay (an `@session:<sid>`-shaped
  spelling) is not in the grammar and is out of v1. It is a
  canonical-grammar extension first — "the alias must not grow a
  capability the canonical form lacks" (`packages/cli/lib/llm-friendly-ref.ts`)
  — and a permission question besides; `cf inspect scopes <space>` remains the
  offline way to see other identities' overlays.

## The ambient context and `where`

Everything ambient is one record: the connection (api endpoint, identity),
the cwd pair (position, scope), the external working location, and the
invocation session. `where` prints the whole record, and
`where <dimension> <value>` sets the light dimensions — scope, the
external location. The heavyweight dimensions are fixed at launch in v1
and restarting is the switch; editing them live (`where api …`,
`where identity …`, rebuilding the connection) is designed and deferred
([`futures.md`](futures.md)). `cd`/`pwd` and `xcd`/`xpwd` are conveniences
over the hottest dimensions, not separate mechanisms, and launch flags
merely seed the initial record.

## Prompt

The prompt shows the position with checked names only: a space by the name
fabric knows it by, a piece by its slug when the slug index confirms it, a
shortened unique id otherwise, then the path. Shuttle uses the naming
mechanisms the fabric supports and introduces none of its own; user-managed
legible space names arrive when the fabric grows them.

A shortened id is a prefix rather than an address, and it is spelled the
way a whole handle is, so nothing in it says which it is. A prompt meant to
be pasteable has to make that fallback visibly distinct, or leave it out.

`pwd` is the complete address and has no short form. It writes the scope
even when it is the base, so what it prints denotes one cell wherever it is
read, where an omitted suffix would denote whatever the reader's own scope
selects — shuttle writes absolutely and reads ambiently, the asymmetry a
shell has between `pwd` and a relative path. Emitting the suffix only for a
non-base scope would leave the common case contextual, since a suffix-less
address read in a `@session` shuttle lands at session. The prompt is the
short surface and is on screen continuously; what `pwd` is for is the thing
you copy, so a form that cannot be pasted is the one output it should not
produce.

## Writes

- `set <path> <value>` — the value parses as JSON; a bare word is a string
  where that is unambiguous, and a value holding whitespace is quoted, being
  one token like any other operand. `set <path> -` reads stdin.
- `edit <path>` — opens `$EDITOR` on the current value, writes back on save
  (the view substrate's editing buffers already do the hard part).
- `link <target> <path>` — writes a cell reference, the fabric's link
  semantics (what FUSE spells `ln -s`). A redirect copies values; `link`
  is the only spelling that creates references, so the distinction is
  always visible on the line.

## Calling a verb

Three spellings, and no fourth:

- `call <ref> <name> [input]` — the typed form, matching `cf`'s
  (`call topics/3 add-reply '{"body":"hi"}'`), so knowledge transfers both
  ways. The input positional takes an inline JSON value or `-` to read the
  payload from stdin. The verb name opens the callable's section, so its
  schema-derived flags follow bare — `call topics/3 search --query milk` —
  and `--` closes the section. That is
  [`../cli-surface-shape.md`](../cli-surface-shape.md) step 10's form, which
  `cf` speaks as well, so the two surfaces read one grammar rather than two.
- `call <piece-handle> <name> [input]` — a piece handle stands wherever a
  typed reference stands, so this is the typed form with the receiver
  already in hand: `call %3 add-reply --body "shipped"` off a listing
  whose rows are pieces.
- `call <callable-handle> [input…]` — `call %4`, where the listing minted
  `%4` from a callable row. That handle carries receiver *and* name, so
  the name is not spelled again.

A typed path ending in a callable — `call topics/3/add-reply` — is
refused, and the error names the `<ref> <name>` form to use instead.

All three land on the resolution that exists. `resolvePieceCallable`
(`packages/cli/lib/piece.ts`) takes a receiver and a callable *name*,
resolving it against the piece's result cell, then its input cell, then
its handlers. A handle that carries the name rather than a path is what
keeps every form on that one resolution, so none of them needs a
full-path callable resolver built first.

One arity rule covers all three, and it never consults the fabric. The
typed form has a fixed shape — reference, name, optional input — and a
handle's kind is fixed when the listing mints it: a piece handle takes the
verb name in the next positional, a callable handle takes input. So
whether a positional is a name or a payload is known from the line and the
handle table alone, and nothing about parsing waits on what a reference
turns out to resolve to.

The split is the one the fabric already draws. A verb name is interface
vocabulary, not a data path — the receiver is the addressable thing, and
the name selects from what its interface offers. Keeping receiver and name
in separate slots keeps that visible on every line.

## Redirection and schemes

The ambient data plane is the fabric: redirection targets fabric paths, and
anything outside the fabric is named by an explicit scheme.

- Fabric-to-fabric redirection — `get topics/3 > drafts/copy` as a value
  copy, `link` remaining the reference-writer — is designed and deferred
  past v1 ([`futures.md`](futures.md)); the plane rules below are settled
  v1 grammar either way.
- `file:` names a local file, the only spelling that touches disk — and a
  scheme is legal only on an absolute complete path:
  `get topics --json > file:/tmp/topics.json` is fine, `file:out.json` is
  refused (`file:~/…` counts as absolute).
- `file:` is one member of an open scheme family: a schemed operand names
  something outside the fabric. `file:` is the v1 member; `https:` read
  ends are designed and deferred ([`futures.md`](futures.md)), and writing
  to an external scheme stays out of scope until a use rules it in.
- Shuttle maintains two working positions: the fabric cwd and one
  **external working location**. `xcd` sets it — `xcd file:~/data`,
  `xcd https://foo.com/a/b/` — and, its argument being already on the
  external plane, moves it with a plain relative path: `xcd ../foo`.
  `xpwd` prints it. In operands, a relative external path is rooted with
  the `x:` base — `> x:../out.json`, `< x:data.json`. `x:` is a base name
  rather than a scheme: it roots a relative path at the external location
  whatever that location's scheme, so no operand ever changes plane by
  position. A bare relative operand is always fabric.

## Pipes: escaped locals

Local programs run behind the explicit escape — `|!` in a pipeline
(`get topics --json |! jq '.[].title'`), line-initial `!` for a whole
command — so stepping outside the portable surface is always visible on
the line. Bare `|` is reserved, and its error names `|!`: the **native
tool set** — names that work bare and are guaranteed wherever shuttle
runs — is designed and deferred past v1 ([`futures.md`](futures.md)),
and reserving the spelling now means v1 teaches no invisible-local habit
the set would have to unteach.

## Open questions

**Appending to a collection.** Shuttle's write vocabulary is whole-value:
`set` writes a value, `edit` writes back the one it opened, and `link`
writes a reference. The fabric below has more than that — operation-based
append, add-unique, increment and remove-by-value, covered in
[`mergeable-collection-writes`](../../features/mergeable-collection-writes.md)
and registered by
[`patch-operations.md`](../../features/patch-operations.md) — and no shuttle
spelling reaches any of them. Adding one item to a collection is therefore
`get`, edit, `set`: the read-modify-write those operations were made
first-class to avoid.

**The `@` sigil carries two meanings.** It is the space slot of a reference
and the scope suffix on a piece: `@user` alone is the scope word,
`/@user/<handle>` is a space *named* user, and `/@user/<handle>@session` is
both at once — and space names are unvalidated, so the collision is live
rather than hypothetical. Shuttle cannot resolve it: decision 13 forbids
inventing a spelling, and a second scope spelling would be worse than the
ambiguity. Issue
[#6775](https://github.com/commontoolsinc/labs/issues/6775) carries it. In
v1 a space named by name is refused unless it resolves to the connected
space, which is what keeps it dormant; multi-space sessions are where it
wakes.

**A shortened id is not an address.** The prompt falls back to one where no
slug is confirmed, and it is spelled exactly as a whole handle is, so
nothing in it says which it is. Whether the prompt stays pasteable, and how
that fallback is marked if it does, is open — see the Prompt section above.

The base-overlay spelling is settled above. One further open item for
shuttle overall (shallow-sink expressibility) lives in
[`views.md`](views.md).
