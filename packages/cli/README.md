# @commonfabric/cli

## View pager

`cf view [file]` is an interactive pager for transformed TypeScript, source
files, and unified diffs. Named Markdown, JSON, JSONC, YAML, and Python files
use their own syntax highlighting. Transformed compiler output piped without a
filename keeps TypeScript highlighting when its module header identifies it.
Python interpreter shebangs select Python for otherwise unrecognized names.
Node, Deno, and Bun shebangs select the TypeScript and JavaScript language
family. Other filename-free source and named files with unrecognized syntax are
shown as plain text. For piped source, `--filename` selects syntax as though the
input had that name. `--language` selects a language by its stable identifier or
alias. Both options keep the pipe read-only and suppress unified-diff
auto-detection. An explicit language takes priority when both options are
present. Use `--diff` instead when the pipe is a unified diff.

The binary language handles known binary filenames, input containing a NUL byte,
and input that is not valid UTF-8. It starts in a read-only rendered view with
16 bytes per hex-dump row. Printable ASCII bytes appear at the right of each
row. Other bytes use the same control-picture glyphs as the pager's
non-printable display mode. Use `--language binary` or its `bytes` alias to
select it explicitly for piped input. Interactive views retain at most 256 KiB
and report the omitted byte count when the complete size is known. Use `--plain`
to stream the complete dump without building it in memory.

Each language selects how bytes are decoded. Text languages currently require
valid UTF-8. The binary language keeps each raw byte unchanged. An explicit
language also selects its decoder, so an invalid UTF-8 sequence reported under
an explicit text language is an error rather than silently becoming binary. A
UTF-8 byte order mark is removed before parsing and restored when an edited file
is saved. Binary workspace files and Git blobs remain outside text diff editing
and TypeScript semantic lookup.

Automatic content detection is limited to binary input, structurally identified
raw unified diffs, and standard Git commit output. A raw diff starts at the
first nonblank line. Recognized shebangs and transformed compiler headers remain
explicit selectors. JSON-, YAML-, Markdown-, Python-, and other language-shaped
source is not guessed from its syntax.

A diff shows its whole-diff change totals at the top right corner of its first
line: the added line count and the removed line count, colored like additions
and removals.

Markdown files can switch between the source and a rendered terminal view with
`V`. The rendered view formats headings, emphasis, links, quotes, lists, task
markers, tables, rules, and code. The same view is available for Markdown files
inside a unified diff; diff markers, addition and deletion tints, line
positions, and hunk expansion remain in place.

Press `\` in the interactive pager to cycle through unwrapped lines, hard
wrapping, and word wrapping. Hard wrapping fills every screen row before it
continues. Word wrapping breaks at whitespace and repeats the line's leading
punctuation and whitespace on each continuation row.

Redirected text output keeps the source text verbatim by default and adds ANSI
color only when the selected color mode permits it. Binary output uses its
hex-dump view by default. Pass `--rendered` to start in, or print, another
language's rendered representation when one is available. Editing from a
rendered view returns to source first.

```bash
cf check pattern.tsx --show-transformed --no-run | cf view
cf view .github/workflows/deno.yml
cf view scripts/analyze.py
git diff upstream/main | cf view
cf view --rendered README.md
generate-source | cf view --filename generated.py
generate-markdown | cf view --language markdown --rendered
generate-bytes | cf view --language binary
```

## Piece references

Commands that take a piece accept two textual reference forms:

- The canonical fabric reference: the LLM-friendly link form,
  `/[@did:.../]of:fid1:<id>[@scope][/path]`. This is the one reference syntax of
  the fabric — the same string names the same cell in patterns, in the shell,
  and here. A path embedded in a canonical `--piece` reference prefixes the
  command's positional path argument. A space embedded in it names the target
  space: it supplies the space when `--space` is absent, and when both are given
  they must agree — a mismatch is refused rather than resolved, at parse time
  against a `--space` DID and once the session opens against a `--space` name.
  An address printed by one command therefore composes into the next with no
  flag beside it, whatever space the reader has configured.
- The CLI's bare form: `pieceId[@scope]`, `pieceId[@scope]/path` at link
  endpoints, and slugs. This is a convenience alias for interactive use.

New reference-syntax capabilities land in the canonical form first; the alias
does not grow a capability the canonical form lacks.

On `cf get`, `cf set`, and `cf call`, a canonical reference can sit in the first
positional instead of riding `--piece`: an address begins with `/` and a
relative path never does, so the two positions cannot collide. The bare and slug
spellings stay on `--piece`, where no path competes for the position. Naming the
target twice — `--piece` beside a positional address — is refused rather than
resolved.

Those three commands are also mounted at top level as `cf get`, `cf set`, and
`cf call`: reading and writing cells is not a piece-management concern, and the
spelling says so. Each pair is one definition mounted twice, so the two
spellings take the same flags, behave identically, and complete identically. The
piece-mounted spellings are deprecated: each invocation prints a stderr notice
naming the top-level spelling and the literal date the old spelling stops
working (`PIECE_DATA_SPELLING_END_DATE` in `commands/piece.ts`, the one source
of that date). Until then both keep working, and the notice never touches stdout
— `get` and `call` reserve it for machine output.

A canonical reference may also end in `#argument`, which selects the piece's
arguments cell the way `--input` does. Only commands that take `--input` accept
it; `#` is reserved for the suffix, so a path key containing `#` needs the
positional path spelling.

## Piece discovery

`cf piece ls` lists the pieces in the selected space's piece registry. It reads
the default pattern and starts each registered piece to obtain its name and
pattern metadata. It does not enumerate every stored piece root.

`cf piece inspect --pattern-identity` prints one piece's source pin — pattern
identity, export symbol, current source revision when the piece keeps a log, and
whether the identity's source is retained in the space — without running the
piece and without pulling its input, result, or link graph.

`cf piece survey` reads a holder's own collection — the enumeration `piece ls`
cannot provide — one cheap identity read per member, the holder last, and emits
a plan for the bulk operations in `docs/plans/piece-bulk-operations.md`. On a
collection survey the registry is its cross-check: a registered piece on an
in-scope identity that the collection lacks makes the survey exit nonzero,
naming the piece. A `--list` survey reads exactly the pieces named and makes no
containment claim; each entry takes either reference form, and a canonical
entry's embedded space composes the way it does on `--piece` — supplying the
space when `--space` is absent, agreeing with it otherwise. Read-only. To watch
the surface work rather than read about it, `integration/bulk-ops-demo.sh`
narrates a board-sized survey and repair end to end against a running server,
with the unbuilt write stages shown as pending acts.

