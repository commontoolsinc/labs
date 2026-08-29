# Shuttle — line grammar and place resolution

Satellite of [`../shuttle.md`](../shuttle.md): the command line's shape, how
references resolve against the place, what listings show, and the write and
redirection surface. Ruled points are stated plainly; anything marked
*proposed* awaits a ruling.

## The line

```text
<verb> [reference] [arguments…] [options…]
```

Navigation verbs are shuttle-native: `cd`, `ls`, `pwd`, `watch`, `back`
(`cd -` returns to the previous place). Data verbs are `cf`'s own — `get`,
`set`, `call`, `wish`, `verbs`, `describe`, … — accepting their existing
read and projection options (`--filter`, `--select`, `--schema`, `--json`),
with the place supplying target options. `!` marks "this runs on the local
machine" everywhere it appears: line-initial `! <cmd>` runs any local
program, `|!` is the same escape in a pipeline, and `!cf …` is the special
case that also injects place-derived flags.

## Place resolution

A reference on the line resolves against the place, right-anchored, exactly
as the canonical grammar's context rule already works:

- `/…` — absolute canonical reference; never depends on the place.
- `#…` — a wish target (entry point), resolvable from anywhere.
- `..` — up one level; `cd -` — the previous place.
- Anything else — relative: resolved as a child of the current position
  (a facet at a space root, a key or index inside a piece, a slug inside
  `slugs/`).

## The space root and facets

A space root lists **facets**, never pieces directly — a populated space is
too large for a flat root. The starting facet set:

- `slugs/` — the slug index: named pieces, the primary human view.
- `pieces/` — pieces by id.
- `fuse/` — the FUSE layout mirrored as-is (`packages/fuse`'s tree:
  `pieces/<slug>/result/…`, entities, exploded JSON). Shuttle leverages that
  package's naming and hydration work rather than reinventing it, and the
  mirror keeps the two tools mutually legible. Where shuttle has a clearly
  better presentation it lives in shuttle's own facets, outside `fuse/`.

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
`search <query>` works at any place, over what stands below it.

Listings number their rows, and numbered handles are references: `%1`,
`%2`, … stay valid until the next new listing resets them (`more`
continues the current one), so `cd %3` and `get %1/title` act on what a
view showed without retyping anything. Handles are how a view feeds the
next command without the view being a place; an interactive picker can
layer on later and produce the same handles.

**A view is not necessarily a place.** A page of results, a search hit
list, a filtered projection — these are things to look at and pick from,
and they need no path-shaped address of their own. Requiring every viewable
thing to be a place would constrain the interface for no gain. When a
derived set earns an address, that is the virtual-places extension the main
document holds open — the abstraction allows it; nothing requires it.

## Run state

Entering warms: `cd` into a piece (or `watch` on anything inside it) starts
the pattern in this process, and reads inside it are live from then on.
Pieces merely listed from outside stay cold.

A **cold-browse mode** turns warming off: walking around triggers no
computation, reads serve stored state, and the mode is unmistakably visible
in the prompt and in every view (stored values labeled as such). Toggling is
`where mode cold` and `where mode warm` (the ambient-context section below).

## Scope is the cwd's second dimension

A cell can carry per-identity overlays — `@user`, `@session` — so the same
piece reads differently per identity (`cf inspect scopes` shows that
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
sits with `..` and `-`: spellings that `cd` and `where` accept to move the
cwd, and that the canonical grammar does not parse. `parseScopedIdSegment`
(`packages/runner/src/link-types.ts`) requires an id in front of the
suffix and throws without one, so `@session` alone addresses nothing. The
no-growth rule holds because the spelling never leaves those two verbs: an
operand and a full reference always carry an id, no link endpoint can hold
a scope-only suffix, and nothing serializes one. Setting the ambient scope
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
  — and a permission question besides; `cf inspect scopes` remains the
  offline way to see other identities' overlays.

## The ambient context and `where`

Everything ambient is one record: the connection (api endpoint, identity),
the cwd pair (position, scope), the external working location, the browse
mode, and the invocation session. `where` prints the whole record, and
`where <dimension> <value>` sets any dimension — the heavyweight ones
(`where api …`, `where identity …`) rebuild the connection and say so.
`cd`/`pwd` and `xcd`/`xpwd` are conveniences over the hottest dimensions,
not separate mechanisms, and launch flags merely seed the initial record.

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

`call` keeps `cf`'s two-positional form — `call topics/3 add-reply` — so
knowledge transfers, and adds the one-reference form:
`call topics/3/add-reply` invokes the callable cell the path names,
resolving with the same defaulting as `get`. Arity disambiguates: one
reference argument invokes what the path names; a second positional is the
callable name, `cf`-style.

The path form exists because a callable is a cell like everything else —
FUSE already mounts a handler as an executable file and `cf exec` runs it
by path — and because listings surface callables inline and hand out
handles: when `%4` is a callable row, `call %4` must work without
splitting a reference by hand. This adds no reference-syntax capability;
the path is already spellable in the canonical form, and the sugar is in
the verb.

## Redirection and schemes

The ambient data plane is the fabric: redirection targets fabric paths, and
anything outside the fabric is named by an explicit scheme.

- `get topics/3 > drafts/copy` — reads one place, writes the value to
  another. Fabric-to-fabric, a value copy (`link` is how one makes a
  reference instead).
- `file:` names a local file, the only spelling that touches disk — and a
  scheme is legal only on an absolute complete path:
  `get topics --json > file:/tmp/topics.json` is fine, `file:out.json` is
  refused (`file:~/…` counts as absolute).
- `file:` is one member of an open scheme family: a schemed operand names
  something outside the fabric. `https:`/`http:` sources work as read ends
  (`set x - < https://…`); writing to an external scheme stays out of scope
  until a use rules it in.
- Shuttle maintains two working positions: the fabric cwd and one
  **external working location**. `xcd` sets it — `xcd file:~/data`,
  `xcd https://foo.com/a/b/` — and, its argument being already on the
  external plane, moves it with a plain relative path: `xcd ../foo`.
  `xpwd` prints it. In operands, a relative external path is rooted with
  the `x:` base — `> x:../out.json`, `< x:data.json`. `x:` is a base name
  rather than a scheme: it roots a relative path at the external location
  whatever that location's scheme, so no operand ever changes plane by
  position. A bare relative operand is always fabric.

## Pipes: native tools and escaped locals

Shuttle publishes a **native tool set**: names that work bare in a pipeline
— `get topics --json | jq '.[].title'` — and are guaranteed present
wherever shuttle runs, including an eventual terminal with no local
execution environment behind it. A native tool may begin as a forward to a
local binary; that is implementation, not contract. The initial set:
`jq`, `grep`, `wc`, `head`, `tail`, `sort`, `uniq`, `cut`. `cat` is
deliberately absent — printing a value is `get`, feeding a local file is
`< file:…`, and concatenation, its one irreplaceable job, waits for a
demand (`! cat` reaches the local one meanwhile).

Arbitrary local programs run only behind the explicit escape — `|!` in a
pipeline, line-initial `!` for a whole command — so stepping outside the
portable surface is always visible on the line. The split is deliberate:
the basics stay covered naturally, and nobody gets used to running local
tools invisibly.

## Open questions

None here — the base-overlay spelling is settled above. The remaining
open item for shuttle overall (shallow-sink expressibility) lives in
[`views.md`](views.md).
