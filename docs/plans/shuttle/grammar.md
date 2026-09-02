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

## Place resolution

A reference on the line resolves against the place, right-anchored, exactly
as the canonical grammar's context rule already works:

- `/of:…` — a **rooted** reference: it names the piece and path from the
  root, so no part of the position is read from the place — but it omits
  the space, which the place still supplies. Rooted is not
  place-independent.
- `/@did:key:…/of:…` — a **complete** reference: it carries its own space,
  so it denotes the same cell read from anywhere. Only this form is
  place-independent, and it is what a printed address or a shared link
  should be. Denoting is not reaching, though: a connection serves one
  space, so a complete reference naming a different space than the place's
  is refused rather than followed — `validateEmbeddedSpaces`
  (`packages/cli/lib/llm-friendly-ref.ts`) already holds `cf` to that, and
  shuttle v1 holds one connection.
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

Where a reading is decided says where it holds. `-`, `@scope`, `/`, and a
lone leading `#` are read on the whole operand before it is split, so each
governs the operand's head and is an ordinary data character in every later
segment. `..` and an empty segment are read segment by segment, so they are
reserved wherever they appear — which is why a key named `..` has no
relative spelling at all, while a key named `-` has one in any position but
the first.

The `#` character has three readings, and they share nothing but the
character. A lone `#name` token is a wish target, as above. `#argument` is
a suffix on a reference and only that — it selects the piece's arguments
cell, the same selection `--input` spells as a flag
(`normalizeLLMFriendlyRef` in `packages/cli/lib/llm-friendly-ref.ts`, which
strips it before the runner grammar sees the string, and refuses every
other fragment). And inside a piece it is an ordinary character of a data
key, under the rule above: the wish reading is decided on the whole
operand, so it governs the head and nothing else.

A place is **result-rooted**, and holds exactly space, piece, path, and
scope. `cd` refuses a reference carrying `#argument` rather than dropping
the suffix silently: a place that could root at the arguments cell would
leave every later relative read ambiguous about which side of the piece it
addressed, and the prompt would have to carry the distinction for as long
as you stood there. Arguments are reached per operand instead —
`get topics/3#argument`, and `--input` on the `cf` verbs that take it — so
the choice is one visible token at each use.

## The space root and facets

A space root lists **facets**, never pieces directly — a populated space is
too large for a flat root. The starting facet set:

- `slugs/` — the slug index: named pieces, the primary human view.
- `pieces/` — pieces by id.

A `fuse/` facet mirroring the FUSE layout is designed and deferred past v1
([`futures.md`](futures.md)); shuttle leverages `packages/fuse`'s naming
and hydration work regardless of when that facet lands.

Facet names are reserved segments at the space root only; inside a piece,
every segment is data — always. A piece's callables need no reserved name:
they surface inline in listings, annotated as callable, exactly as the
FUSE layout marks a handler an executable file inside the piece's tree
(and the `verbs` verb lists them on demand).

The facet set stays deliberately small; growing it is a design decision,
not a convenience.

## Listings, pagination, search

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

## Writes

- `set <path> <value>` — the value parses as JSON; a bare word is a string
  where that is unambiguous. `set <path> -` reads stdin.
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

None here — the base-overlay spelling is settled above. The remaining
open item for shuttle overall (shallow-sink expressibility) lives in
[`views.md`](views.md).