`cf piece repair` runs a caller-supplied fixer — a TypeScript module whose
default export is a pure transform from a piece's stored input document to the
document it should hold — over the same selection surface the survey takes. Dry
by default, reporting the exact per-piece diff and writing nothing; under
`--apply` it writes each row in its own transaction, and a plan from a dry run
drives the apply row for row under its document-hash preconditions (`--plan`).
The design is `docs/plans/piece-bulk-operations.md`, stage 2.

`cf piece slugs` lists the space's slug index: every name assigned through
`--slug` or `set-slug`, each resolved to the piece it names. The index records
assignments made since it existed, so a slug written by an older client still
resolves but is not listed — a slug document's id is derived from its name, and
nothing can enumerate names it was never told.

`cf piece search` also starts from the registry. It searches readable input and
result data, but returns registered pieces only. `cf piece map` likewise shows
connections among registered pieces rather than walking the complete stored
graph.

A piece outside the registry can be found only through a searchable collection
that deliberately publishes it, by following links from a known piece, or by
using an exact piece address, including its scope, that is already known. A
piece with none of those paths is an orphan and cannot be discovered through the
piece commands. See
[Finding Pieces](../../docs/common/concepts/piece-discovery.md) for the complete
boundary.

## Piece data search

`cf piece search <query>` reads every registered piece in the selected space and
returns the pieces whose input or result data contains the query. Matching uses
full Unicode case folding and canonical normalization over nested object keys
and scalar values. Canonically equivalent text matches, and a match cannot stop
partway through one character's multi-letter fold. Readable nested cell values
are included when they belong to the piece being searched. A cell owned by
another piece is searched only with that owner, not with every piece that links
to it. Data owned by a piece absent from the piece registry is not attributed to
its referrers. A cell with no piece ownership metadata remains searchable
through each piece that links to it. Opaque, write-only, comparable, stream, and
SQLite cell handles are not read. Piece IDs, names, and pattern metadata are
returned for context, but they do not count as searchable data.

```bash
cf piece search --space team-space "invoice 1042"
cf piece search --space team-space --json invoice
```

The command accepts the same identity, API URL, space, and combined URL options
as `cf piece ls`. Human-readable output uses the same columns as `piece ls`.
`--json` returns an array for scripts, including an empty array when no piece
matches. If part of a piece cannot be read, the command reports a warning on
standard error and continues searching that piece and the rest of the space.

## Piece CFC labels

`cf piece get-label` returns the effective CFC label view for a result path.
Pass `--input` to select the input cell — a `--piece` reference ending in
`#argument` selects it too. The paths in the returned view are relative to the
selected path, and the view includes declared, derived, and link-carried labels.
An unlabeled value returns JSON `null`.

```bash
cf piece get-label --piece ID messages/0/body
cf piece get-label --piece ID credentials --input
```

`cf piece set-label` reads a declared label update from standard input and
returns the updated effective view. The input is an object with a
`confidentiality` array, an `integrity` array, or both. An optional `observes`
field selects `value`, `shape`, `enumerate`, or `followRef` consumption.

```bash
echo '{"confidentiality":["team"]}' \
  | cf piece set-label --piece ID notes
echo '{"integrity":[],"observes":"value"}' \
  | cf piece set-label --piece ID draft --input
```

The command updates the label through the same checked write path used by
ordinary runtime operations. It does not edit raw CFC metadata. The
stored-schema rules reject a confidentiality update that would make data less
restricted and an integrity update that would silently make data more trusted.
An absent path is also rejected rather than creating policy metadata without a
value. An `observes` update is rejected when it would combine with an existing
observation class instead of preserving the requested class. Omitting `observes`
from a later update preserves an existing unambiguous class.

## Output Conventions

- stdout carries command output only; hints and diagnostics go to stderr.
  `cf get` prints JSON and represents an absent value as `null`.
- ANSI colors are emitted only when stdout is a TTY. `--no-color` or
  `NO_COLOR=1` disables them everywhere (including Cliffy help/usage output);
  `FORCE_COLOR=1`/`CLICOLOR_FORCE=1` forces them when piped. The policy is
  applied in `lib/color-mode.ts` and guarded by `test/color-mode.test.ts`. The
  [Cliffy dependency guidance](../../docs/development/DEPENDENCIES.md#cliffy)
  owns the import-map constraint that keeps this behavior working.
- `-q/--quiet` (on `piece`/`wish` subcommands) suppresses the stderr hint and
  next-step blocks. It deliberately does NOT change the log floor: consumers
  parse `--quiet` runs' stderr for runtime warnings (Loom's stale-root heal
  greps for `load-pattern-by-identity-source-miss`). Use `--log-level error` to
  drop warnings; the two compose.
- `cf call` accepts its payload as an inline JSON argument, `-` for stdin, an
  implicit pipe (no payload argument), or schema-derived flags after `--`.
- A `cf get` path that doesn't resolve prints a one-line error on stderr and
  exits 1 — it is a data error, not a usage error. A `piece link` that fails
  validation (a source/target piece or path that doesn't exist) reports the same
  way.
- The launcher spawns the child CLI with `deno run --quiet` so Deno's own
  warnings (npm "Ignored build scripts" banner) never reach users.

### What a call refuses before it dispatches

`cf call` judges the payload against the verb's declared event schema before
anything is sent, so a refusal costs nothing: the invocation id was never spent
and the corrected retry can reuse it.

A field the verb does not declare is one of the things it refuses. The runtime
hands a handler the fields its event schema names and drops the rest, so a
payload carrying a field nobody declared would otherwise run the handler without
it and report the call settled. The refusal names the field, the position it sat
at, the vocabulary that position takes, and the declared name it is one edit
from:

```console
$ cf call --piece ID addItem '{"titel":"Milk","done":false}'
Invalid input for "addItem": "titel" at <event> is not a field this verb
declares. Did you mean "title"? <event> takes "title", "done"
```

Positions below the root are spelled the way a `--schema` position is —
`<event>.item`, `<event>.tags[1]` — so one vocabulary covers both refusals.

`cf exec` refuses the same mistake in the same words when it arrives as a flag,
which is how the mounted-file door spells a field. Only the spelling differs,
because that is what the caller typed and must retype; the position is always
`<event>`, since a flag can name nothing below the root:

```console
$ cf exec /tmp/cf/home/pieces/notes/result/addItem.handler invoke --titel Milk
"--titel" at <event> is not a field this verb declares. Did you mean
"--title"? <event> takes "--title", "--done"
```

What the two doors LET THROUGH matches as well, which is the half worth relying
on: a flag naming an undeclared field is accepted exactly where the same field
would be accepted in a payload, and refused exactly where it would be refused.
Both doors read that from one place, so neither can drift into its own opinion
of what a schema permits.

Every position that names its fields is judged, whether it states
`type: "object"`, carries a `properties` map with no type beside it, states a
type union admitting an object, or reaches its map through a conjunction, whose
fields are the union across its members. A **disjunction** (`anyOf`, `oneOf`) is
passed over — a payload need satisfy only one branch — and so is a position
marked as a cell or a stream, which may hold a link rather than a value. A call
reaching either goes out rather than being refused on a guess.

The declared vocabulary is what `cf call --piece ID <verb> --help` prints, which
is the list to check when a field comes back refused. It names the fields the
verb's handler READS, which can be fewer than its TypeScript event type
declares: a field the body never touches is one the runtime would have dropped,
and the refusal says so rather than accepting it and losing it.

A verb that publishes **no event schema at all**, or one whose schema carries no
`properties` key, takes any payload: with nothing declared, nothing is dropped
either. That is not the same as a schema whose `properties` is empty — that one
declares that there are no fields, so the runtime delivers none and every field
a caller sends is refused.

### Transforming command output

Reading is one operation reached from four starting points, and every one of
them takes the same three flags — `--filter`, `--select` and `--schema` — with
the same grammar, the same conflict rule and the same error messages. The
vocabulary is learned once and written wherever you arrived from.

`cf get` filters an array before it reaches stdout and projects the result to a
smaller shape:

```bash
cf get --piece ID items --filter '.status == "open"'
cf get --piece ID items \
  --filter '.status == "open" and .score >= 10' \
  --select id,title,author.name
```

`cf call` writes them before the callable name:

```bash
cf call --piece ID --select topic.title addTopic '{"title":"Ship it"}'
cf call --piece ID --filter '.status == "open"' listTopics
```

`wish` writes them beside the target it resolves:

```bash
cf wish '#profile' -i ./claude.key --select name,avatar
cf wish '#mentionable' -i ./claude.key -s my-space --filter '.status == "open"'
```

`exec` writes them **before the mounted file**, because everything after the
file belongs to the callable's own schema-derived interface:

```bash
cf exec --select id,title /tmp/cf/…/result/search.tool --query milk
cf exec --select 'entry@' /tmp/cf/…/result/add.handler --title Milk
```

A mounted callable run through its own shebang — `./search.tool --query milk` —
cannot carry them, because the shim appends its arguments after the file. Reach
for the `cf exec` spelling when you want to shape what comes back.

Everything below describes all four. What differs is only what the selection is
about:

| Command   | What the selection shapes                                                                                |
| --------- | -------------------------------------------------------------------------------------------------------- |
| `cf get`  | the value at the cell its address and path name                                                          |
| `cf call` | the **result of the call** — a handler's `result` inside the Invocation JSON, or a tool's JSON on stdout |
| `wish`    | the cell the query resolved to, before the walk that strips handles                                      |
| `exec`    | the same result `cf call` shapes, for the verb the mounted file names                                    |

See [what a selection means for a call](#what-a-selection-means-for-a-call) for
the cases where the call's difference shows. `exec` is the same invocation
reached through a mount, so it meets the value-less verb and the
graph-quiescence coupling described there; it has neither `--no-wait` nor
`--show-links`, so the two cases about those flags do not arise. `wish` adds one
of its own: a query that matched nothing is an ordinary outcome rather than an
error, so the selection is never reached and the empty result comes back as it
always did. A selection that keeps nothing over a target that DID resolve is
refused, because "the wish matched nothing" and "your projection kept nothing"
are different facts.

`--filter` is jq-inspired rather than a full jq interpreter. It applies only to
arrays and accepts value paths (`.status`, `.author.name`, `.["display-name"]`,
`.tags[-1]`), JSON literals, `==`, `!=`, `<`, `<=`, `>`, `>=`, `and`, `or`,
`not`, and parentheses. Like jq, only `false` and `null` are falsey, so a
missing path simply does not match. A stored `undefined` is treated like a
missing value and is also falsey. Filtering happens before schema projection.

Two flags project, one per input language:

- `--select` takes a comma-separated field list such as `id,title,author.name`,
  in which a segment ending in `@` asks for an address rather than contents;
- `--schema` takes an inline JSON Schema object or `@path/to/schema.json`, and
  also accepts the same field list `--select` takes.

A command that names both has not said which shape it wants, and is refused
before the read or the call.

For an array result, the field list describes each item. An inline/file JSON
Schema describes the complete returned value, so a schema combined with
`--filter` must have an array root. Object `properties` are an allowlist by
default; use `"additionalProperties": true` to retain unspecified properties.
Projection schemas support structural `properties`, `items`, and scalar leaf
schemas. A position that names an object keyword (`properties`,
`additionalProperties`, `required`) projects an object and one that names
`items` projects an array, at every level of nesting and whether or not it also
states `type` — `{"properties":{"topic":{"properties":{"title":true}}}}` returns
`topic.title`. Neither `true` nor `{}` names a container, and both keep
everything at the position they sit at. A scalar leaf whose declared type does
not match the stored value is omitted by the runtime rather than reported as an
error, at any position; prefer `true` leaves unless that type filtering is
intentional. Schema combinators and references are rejected in caller-supplied
projection schemas. Concise dotted paths follow the declared source schema
through nested arrays, so `comments.body` selects `body` from every comment
without retaining comment siblings. The projection preserves source-declared
nullable items and properties, including `type` arrays and `anyOf` unions. When
the source schema does not identify a nested container, the concise form applies
the same field mask across arrays encountered in the value so siblings still
cannot leak; use an explicit JSON Schema when the output schema itself must be
fixed. If a present source value cannot materialize the transform, the command
exits nonzero and states that the failure is not JSON `null`. An absent optional
source remains the ordinary successful `null` CLI response, as does a valid
projected null.

**A field list names positions of the source, so the source's schema decides
whether a name can be there at all.** A position states its vocabulary by
carrying a `properties` map, so one declaring no fields (`properties: {}`)
refuses every name while a position with no map declares nothing and refuses
none. A path the schema proves nothing can appear at is refused before the read,
naming the position, the vocabulary that position declares, and — where the
vocabulary holds a name close enough — the one the path is a typo of. Three
shapes are proven: a field a position neither declares nor admits, a field named
below a scalar, and a field named below a verb, which dispatches rather than
holding a value. A field that is merely absent is a different fact and still
returns nothing at exit 0 — an optional field nobody has written, an interface
an item does not implement, a link that has not synced. The refusal therefore
fires only where the schema settles the question, and a position it does not
settle reads as it always did: an open `additionalProperties`, a
`patternProperties` map that names a pattern, a disjunction, an untyped
position, a position that only may hold an array (untyped beside an `items`, or
typed as both an array and an object), a tuple-shaped array, whose `prefixItems`
give its elements no one vocabulary, a reference site that declares fields of
its own, and a name several `allOf` members declare. A reference that does not
resolve is passed over as well, and what the caller then reads is the read's own
report of the reference rather than anything about the field. A JSON `--schema`
states a shape of its own rather than naming the source's fields and is not held
to the source's vocabulary, which is the spelling for reading a position the
source does not declare.

Both transforms run as a short-lived computed pattern in the caller's session.
When the declared source schema fixes the root container shape, the pattern
constructs its first storage read from the union of predicate-observed and
projected paths. Structurally declared properties, including local `$ref` item
schemas, are pruned to that union: predicate-only fields can decide membership
without appearing in the result, and omitted linked subgraphs are not hydrated.
Schema-less or root-union sources retain a value-shape read before the transform
because their array/object projection semantics cannot be established from the
declaration. Ambiguous source-schema compositions remain intact and can retain a
wider selector. The runtime's list filter/map builtins therefore handle CFC
exactly as authored pattern expressions do: predicate observations label array
membership, projection reads propagate labels, and filtered elements retain
their source links. Projection map/lift nodes construct the requested shape from
a source-schema-selected read rather than returning a widening identity alias.
Nested non-stream Cell handles are materialized before the predicate/projection
JavaScript runs; stream handles remain capabilities. The source cell's schema
remains authoritative for Common Fabric metadata. A caller cannot introduce or
override `ifc`, `asCell`, `scope`, or `default` through `--schema`.

#### Which keywords a `--schema` projection may contain

**The reader constructs the schema it applies rather than forwarding the one a
caller typed**, keyword by keyword. Four things can happen to a keyword.

- **Honored** — `type`, `properties`, `items`, `additionalProperties`, `$link`.
  These drive the projection and are what the constructed schema is built from.
- **Consulted** — `required`, `minProperties`, `maxProperties`, `minItems`,
  `maxItems`, `uniqueItems`. Each names a container, so writing one at an
  untyped position says which container that position describes. The constraint
  itself goes no further: nothing a caller writes in one reaches the read.
  `{"required":["id"]}` therefore projects an object without requiring `id` of
  it, and `{"minItems":2}` projects an array without imposing a length.
- **Tolerated** — the annotation keywords, `title`, `description`, `examples`,
  `deprecated`, `tags`, `tier`, `$id`, `$schema`, `$comment`. Accepted, and a
  read through a projection carrying one returns what the same projection
  returns without it.
- **Refused** — everything else, by name and with the position it sat at, plus
  the keyword it is nearest to. A misspelled `properties` is refused rather than
  silently returning the whole object or nothing at all.

The `required` a projected read applies comes from the **source** schema rather
than from the caller, restricted to the projected properties whose narrowing
cannot reject the property itself: a property the caller narrows to a scalar
type the value does not match drops out, and so does an array whose `items` the
caller narrows the same way, because one rejected element rejects the array
holding it. A narrowed position is then simply omitted from what comes back
instead of emptying the read around it.

A property the caller projects as a container keeps its derived `required` only
where the source declares that container and nothing else. `{"type":"array"}`
qualifies; `{"type":["array","string"]}` does not, nor does an `anyOf` whose
branches disagree, nor an undeclared position, nor an `allOf` — each of those
can hold something a container projection rejects, and the whole point of
deriving the key this way is that a rejected position is omitted rather than
emptying the object holding it.

A source that spells its shape as `{"$ref": "#/$defs/Thing"}` is followed to
what it names, at the document root and at any depth below it, so a named
interface carries the same `required` an inline one does. A reference that does
not resolve, or one that closes a circle, proves nothing and derives nothing —
the conservative direction, since the cost of declining is a key that would have
survived and the cost of guessing is the whole read.

#### Asking for an address instead of contents

A projection marks a position to get that position's address rather than what is
behind it. A JSON `--schema` marks with `"$link": true`:

```bash
cf get --piece ID notes --schema '{"type":"array","items":{"$link":true}}'
```

```json
[{ "$link": "/of:fid1:…" }]
```

The address is one string in the fabric's canonical reference syntax —
`/[@did/]<id>[@scope][/path]` — which is exactly what `cf call --piece` and
`cf get --piece` accept, scheme included, so an address emitted by one command
composes into the next unchanged, without being reassembled. The space rides in
front as `@did:key:…` only when it differs from the space the command targeted,
the scope follows the id as `@user`/`@session` only when it is not the default,
and the path follows as ordinary segments. No schema is inlined and no
write-redirect flag rides along.

**Every address this CLI publishes is that one string** — a `$link` marker's
value, a `--select` suffix's, a `--show-links` entry's, and the Invocation
JSON's `receipt`. A caller that reaches into an address for an `id`, a `space`,
or a `scope` reads the string whole instead, and passes it on whole. The failure
mode is quiet: these values usually arrive inside an `unknown` or a `JSONValue`,
so code that indexes them merges cleanly, type-checks, and then reads
`undefined` at runtime against a real fabric.

The address names the deepest stored link crossed on the way to the marked
position, plus the segments that remain below that link. Marking `title` under
each element of a `notes` array whose entries are links returns the note's own
id followed by `/title`, not the board's id followed by `/notes/0/title`: a link
is a durable identity, while a position in a containing document is a slot, and
reordering the collection above it leaves the same path naming a different
value. Where the stored link carries a path of its own, that path comes first
and the segments below it follow — a link to `{"path":["content"]}` marked at
`title` renders `/content/title`. Where nothing is linked on the way, the value
lives in the source document itself and the address is its position there.

The marker sits beside a projection when both are wanted —
`{"$link":true,"type":"object","properties":{"title":true}}` returns the address
and the title — and replaces the contents when it is alone. It is accepted
anywhere `properties` is, except under `additionalProperties`, whose membership
the stored value rather than the selection decides.

A field list marks with a trailing `@`, which is that same marker at the
position the segment names:

```bash
cf get --piece ID --select 'topic@,topic.title'
```

```json
{ "topic": { "$link": "/of:fid1:…", "title": "First note" } }
```

The two paths union into the one position, and `topic@.title` says the same
thing in one path. `@` is special only as the final character of a segment:
`user@home` names a field, and `\@` writes a literal `@` where a trailing one
would otherwise mark, so `a\@` names the field `a@`. Naming a position both
ways, `topic,topic@`, returns the address beside the whole contents.

A field list applies to each element wherever it crosses an array, and an
address is one of the things it applies. Where the marked position holds an
array the answer is one address per element, so `notes@` is the concise spelling
of `{"type":"array","items":{"$link":true}}`:

```bash
cf get --piece ID --select 'notes@'
```

```json
{ "notes": [{ "$link": "/of:fid1:…" }] }
```

Those element documents are what a caller cannot work out for themselves; the
array position's own address is only the source address plus the path they just
typed. Where the marked position holds anything else, `topic@` among them, the
address is that position's own. Marking below an array — `notes.title@` — is
element-wise for the same reason, and answers with each note's own id followed
by `/title`.

A path that is only `@` names the position the read is already at, which no
field path reaches because it sits above every field:

```bash
cf get --piece ID topic --select '@,title'
```

```json
{ "$link": "/of:fid1:…", "title": "First note" }
```

It composes exactly as a suffix one level down does: `@` alone replaces the
contents with the address, `@` beside a field path returns both in the one
result, and a source that holds an array answers with one address per element. A
leading `@` followed by anything else is an `@file`, which `--schema` reads and
`--select` does not, so `--select '@fields.json'` is refused and pointed there.

A marked position is never fetched: it contributes a rejecting selector to the
same path union the projection builds, and the address is composed from links
already stored in the documents the read visited rather than by following one. A
marked collection therefore costs one document read rather than one per element.
Neither spelling can be combined with `--filter`: the elements a predicate keeps
no longer say which positions they came from, and an address names a position.

#### What a selection means for a call

A selection shapes a result that already exists. It does not narrow what the
call fetches: the readback materializes the whole receipt before the selection
runs. (A plain result's receipt does carry a descriptive schema of what it holds
— a receipt holding anything reactive carries none — but either way the fetch
has happened before the selection applies.) The same holds for a tool, whose
result is read off the cell the tool wrote. Use a selection to control what
reaches stdout, not to control what travels.

A selection also couples the call to graph quiescence. The shaped readback runs
through the same shared read step as `cf get`, and that step awaits the CLI
runtime's global idle plus storage sync before answering — while the plain call
acknowledges at its own handling's commit. On a piece with heavy derived state,
a shaped call can therefore wait on unrelated recomputation the handler
triggered elsewhere in the graph. When that wait matters, shape the collect
instead: call plain (or `--no-wait`), then
`cf get --piece <receipt id> --select …`.

Three cases follow from that:

- **A value-less verb still reports nothing.** Its receipt is the empty witness,
  and the Invocation JSON omits `result` to say so. A selection is about a
  value, so with none there the step never runs and `result` stays absent — it
  does not become `{}`, and it is not an error. A selection that keeps nothing
  from a result that _does_ exist is a different fact, and it is refused rather
  than reported as an absent result.
- **`--no-wait` refuses all three flags.** That mode exits once the commit is
  acknowledged and skips the receipt readback, so there is no result to shape.
  The refusal names the flags that need the readback, alongside `--show-links`
  for the same reason. What it still returns is the envelope's `receipt` — the
  address of the cell holding the outcome, known at commit — so the shaping
  flags apply to the `cf get` that collects it.
- **`--show-links` composes with a projection, not with `--filter`.** Links are
  collected after the selection, over exactly the value the caller is holding: a
  projection leaves every surviving path where it was, so each address still
  names the position it annotates, and a path the projection dropped simply gets
  no entry. A predicate does not — the elements it keeps land at positions that
  are no longer the ones they came from — so `--filter --show-links` is refused,
  the same refusal a `$link` marker meets for the same reason.

#### A result that points back at itself

A verb returning the piece it created hands back a value that can be reached
from inside itself, whenever that piece carries a back-reference — `parent`
beside `children`, the shape
[self-reference](../../docs/common/concepts/self-reference.md) documents. A
circle has no JSON rendering at all, so a readback that follows one has nothing
to write.

Where the caller named no shape, `cf` derives one from the verb's declared
result. The declaration is the boundary the author drew: the position where the
declared type re-enters itself is the position that closes the circle, so that
position renders its address and everything else reads as it always did.

```json
{
  "item": {
    "title": "Rotate signing key",
    "status": "open",
    "children": [],
    "parent": { "$link": "/of:fid1:…/parent" }
  }
}
```

Three things follow:

- **It is the same `$link` a caller writes by hand.** The derived bound composes
  its addresses through the same walk the selection step above composes a
  written `$link` with, so `--schema` over the same position produces the same
  address.
- **A caller's own shape wins wherever it renders.** `--filter`, `--select` and
  `--schema` are applied to the receipt first, and a projection that narrows
  past the circle — `--select item.title` — is answered exactly as written, with
  nothing derived added to it. A projection that names the re-entering subtree
  whole — `--select item` — keeps the circle it selected and is bounded on the
  way out, but the bound is a cut into what was selected rather than a shape
  that replaces it: the closing position renders its address, and no position
  the caller did not name comes back beside it. `--select item.parent` names the
  closing position itself, and is answered with that one address alone.
- **Nothing else pays for it.** A result that renders is written out exactly as
  it was read, and the compiled pattern a declared result is matched through is
  loaded only where a readback cannot render. The bound itself is a cut into the
  value already in hand — no pattern graph and no transaction — leaving the
  address walk a written `$link` is composed through as the only work beside it.

Where nothing bounds the circle — the verb declares no result, the declaration
it made leaves the closing position wide, or a `--filter` is in play — the call
reports the position the circle closes at, states that the handling committed,
and names the receipt to collect the outcome from. It exits nonzero: the outcome
could not be rendered. The write still landed, which is the property the message
leads with.

A `--filter` is the case with no bound to reach for rather than one that failed:
the predicate hands back the elements themselves, which no longer say which
positions they came from, and a bound is written in addresses, which name
positions — the refusal `--filter --show-links` earns above, for the same
reason. Narrowing past the circle with a projection beside the predicate —
`--filter '.status == "open"' --select title` — renders.

## Built Binary

`deno task build-binaries cf` compiles the CLI to `dist/cf` — fully
cwd-independent, with no Deno startup noise and roughly half the per-invocation
cost. (`--cli-only` is a legacy alias for the same thing.)

It exists for CI, which downloads it in `cli-integration-test` (on
`$GITHUB_PATH`) and `pattern-unit-test` (as `CF_BINARY`). A CI run never edits
the source the binary was built from, so it cannot go stale mid-run.

That does not hold for a working tree you are editing, and there is no
invalidation story to catch it — see "Why not `dist/cf`" under Installing `cf`
on PATH. Use `bin/cf` or `deno task cf` locally. If you do build it, rebuild
after every `git pull`: a stale binary rejects newer flags and can hit
wire-protocol skew against an updated server.

## Launcher Contract

`packages/cli/launcher.ts` is the stable Deno launcher for consumers that need
to run the Common Fabric CLI from another repo or from a sandbox. It keeps the
selected Labs checkout as the source of truth while making the child CLI process
use an explicit Deno config/import map.

The launcher itself intentionally uses only Deno built-ins so callers can invoke
it before the Labs import map is active.

Launcher options are parsed before the first non-launcher argument or `--`. Use
`--` when a `cf` argument has the same name as a launcher option:

```bash
deno task cf -- --config piece-config.json
```

Launcher `--config` is the child Deno config/import map used to start the CLI.
It is not a `cf` command or pattern config.

The child CLI working directory defaults to `INIT_CWD` when present, otherwise
the launcher's current directory. This preserves `deno task cf` behavior from a
caller directory. Direct sandbox or wrapper callers should pass `--cwd` when
they need to ignore a stale inherited `INIT_CWD`.

The child CLI process inherits the parent environment. The launcher only adds
`CF_CLI_NAME=cf`, so caller-provided `CF_API_URL`, `CF_IDENTITY`, experimental
flags, and CFC/sandbox-related environment variables continue to flow through.

From the Labs checkout:

```bash
deno task cf --help
deno task cf check packages/cli/fixtures/pattern.tsx --no-run
```

From a sibling consumer such as Pattern Factory:

```bash
deno run --allow-run --allow-env --allow-read ../labs/packages/cli/launcher.ts \
  -- check workspace/<run-id>/pattern/main.tsx --no-run
```

From a vendored consumer such as Loom:

```bash
deno run --allow-run --allow-env --allow-read vendor/labs/packages/cli/launcher.ts \
  --labs-root vendor/labs \
  --config deno.jsonc \
  -- check .ops/patterns/example.tsx --no-run
```

Use `--launcher-help` for launcher-specific help. Normal CLI flags such as
`--help` are passed through to `cf`.

## JSON command contract

An invocation that contains `--json` reserves stdout for JSON. Status text and
errors go to stderr. If a command does not support `--json`, it rejects the
option without printing command help to stdout. Static `--help` and `--json`
cannot be combined. Callable schema help is the exception because it is JSON:
use `cf exec <mounted-file> --help --json` or
`cf call ... <callable> --help --json`.

The supported output switches are:

- `cf space ... --json` serializes the clone manifest, verify result, or
  fingerprint. `cf space verify` and `cf space reset` exit nonzero when the
  clone does not match its baseline, so a rehearsal script can gate on them; the
  printed report, not usage help, is the output in that case. The procedure
  these commands serve is `docs/development/space-clone-rehearsal.md`.
- `cf inspect ... --json` serializes an inspector result. `inspect html` does
  not have a JSON representation, so `html` and `--json` are mutually exclusive.
  `inspect graph --dot` and `--json` are also mutually exclusive.
- `cf piece ls`, `piece search`, `piece inspect`, `piece survey`,
  `piece repair`, `piece view`, and `piece render` use `--json` as an output
  switch. `piece survey` reserves stdout for the plan it emits (or, under
  `--json`, the full survey result); its tally and findings go to stderr.
  `piece repair` reserves stdout the same way — the emitted plan, or under
  `--json` the full report in the canonical FabricValue encoding — with its
  verdict tally and dry-run diff going to stderr. `piece render --watch --json`
  writes only JSON render records to stdout; watch status goes to stderr.
  Rendering a piece without a UI fails instead of returning an empty successful
  JSON stream.
- `cf get` and `cf wish` always return JSON. Their `--json` options are
  accepted, documented no-ops for callers that select JSON explicitly.
- `cf check --json` compiles without evaluating and prints one object with a
  `files` array. Each entry has the input `path` and the compiled module bodies
  in `output`.

`cf check --json`, `--show-transformed`, and `--pattern-json` are three mutually
exclusive stdout modes. The command buffers all three modes until every input
succeeds. A failure therefore leaves stdout empty instead of mixing successful
output with later errors.

For `cf exec`, `--json` belongs after the mounted callable path. For `cf call`,
it belongs after the callable name. In both commands, it selects complete JSON
input — and in both, that is the opposite side of the callable from where the
read options go, which shape what comes back rather than what goes in:

```bash
cf exec /tmp/cf/home/pieces/notes/result/search.tool --json '{"query":"milk"}'
printf '%s' '{"query":"milk"}' |
  cf exec /tmp/cf/home/pieces/notes/result/search.tool --json

cf call ... search --json '{"query":"milk"}'
printf '%s' '{"query":"milk"}' | cf call ... search --json
```

Bare `--json` reads stdin. An inline value immediately after it is parsed as the
complete input. `cf call` also accepts a single positional JSON value. Put
schema-derived piece-call flags after `--`, for example
`cf call ... search -- --query milk`. Use `-- --json-file <path>` for a
piece-call JSON file. These rules keep the options before the callable name for
`cf call` itself and the arguments after the name for the invoked callable.

## Command visibility

Every registered top-level command appears in `cf --help`. The direct
`fuse-daemon` and `fuse-supervisor` entry points are visible because packaged
launchers use them. Shell completion is the exception: it drops commands whose
description opens with `Internal:`, because those are spawned by `cf fuse` and
never typed at a prompt.

## Installing `cf` on PATH

Interactively, the CLI has always been invoked as `deno task cf`. Shell
completion is the first thing that needs a `cf` on PATH on a developer machine:
the function it installs calls `cf completion complete` by name on every Tab, so
**completion does nothing at all without one** — including for
`deno task cf <TAB>`, which the same function services. Because a failing
completion is swallowed by design (it must never paste text into the command
line), a missing `cf` shows up as "completion doesn't work", not as an error.
`cf completion bash|zsh` therefore warns on stderr when it cannot find itself on
PATH.

(CI does resolve `cf` by name — `integration/integration.sh` runs `command cf`
against a binary the workflow puts on `$GITHUB_PATH` — but it builds that PATH
itself, and local runs of those same scripts set `CF_CLI_INTEGRATION_USE_LOCAL`
to force the source CLI.)

`bin/cf` is the install. It runs from source, so it never goes stale against the
checkout:

```bash
# mise users: nothing to do. mise.toml puts this checkout's bin/ on PATH.
mise trust    # only if this checkout has not been trusted yet

# everyone else (mise is recommended in README.md but not required):
deno task install-cf              # --dry-run to see what it would do
```

`install-cf` copies `bin/cf` to a directory already on your PATH — refusing to
guess if there isn't one, since installing somewhere unreachable would reproduce
the silent failure this exists to prevent. A copy rather than a link, because
the lookup below travels with the script: no particular checkout has to survive
for the install to keep working. Re-run it to upgrade. It never edits your shell
rc; it prints the completion line for you to add.

It copies **this** checkout's `bin/cf` — the one whose task you invoked, which
may carry changes not yet on `main` — while baking the **primary** checkout in
as the outside-a-checkout default, so removing the worktree you installed from
does not strand it.

### Which checkout runs

Several checkouts coexisting is normal — worktrees, and a vendored labs inside
another repo (a supported, tested layout: see `test/launcher.test.ts`). So the
symlink above does **not** pin `cf` to the checkout you installed it from. It
selects, in order:

1. **`$CF_LABS_ROOT`**, when set — the explicit override for when your cwd
   cannot say what you mean, such as working on a pattern under `/tmp`. A value
   that is not a checkout is an error, not a quiet fall-through. It chooses
   which CLI runs; it does not change your working directory.
2. **The nearest checkout walking up from `$PWD`.** A directory is tested as a
   checkout before it is tested as a host vendoring one at `vendor/labs`, so
   standing inside `<host>/vendor/labs` selects that labs rather than
   re-deriving it from the host.
3. **A default fixed at install time**, then **the checkout the script itself
   lives in** — for when you are not standing in one at all. An installed copy
   carries the default (`install-cf` points it at the primary checkout, since
   worktrees are removed routinely); the in-repo file and any symlink to it fall
   through to their own checkout. Both are ignored unless they are still real
   checkouts, so a stale default cannot silently send you somewhere that no
   longer exists. With none of them usable, `cf` says so and exits 2 rather than
   guessing.

`cf which` answers "which one would run?" — it prints the CLI path on stdout and
the reason on stderr, and is handled by the wrapper rather than forwarded, since
asking the CLI which CLI would run begs the question:

```bash
$ cf which
/path/to/checkout                                  # stdout
cf: entry /path/to/checkout/packages/cli/mod.ts    # stderr
cf: selected by nearest checkout above the current directory

$ cf which 2>/dev/null    # just the checkout, for scripts
```

stdout is the checkout because that is the part that varies; the entry inside it
is always `packages/cli/mod.ts`, which _is_ the CLI (it ends in
`if (import.meta.main)` and nothing outside `packages/cli/` imports it as a
library).

Rule 2 is what mise already does for its route (`_.path` resolves relative to
the `mise.toml` declaring it), so both install routes agree on which checkout
you get. The consequence worth knowing: `cf` inside checkout B runs B's code
even though you installed the link from A. That is the point, but it means a
stack trace is the quickest way to confirm which checkout answered.

### Why not `dist/cf`

The compiled binary is roughly twice as fast per invocation (~0.33s versus
~0.6s), which is tempting when every Tab press is a full CLI invocation. **Do
not put `dist` on your PATH anyway.** There is no invalidation story for it:
`tasks/build-binaries.ts` has no up-to-date check, nothing compares the binary
against its sources, and the whole mechanism is the "rebuild after every
`git pull`" instruction in the Built Binary section above. A stale `dist/cf`
rejects newer flags and can hit wire-protocol skew against an updated server —
see "FUSE mount wrapper mismatch" in `skills/cf/SKILL.md` for an instance of
this actually biting.

Nor is mtime a usable substitute: `revertWorkspace` restores `deno.jsonc` and
the compile-cache version module _after_ the binary is written, so `dist/cf` is
older than its own inputs the moment the build finishes.

CI is a different case and legitimately uses the binary — a workflow run never
mutates the source it was built from. `cli-integration-test` puts it on
`$GITHUB_PATH` and `pattern-unit-test` passes it as `CF_BINARY`. That reasoning
does not transfer to a working tree you are actively editing.

## Shell completion

`cf completion <shell>` prints a completion script for bash or zsh. It requires
`cf` on PATH — see "Installing `cf` on PATH" above.

```bash
# zsh — eager form, in ~/.zshrc after compinit. Required for the `deno` binding
# described below; the fpath form does not activate it until `cf` completes once.
source <(cf completion zsh)

# zsh — fpath form. Completes `cf` itself; add the two lines under
# "deno task cf" below if you also want `deno task cf` to complete.
cf completion zsh > "${fpath[1]}/_cf"
autoload -U compinit && compinit

# bash
cf completion bash > /usr/local/etc/bash_completion.d/cf
# or, for the current shell only:
source <(cf completion bash)
```

Completion covers the command tree — subcommands, flags, and enumerated values
such as `--log-level` — plus live values read from the fabric:

| Slot                                                         | Completes to                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| `--piece`                                                    | the space's slugs, then its piece ids                         |
| `cf call <callable>`                                         | the piece's callables, annotated with the doc comment on each |
| `cf get`/`cf set <path>`                                     | cell keys, one path segment at a time                         |
| `cf get --select`/`--schema`                                 | field paths into the value, and their `@` form                |
| `piece set-slug <slug>`                                      | the space's slugs                                             |
| `piece link <source>/<target>`                               | `pieceId/path/to/field` endpoints                             |
| `--space`, a positional space                                | space DIDs of local memory-v2 stores                          |
| `inspect <entity>`, `inspect graph --root`                   | that space's entities, as `cf inspect entities` lists them    |
| `cf wish <target>`, `cf wish --scope`                        | the vocabulary `cf wish --help` enumerates                    |
| `--identity`, pattern arguments                              | `*.key` / `*.tsx` files, via the shell                        |
| `--datafile`, `--out`, `--output`, `space clone --from`      | any file, via the shell                                       |
| `--dir`, a source `--root`, `space clone --to`, a mountpoint | a directory, via the shell                                    |
| `--remote`                                                   | what `--api-url` takes, in the `--remote=<url>` spelling      |

A callable is annotated with what its author said it is for, falling back to its
kind where they wrote nothing. A wrapper or deprecated verb — the two
`cf piece verbs` holds back unless `--all` — is offered with its marks leading
that annotation, joined the way the listing joins them and both shown where a
verb carries both, since either is callable and a name that works should be
reachable.

A projection's grammar is its own and not the cell path's: a list splits on `,`
and a path on `.`, and a trailing `@` asks for a position's address rather than
its value. A path below an array names a field of each element, however many
array layers deep it sits, because that is what the projection does with one.

A bare `@` asks the read for its own address and is accepted wherever an element
of the list begins — with one exception `--schema` makes: an argument _starting_
with `@` is its `@file` form, so `--schema @` is an empty path while
`--schema revision,@` is the suffix. A field named `true` or `false` is offered
wherever it is not the whole argument: written alone it is a boolean JSON Schema
to `--schema` and refused by `--select`, and written as `revision,true` it is an
ordinary name to both. Completion restates none of that — it puts each
prospective candidate back through the flag's own parser and offers what comes
back as a field list, so the two sets cannot drift. `cf call`'s and `cf exec`'s
projections shape a verb's result rather than the piece's root, and are not
completed from it; `cf wish`'s resolution writes to the space, and a Tab must
not.

An option name can mean two things on two commands, so the ones that do are
completed per command rather than by name. `--root` is a source directory on the
commands that compile one and an entity on `cf inspect graph`; `--to` is a clone
directory on `cf space clone` and a sequence number on `cf inspect diff`;
`--from` and `--scope` divide the same way. Where the value is a sequence number
the slot offers nothing, which is the honest answer for a word no set can name —
offering the wrong set is worse than offering none.

A positional divides the same way. Every `cf inspect` subcommand that opens a
local space completes it from local stores, but `inspect pull` names a space on
the remote and resolves it through the remote's own listing, so it offers
nothing rather than a local DID the command would reject — listing the remote is
a network round trip a keystroke must not start. The entity beside a space comes
from the view that subcommand will read: its `--branch` and `--scope`, except on
`inspect overlay`, which takes no `--scope` and reports every scope, so its
candidates span every scope too.

`--remote` says the same thing about every `inspect` slot at once. It is a
global option there and it decides where the space comes from: the token is
resolved through the remote's own listing and the snapshot it names is fetched,
so a local DID, a local entity and a local `graph --root` are each a candidate
that read rejects. Every one of those slots answers nothing while it is on the
line, in either of its spellings — `--remote=<url>` or bare.

An option's value completes the same whether it is written after a space or
after `=`, and every spelling of a target reaches the same slots behind it: the
bare id, the canonical reference (space-qualified or not, with an `@scope`
suffix, an embedded path, or the `#argument` suffix), and a canonical reference
written positionally in place of `--piece`.

Past a `stopEarly()` boundary — after `cf call`'s callable name, after
`cf exec`'s mounted file — nothing is offered. The CLI's own flags are refused
there, so offering them would name something the command rejects; the words that
do belong there are the callable's, and completing those is not yet built.

Live values need an identity and an api-url. Both are read from the line being
typed (`-i`, `-a`, `-u`) before falling back to `CF_IDENTITY`/`CF_API_URL`, so
`cf call -s other-space --piece <TAB>` lists that space's pieces rather than the
environment's. A space DID embedded in a reference supplies one the line did not
name. When nothing is resolvable, or the server is unreachable, completion
yields nothing — it never prints an error into the command line. Each request
costs one CLI invocation plus one round trip, so value completion is as fast as
the fabric it queries.

A path-shaped slot — a cell path, a link endpoint, a projection path — completes
one segment at a time and holds the cursor for the next separator. bash gets
that by having the binding registered `complete -o nospace`, with a candidate
that should end the word carrying its own space: `compopt` is the per-completion
switch and it is bash 4 and later, while macOS ships bash 3.2, so the space is
inverted rather than suppressed. zsh does it natively.

The inversion is registered on the `cf` binding alone. A `deno` line can be
handed back to whatever completed `deno` beforehand, and that completion's own
spacing has to survive the handoff, so the `deno` binding keeps bash's default
and `deno task cf` pays a keystroke per path segment where `cf` does not. On
bash 4 and later `compopt` reaches that binding too and the cost disappears;
under bash 3.2 there is no per-completion switch to reach it with, and taking
the space away from every `deno test` and `deno run` completion is the larger
loss.

A candidate that opens with `#` — every `cf wish` target but the root — is
inserted backslash-escaped in bash, as `\#profile`. Written bare it would be a
comment, and the target would never reach the command; the escape is one word to
the shell and the bare target to the CLI, and completing it again reads back the
same target. zsh quotes what it inserts, so it arrives escaped there without the
script doing anything.

### `deno task cf` and other invocations

The scripts bind `deno` as well as `cf`, so `deno task cf piece <TAB>` completes
the same way the binary does; `deno run … packages/cli/mod.ts` and the
`launcher.ts` form (including arguments after `--`) are recognized too. The
binding is cooperative: a `deno` line that is not a CLI invocation is handed
back to whatever completed `deno` beforehand, so `deno test` and
`deno task build-binaries` keep their own completions. Pass `--no-deno-task` to
bind only `cf`.

The binding is installed by the script body, so it needs the script to be
_evaluated_, not merely autoloadable. bash's `bash_completion.d` and zsh's
`source <(…)` both do that. zsh's fpath form does not: `_cf` is autoloaded on
the first `cf` completion, so until then `deno task cf <TAB>` does nothing. To
keep the fpath install and still bind `deno`, add this after `compinit`:

```zsh
_cf_deno_previous="${_comps[deno]:-}"   # preserve deno's own completion
compdef _cf deno
```

Capturing eagerly matters: `_cf` records the previous completer when it loads,
and by then `_comps[deno]` is already `_cf`. It refuses to chain to itself
(which would recurse and hang the terminal) and keeps any value recorded
earlier, so the line above survives.

### Implementation

Cliffy ships a `CompletionsCommand`, but its dynamic hook passes the callback
only `(command, parent)` — no cursor word and no access to the options already
typed — so it cannot answer "the callables of the piece named by the `--piece`
on this line". `lib/completion/` therefore emits its own scripts, which are
deliberately thin: they forward the raw command line and let
`cf completion complete` decide everything. A sourced completion function lives
in a user's shell profile and is not updated when the CLI is rebuilt, so it must
not encode a command tree that can go stale.

Resolution walks Cliffy's live `Command` tree rather than a hand-maintained
table, so a newly registered subcommand or flag completes as soon as it exists.
Two facts cannot be read off that tree and are carried explicitly in
`lib/completion/`: the pre-parse globals `--log-level` and `--no-color` (both
stripped from `argv` before Cliffy parses, in `lib/log-level.ts` and
`lib/color-mode.ts`), and the provider table binding slots to live data.

`deno task check-completion-slots` is what keeps the provider table from falling
behind that tree. It walks the same commands and names every value-taking option
and every positional with no provider, no enumerated set, and no recorded reason
for having none — and the same subtraction the other way, so a provider entry
matching no slot fails too. It asks per command rather than per option name,
since a provider scoped to one command answers nothing on the others declaring
the same flag. It cannot decide that a slot should complete; it requires that
somebody decided.

The tests divide the same way. `test/completion-*.test.ts` cover everything
answerable without a fabric — line resolution, candidate shaping, and the
degrade-to-empty path. Every provider that reads state — a fabric, the local
memory-v2 stores, or the environment — is exercised by
`integration/completion-over-the-cli.sh` at one of the slots it answers: it
deploys a fixture and asserts what a Tab offers at each slot of the chain. Two
slots sharing a provider are covered by that one step, since `piece survey`'s
and `piece repair`'s `--list` take exactly what `--piece` takes. Which slots a
provider is keyed to is the other question, and
`deno task check-completion-slots` is what asks it, per command.

The remaining table entries hand the shell a constant `files` or `dirs`
directive, which a fabric cannot change: those are asserted one by one, kind and
glob, in `test/completion-providers.test.ts`. The set that has to be asserted is
derived there rather than remembered — every slot the tree declares is probed
with no fabric configured, and one that hands the shell a directive no case pins
fails the test. A case pins one command where the provider says it answers per
command, and every command at once where it does not — the same distinction the
slot gate draws, and a provider held to it by a test of its own.

That split is not tidiness: a provider that reaches a fabric and comes back with
the wrong set is invisible to a unit test and invisible at the prompt, because
failure here is silent by design. The script also carries `gap` assertions for
slots that answer nothing today, so one starting to answer fails loudly rather
than passing quietly.
