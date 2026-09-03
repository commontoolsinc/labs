# The reference grammar

## Status

Proposed. This is a decision record for the canonical reference grammar — the
one string form that names a cell — and for the mechanism by which that grammar
admits a new requirement. It records the requirements the grammar answers to,
the decisions taken against them, the alternatives each decision rejected, and
the decisions elsewhere in this tree that each confirms or replaces.

Until it is adopted, `parseReferenceParts` in
`packages/runner/src/link-types.ts` and the documents that quote its form
describe the grammar as it stands, and [Migration](#migration) names the
distance between that and this.
[#6775](https://github.com/commontoolsinc/labs/issues/6775) is the question this
document answers.

## Summary

A reference is one string that names one cell, read the same way by every reader
in the fabric:

```text
[//<space>]/<piece>[@<qualifier>…][/<path>][#argument]
```

Three characters carry structure, and each carries exactly one meaning:

- `/` separates segments. Doubled at the head, `//` introduces the space, the
  way it introduces the authority in a URL.
- `@` introduces a **qualifier** on the piece: which instance of it, which
  version of it. A qualifier is written `@name=value`; the scope, the one
  qualifier people type, has the abbreviation `@user`.
- `#` introduces the **fragment**, which selects a secondary cell of the piece
  rather than the piece itself. `#argument` is the one fragment.

Read from the outside in: the space says where to resolve, the piece says what,
the qualifiers say which instance and version of it, the path says where inside
it, and the fragment says which of its cells. A reference that carries all of
them:

```text
//did:key:z6MkBakery/of:fid1:Glz…@user@pin=Avcny…rC1c/items/0/title
```

The same cell, written by a reader that holds a session and can resolve names:

```text
//bakery/glaze-tracker@user/items/0/title
```

And the common case — a same-space, base-scoped cell — is what it always was:

```text
/glaze-tracker/items/0/title
```

## What this governs

The canonical reference grammar: the form `parseReferenceParts` reads, the form
`createLLMFriendlyLink` writes, and the form every `cf` command reads in its
target positional and prints in every address it publishes. The CLI's bare alias
(`pieceId[@scope]`, and a slug on its own) is a convenience over this grammar
and follows it; `packages/cli/README.md` records that new capability lands in
the reference first and the alias never grows one the reference lacks.

Three neighboring grammars name related things and are **not** this grammar,
though each is held to it in a stated way:

| Grammar                                                             | Where defined                                                                             | Relation to this document                                                                                                                                                                           |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell page URL, `https://<host>/<space>/<piece>/<path>`             | `packages/shell` routes; `parseFabricUrl` in `packages/runner/src/fabric-url.ts` reads it | Mutually translatable with a reference, segment for segment ([R8](#r8--translatable-with-its-siblings))                                                                                             |
| Pattern import specifier, `cf:[/<space>/]<ref>[/<subpath>][@<pin>]` | [Pattern imports](pattern-imports/README.md#specifier-syntax)                             | Shares the reserved characters and the trailing-qualifier position; its pin is a qualifier this grammar registers ([D2](#d2--is-the-qualifier-introducer-and-nothing-else))                         |
| Projection grammar, `--select 'topic@,topic.title'`                 | `packages/cli/README.md`, "Asking for an address instead of contents"                     | Its own grammar by its own statement: a list splits on `,`, a path on `.`, and a trailing `@` marks a position. It borrows `@` and `,`; the [inventory](#character-inventory) records the borrowing |

Shuttle's line grammar
([`../plans/shuttle/grammar.md`](../plans/shuttle/grammar.md)) is a layer above
this one: it reads a reference through this grammar, adds place-relative
readings of its own (`..`, `-`, `%3`, a bare segment), and records that it
forbids itself a second spelling of anything this grammar already writes.

## Requirements

Each requirement names where it comes from. A grammar decision below serves one
or more of these by number, and a future requirement is admitted by being
written here first.

### R1 — One grammar, every reader

The same structure names the same cell in a pattern, in the shell, at the CLI's
intake seams, and on shuttle's line. Readers differ in what they can _resolve_ —
a pattern resolves from the string alone and so requires a DID and a handle; a
session-holding reader resolves a space name and a slug as well — and not in
what the grammar _admits_.

Source: `packages/cli/README.md` ("the one reference syntax of the fabric"); the
doc comment heading `packages/cli/lib/llm-friendly-ref.ts`; shuttle's component
table, which lists the grammar as something shuttle "consumes and must not
fork".

### R2 — Every dimension of a link's address has a written form

A stored link addresses a cell by id, space, path, and scope, and every value
any of those can hold in storage can be written as a reference. In particular
the grammar's scope vocabulary is the storage layer's: `LinkScope` in
`packages/api/index.ts` is `"inherit" | "space" | "user" | "session"`, and all
four are writable.

Source: [Scoped cell instances](scoped-cell-instances.md#goals) requires scope
to be "expressible in TypeScript authoring, generated schema, normalized links,
and serialized sigil links". The runner's `createLLMFriendlyLink` renders any
`NormalizedFullLink`, so a scope the renderer can write is a scope the parser
must read.

### R3 — Decidable from the string alone

Which characters are the space, the piece, a qualifier, the path, and the
fragment is fixed by the string, without a session, a place, or a schema. A
context-holding reader may _resolve_ more (a name to a DID); it never _parses_
differently.

Source: `parseLLMFriendlyLink(target, space?)` takes the string and at most a
fallback space; the runner has nothing else at link-resolution time.

### R4 — One meaning per character

Within this grammar a structural character means one thing wherever it appears.
Position may say _what_ a segment is; it may not be the only thing that says
what a _character_ is.

Source: #6775.

### R5 — Slot vocabularies do not overlap

A value that is legal in one slot must not also be a legal, differently meaning
value in another slot that is written with the same introducer. Space names are
free-form — `createSession` in `packages/identity/src/session.ts` takes any
string as a derivation seed — so any rule that relies on a space never being
named `user` is a rule the fabric does not enforce.

Source: #6775's measured case, `/@session/<handle>@user`, in which two
`@`-introduced tokens written with scope words name opposite dimensions.

### R6 — Survives an interactive shell unquoted

`cf` is typed at a shell, and an address one command prints is pasted into the
next. A character the shell rewrites before the program sees it is not available
to the grammar, whatever it would otherwise mean. This is measured rather than
assumed; the [inventory](#shell-behavior-measured) holds the table.

Source: `docs/tutorial/06-workflow.md` and every `cf` example in
`packages/cli/README.md` are written unquoted.

### R7 — The next qualifier costs no new character

A new way to select which instance or version of a piece is meant is admitted by
registering a name, not by reserving a character. One such qualifier is already
scheduled: the pattern-imports pin.

Source: [Pattern imports](pattern-imports/README.md#specifier-syntax) places
`@<pin>` in the trailing position and reserves `@` for it.

### R8 — Translatable with its siblings

A reference, a shell page URL, and a `cf:` import specifier that name the same
cell translate into one another segment for segment, with no reordering and no
character that one has and another must escape.

Source: shuttle's component table ("Web shell route grammar … keep them mutually
translatable"); `parseFabricUrl` reads both the page URL and the reference
today.

### R9 — Composes across commands

An address one command publishes is the whole target of the next, unchanged: no
reassembly, no flag beside it, no part of it read out and passed separately.

Source: `packages/cli/README.md`, "Every address this CLI publishes is that one
string".

### R10 — Absence is defined per layer; a printed reference relies on none

A reference that omits a part has a defined meaning for the omission, and the
canonical layer's definition is the base: no space means the reader's space, no
scope means `space`. A layer that reads an omission relatively — shuttle reads
an absent scope from the place — writes every part it does not want read that
way. So a shared or printed reference is fully qualified, and the relative
reading is a convenience for typing, never a property of a string in flight.

Source: `createLLMFriendlyLink` writes the space only when it differs from the
context and the scope only when it is not the base; `linksEqual` compares
`scope ?? "space"`; shuttle's grammar records that `pwd` writes the scope suffix
"rather than trusting it to be inferred".

### R11 — The forms that are emitted keep reading

Nothing durable stores a reference string: a sigil link stores `id`, `space`,
`path`, and `scope` as fields (`packages/runner/src/sigil-types.ts`), and the
string is a rendering of those. What does carry the string is rendered markdown,
pasted text, tool output, and documents in this tree. A grammar change therefore
lands, wherever it can, on a form nothing emits, and a form that is emitted
today stays readable.

Source: `createLLMFriendlyLink` is the one renderer, and it takes a
`MemorySpace` (a DID) — so every rendered space is a DID, and a name-shaped
space exists only where a person typed one.

## Character inventory

What each structural character is reserved for, by which grammar, and what it
costs at a shell. The reserved set is deliberately small: a grammar that spends
a character per requirement runs out of characters before it runs out of
requirements, and the shell-safe alphabet below is smaller than it looks.

| Character              | Reserved by                      | Meaning                                                                                                                                                                                                         |
| ---------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                    | this grammar                     | segment separator; `//` at the head opens the space slot                                                                                                                                                        |
| `@`                    | this grammar                     | qualifier introducer on the piece ([D2](#d2--is-the-qualifier-introducer-and-nothing-else))                                                                                                                     |
| `#`                    | this grammar                     | fragment introducer, `#argument` ([D6](#d6-the-fragment-selects-a-secondary-cell)); separately, a leading `#name` on a whole operand is a wish target at `cf`'s intake seams, and shuttle records both readings |
| `~0`, `~1`             | RFC 6901, via the path           | escapes for `~` and `/` inside a path key                                                                                                                                                                       |
| `:`                    | the identifiers                  | inside a DID and a handle (`did:key:…`, `of:fid1:…`); a segment holding one is an identifier, one without is a name                                                                                             |
| `=`                    | this grammar, inside a qualifier | separates a qualifier's name from its value                                                                                                                                                                     |
| `%`                    | shuttle's line                   | a listing handle, `%3`, on a whole operand                                                                                                                                                                      |
| `!`                    | shuttle's line                   | "runs on the local machine", line-initial and in a pipeline                                                                                                                                                     |
| `.`, `..`, `-`         | shuttle's line                   | place tokens, matched against a whole segment or operand                                                                                                                                                        |
| `,` and a trailing `@` | the projection grammar           | list separator, and the address marker on a projected position                                                                                                                                                  |
| a leading `@`          | `--schema`                       | its `@file` form; the projection's own document records the interaction with the trailing marker                                                                                                                |

No character on this table is spent on the space. The space is introduced by
position, and [D1](#d1-the-space-is-positional-introduced-by-) says why.

### Shell behavior, measured

Each candidate was passed unquoted to `printf '[%s]'` under macOS `zsh` and
`bash`, with and without the options an ordinary configuration turns on. What
the program received:

| Written                                                                                  | zsh                       | zsh + `extendedglob` | bash      | Result                                                                      |
| ---------------------------------------------------------------------------------------- | ------------------------- | -------------------- | --------- | --------------------------------------------------------------------------- |
| `$session/board`                                                                         | `/board`                  | `/board`             | `/board`  | the space is **silently dropped**; a valid reference to a different cell    |
| `/board?scope=user`                                                                      | error, `no matches found` | error                | passes    | the command never runs                                                      |
| `/board^user`                                                                            | passes                    | error                | passes    |                                                                             |
| `board#favorites`                                                                        | passes                    | error                | passes    |                                                                             |
| `#favorites`                                                                             | passes                    | swallowed            | swallowed | read as a comment, the argument vanishes (bash interactive, and any script) |
| `/board@user`, `//space/board`                                                           | passes                    | passes               | passes    |                                                                             |
| `/board:user`, `/board%user`, `/board,user`, `/board+user`, `/board=user`, `/board!user` | passes                    | passes               | passes    |                                                                             |

Available to the grammar unquoted, then: `@ : % , + = ! . - /`. Not available:
`$` (silent, in every shell), `?` and `^` (a glob), `#` at the head of a word (a
comment), and the glob and expansion set `* [ ] { } ~`.

Two things this table settles. A `$`-introduced space is not a matter of taste:
it produces a different valid reference with no error, the worst failure a
grammar can have. And a `?`-introduced query — the right _idea_ for a qualifier,
and the URL's own — is the wrong character for it at a `zsh` prompt.

The `#` row records a hazard the grammar already carries: a bare `#favorites` is
a comment to `bash` and to every script, and survives only at an interactive
`zsh` prompt with stock options. That is outside this document's decisions and
is recorded so the next reader of the wish syntax finds it measured.

## Decisions

Each decision names the requirements it serves, the alternatives it rejected,
and the existing decisions it confirms or replaces.

### D1. The space is positional, introduced by `//`

```text
//<space>/<piece>…      space-qualified
/<piece>…               the reader's space
```

The space carries no sigil. A reference that opens with `//` names its space in
the segment that follows, exactly as a URL names its authority; one that opens
with a single `/` is in whatever space the reader is in. The space segment is a
DID or a name; a segment holding `:` is a DID, and one without is a name only a
session-holding reader can resolve — which is the rule `parseReferenceParts`
already applies to the piece segment, now applied to both.

Serves R4, R5, R7, R8. Taking `@` off the space is what gives `@` one meaning
([D2](#d2--is-the-qualifier-introducer-and-nothing-else)); it also ends the
vocabulary overlap of R5 at its source, since a scope word can no longer be
written where a space name is expected. And it is the shape the sibling grammars
already have.

**Confirms.**
[Pattern imports](pattern-imports/README.md#one-grammar-no-type-tag) qualifies
the space by slash depth — `cf:<ref>`, `cf:/<space>/<ref>`,
`cf://<host>/<space>/<ref>` — and rejected a leading-`@` namespace in so many
words ("reads like npm, which is exactly the problem"). The shell's page URL is
`/<space>/<piece>` with no sigil, and shuttle's component table asks that the
two stay mutually translatable.

**Replaces.** The `/@<space>/` prefix `parseReferenceParts` reads and
`createLLMFriendlyLink` writes. [Migration](#migration) keeps the DID form of it
readable.

**Rejected.**

- `$<space>` — silently expanded by every shell; the
  [table](#shell-behavior-measured) shows the space vanishing without an error.
- `./<piece>` for the reader's space, with `/<space>/<piece>` absolute — the
  filesystem's shape, and Ben Follington's third option on #6775. It redefines
  `/of:fid1:…`, the one form everything emits, from "piece in my space" to
  "space named `of:fid1:…`", against R11. `//` costs nothing: a doubled slash at
  the head is an empty first segment today, and `parseReferenceParts` refuses
  it, so the position is free to claim.
- Keeping `/@<space>/` and reserving the scope words as space names — closes the
  measured collision and leaves `@` with two meanings, R7 unserved, and a
  reserved-word rule on a value the fabric otherwise never validates.

**Cost, stated.** RFC 6901 reads `//` as an empty token. The reference is not a
pointer — its head segments are not path keys — and no reader of one has ever
been offered an empty first segment, so the reading is not one anyone holds; but
it is the one objection to `//`, and it is recorded rather than argued away.

### D2. `@` is the qualifier introducer, and nothing else

`@` introduces a qualifier on the piece segment: a statement about _which_ of
that piece is meant, without changing _what_ is meant. Which instance (scope)
and which version (pin) are the two the grammar registers. A qualifier is
written `@name=value` and attaches to the segment on its left; several are
written one after another.

Serves R4, R7. One meaning, one position, and a name rather than a character per
qualifier.

**Confirms.** The trailing `@<pin>` of
[pattern imports](pattern-imports/README.md#specifier-syntax), and that
specification's reservation of the character: "Slugs, space names, DIDs, and
hosts cannot contain `@`". The scope suffix `parseScopedIdSegment` reads today
is a qualifier under this decision and keeps its form
([D3](#d3-the-scope-keeps-its-abbreviation)).

**Replaces.** `@` as the space introducer
([D1](#d1-the-space-is-positional-introduced-by-)). Once that goes, the two
grammars that write a trailing `@` — this one for the scope, pattern imports for
the pin — agree on what the character is, and a future convergence of the two
puts no two meanings in one position.

**On the direction the precedent points.** Every established trailing-`@`
convention puts the _container_ or the _version_ after the `@`: `user@host`,
`image@sha256:…`, `pkg@1.2.3`. A scope is neither — it selects among parallel
instances of one thing — so `tracker@user` cannot lean on the email intuition
and must be learned. The named form makes that explicit: `@scope=user` reads as
the statement it is, and the abbreviation is there for the reader who already
knows.

**Rejected.**

- A second character for the scope, leaving `@` to the space — serves R4 and
  nothing else: the pin still lands on `@` in the sibling grammar, and the next
  qualifier after that needs a third character from an alphabet the
  [table](#shell-behavior-measured) shows has almost none left.
- `?scope=user`, the URL's query — the right model, and Ben Follington's second
  option on #6775; the character fails R6 under `zsh`.

### D3. The scope keeps its abbreviation

```text
@user          ≡  @scope=user
@session       ≡  @scope=session
@space         ≡  @scope=space       (the base; the renderer omits it)
@inherit       ≡  @scope=inherit
```

A bare word after `@` is a scope value and nothing else. Only the scope gets
this: it is the qualifier people type, its four values are a closed set the
runtime owns, and a qualifier _name_ is never written bare, so a bare word is
never ambiguous between the two. A bare word that is not a scope value is
refused with a message naming the `@name=value` form.

Serves R2 (the four values of `LinkScope` are all writable; today `inherit` is
not), R11 (every `@user` and `@session` in the tree and in flight reads
unchanged).

**Confirms.** The scope suffix of `parseScopedIdSegment`, and the
`space < user < session` lattice of
[scoped cell instances](scoped-cell-instances.md#summary).

**On `inherit`.** In a stored link, `inherit` means "the containing cell's
scope", and `parseLink` resolves it against its base before a full link exists,
which is why the renderer has never had one to write. As a written qualifier it
is the explicit form of the relative reading R10 describes: a context-holding
reader that reads an absent scope from its place has a way to say so on a
printed line, and a canonical reader that has no place refuses it rather than
guessing.

### D4. Qualifiers repeat; a name appears once

```text
/glaze-tracker@user@pin=Avcny…rC1c/items
```

Each qualifier is introduced by its own `@`. Order carries no meaning, and a
name written twice is refused. A qualifier's value runs to the next `@`, `/`, or
`#`, so a value holds none of those three; every registered value is drawn from
an alphabet that excludes them (scope words are letters; a pin is base64url). A
value that ever needs one of them takes percent-encoding, which is the URL's
answer and the one the shell page URL already applies.

Serves R3, R7.

**Rejected.** `@scope=user,pin=…`, one `@` and a `,`-separated list — `,` is the
projection grammar's list separator, so an address written inside a `--select`
list would need escaping there, against R9.

### D5. Registered qualifiers

| Name    | Values                                              | Bare form            | Read by                                                                                                             |
| ------- | --------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `scope` | `space`, `user`, `session`, `inherit`               | yes, the value alone | every reader; `inherit` is refused by a reader with no context                                                      |
| `pin`   | 43 base64url characters, a selected module identity | no                   | reserved by [pattern imports](pattern-imports/README.md#specifier-syntax); not read by the runner's link resolution |

A name not on this table is refused, with the message naming the table. Adding a
row is the whole cost of a new qualifier
([Admitting a new requirement](#admitting-a-new-requirement)).

### D6. The fragment selects a secondary cell

```text
/glaze-tracker@user/items#argument
```

`#argument` closes the reference and selects the piece's arguments cell, the
selection `--input` writes as a flag; the path applies inside the selected cell.
The fragment is last because it is a fragment: it names a cell that belongs to
the piece the rest of the reference names, and a URL puts that after everything
else. It is the one fragment. Any other is refused, and a path key containing
`#` takes the positional path spelling, as `splitArgumentSuffix` in
`packages/cli/lib/llm-friendly-ref.ts` records.

Serves R4 (a fragment is not a qualifier: it changes _what_ cell is named, not
_which_ instance of it), R8.

**Confirms.** The `#argument` suffix and its position. The shell hazard on `#`
is [recorded](#shell-behavior-measured) and not decided here; a reference
carrying `#argument` has the `#` mid-word, where only `extendedglob` touches it.

### D7. What a renderer writes

A renderer writes the space only when it differs from the reader's, the scope
only when it is not the base, and every other qualifier whenever it holds one.
So the common case renders as `/<piece>/<path>` and nothing else, and a _fully
qualified_ rendering — every slot written — is what a shared link, a `pwd`, and
any string meant to be read from somewhere else carries.

Serves R9, R10, R11.

**Confirms.** `createLLMFriendlyLink`'s two omission rules, and shuttle's
grammar on what `pwd` prints and why.

### D8. The space segment's vocabulary

A space segment is a DID or a name. It may not contain `/` (the separator) or
`@` (a qualifier never attaches to a space, and `createSession` accepts any
string, so this is the one rule a space name is held to). No word is reserved: a
space named `user` is written `//user/…`, and nothing else in the grammar can be
written that way.

Serves R5. This is where the reserved-word alternative under D1 becomes
unnecessary: the collision was between two `@`-introduced slots, and once only
one slot is `@`-introduced there is nothing to reserve.

### D9. The reference names a cell, not how to read it

A schema, a projection, a filter, a write-redirect flag: each is a statement
about the read or the write, not about the cell, and each stays a flag. The
reference carries identity and nothing else.

Serves R9 (an address is passed on whole because there is nothing in it a reader
would want to strip) and keeps R7 honest: "no new character" is only true if the
grammar refuses the requirements that are not addressing.

**Confirms.** `packages/cli/README.md`: "No schema is inlined and no
write-redirect flag rides along."

## Examples

Every combination the grammar admits, with `bakery` a space name,
`did:key:z6MkBakery` its DID, `glaze-tracker` a slug, and `of:fid1:Glz…` the
handle behind it. A row's meaning is what a reader with no place and no session
takes from the string; a session-holding reader resolves the names to the same
cells.

| Written                                          | Space                  | Piece  | Scope         | Path            | Cell                                                      |
| ------------------------------------------------ | ---------------------- | ------ | ------------- | --------------- | --------------------------------------------------------- |
| `/of:fid1:Glz…`                                  | the reader's           | handle | `space`       | root            | the piece's result                                        |
| `/glaze-tracker`                                 | the reader's           | slug   | `space`       | root            | the same, by name                                         |
| `/glaze-tracker/items/0/title`                   | the reader's           | slug   | `space`       | `items/0/title` | one field                                                 |
| `/glaze-tracker@user`                            | the reader's           | slug   | `user`        | root            | the reading user's instance                               |
| `/glaze-tracker@scope=user`                      | the reader's           | slug   | `user`        | root            | the same, written in full                                 |
| `/glaze-tracker@session/items`                   | the reader's           | slug   | `session`     | `items`         | this session's instance                                   |
| `/glaze-tracker@inherit`                         | the reader's           | slug   | the context's | root            | refused by a reader with no context                       |
| `//bakery/glaze-tracker`                         | `bakery`               | slug   | `space`       | root            | needs a session to resolve both names                     |
| `//did:key:z6MkBakery/of:fid1:Glz…`              | the DID                | handle | `space`       | root            | resolvable from the string alone                          |
| `//did:key:z6MkBakery/of:fid1:Glz…@user/items/0` | the DID                | handle | `user`        | `items/0`       | fully qualified: the same cell from anywhere              |
| `//user/glaze-tracker@user`                      | a space _named_ `user` | slug   | `user`        | root            | no ambiguity: the space slot is not `@`-introduced        |
| `/glaze-tracker@pin=Avcny…rC1c`                  | the reader's           | slug   | `space`       | root            | pinned to one module identity; the runner ignores the pin |
| `/glaze-tracker@user@pin=Avcny…rC1c`             | the reader's           | slug   | `user`        | root            | two qualifiers; order is free                             |
| `/glaze-tracker#argument`                        | the reader's           | slug   | `space`       | root            | the arguments cell                                        |
| `/glaze-tracker@user/items#argument`             | the reader's           | slug   | `user`        | `items`         | inside the arguments cell                                 |

Refused, and why:

| Written                     | Refusal                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `/@bakery/glaze-tracker`    | a name-shaped `@` space: the message names `//bakery/…`                                                |
| `/glaze-tracker@owner`      | not a scope value: the message names `@name=value` and the registered names                            |
| `/glaze-tracker@user@user`  | a name written twice                                                                                   |
| `/glaze-tracker@color=pink` | a name not on the table                                                                                |
| `//bakery`                  | a space and no piece                                                                                   |
| `/glaze-tracker#items`      | not the one fragment                                                                                   |
| `glaze-tracker/items`       | not rooted: a bare form, read by the CLI's alias and by shuttle relatively, and by no canonical reader |

## Translation to the sibling grammars

The same cell in each grammar, segment for segment (R8):

| Reference                           | Shell page URL                                   | Import specifier                      |
| ----------------------------------- | ------------------------------------------------ | ------------------------------------- |
| `/glaze-tracker/items`              | `https://<host>/<my-space>/glaze-tracker/items`  | `cf:glaze-tracker`                    |
| `//bakery/glaze-tracker`            | `https://<host>/bakery/glaze-tracker`            | `cf:/bakery/glaze-tracker`            |
| `//did:key:z6MkBakery/of:fid1:Glz…` | `https://<host>/did:key:z6MkBakery/of:fid1:Glz…` | `cf:/did:key:z6MkBakery/of:fid1:Glz…` |
| `/glaze-tracker@pin=Avcny…rC1c`     | —                                                | `cf:glaze-tracker@Avcny…rC1c`         |

The page URL has no scope and no pin; the specifier has no scope and no path
into a cell. Where a slot exists in two of them it is in the same position and
written the same way, and the one written difference — the specifier's bare
`@<pin>` against the reference's `@pin=` — is the specifier's own to close when
it next changes, since a bare word after `@` is the scope's under this grammar.

## Admitting a new requirement

A new requirement is written into [Requirements](#requirements) first, with its
source. Then it is placed by asking, in order:

1. **Does it select which instance or which version of the named piece?** It is
   a qualifier: register a name in [D5](#d5-registered-qualifiers), state its
   value alphabet, and say which readers read it. No character is spent.
2. **Does it select a different cell that belongs to the piece?** It is a
   fragment value beside `#argument`. Today there is one; a second is a row, not
   a character.
3. **Does it change where the reference resolves** — a host, a different
   authority than a space? It belongs in the `//` slot, where a URL puts an
   authority, and the [open question](#open-questions) on hosts is where that
   goes when it is needed.
4. **Does it change what is inside the cell that is named?** It is a path
   segment, and RFC 6901 already says how to write any key.
5. **Is it about how to read or write, rather than what?** It is a flag
   ([D9](#d9-the-reference-names-a-cell-not-how-to-read-it)), and this document
   does not admit it.

A requirement that survives all five is the case for a new structural character,
and the [measured table](#shell-behavior-measured) says which characters there
are to spend: `: % , + ! . -`, of which `:` is inside every identifier, `%` and
`!` are shuttle's, and `,` is the projection's. That is the whole reason the
grammar spends names rather than characters.

This is what makes the mechanism reasonable rather than merely tidy. Four
independent uses of `@` accrued on the `cf` surface — the space, the scope, the
projection's address marker, `--schema`'s file form — because a character is the
cheapest thing to reach for and nothing said which slot was open. A named slot
is as cheap to add to and cannot collide with the last one.

## Migration

Nothing durable stores a reference string (R11), so the migration is in parsers,
renderers, and prose, in this order. Each step is a separate change that leaves
the tree consistent.

1. **Read the new forms.** `parseReferenceParts` reads `//<space>/`,
   `@name=value`, repeated qualifiers, and `@inherit`; `parseScopedIdSegment`
   becomes the qualifier parser. The `/@did:key:…/` prefix stays readable as an
   alias for `//did:key:…/` — it is what has been rendered into markdown and
   pasted into text, and a DID after `@` is self-identifying. The name form
   `/@<name>/` is refused with a message naming `//<name>/`: nothing has ever
   rendered it. `parseFabricUrl` reads `//<space>/` alongside the alias. The
   CLI's `validateEmbeddedSpaces` and completion providers follow the same
   split.
2. **Write the new forms.** `createLLMFriendlyLink` writes `//<space>/` and its
   qualifiers under [D7](#d7-what-a-renderer-writes). From here every address
   the CLI publishes is in this grammar.
3. **Documents and tests.** The live documents that quote the form: the grammar
   line in `packages/cli/README.md` and `docs/common/verbs/over-the-cli.md`; the
   examples in `docs/tutorial/06-workflow.md`; the doc comment on
   `packages/cli/lib/llm-friendly-ref.ts`; the open question in
   `docs/plans/shuttle/grammar.md`, which this document closes; and the
   `/@my-space/` rows in `docs/plans/cli-surface-shape.md`. Tests and pattern
   baselines that hold a rendered reference follow the renderer.
4. **The specifier's pin.** When [pattern imports](pattern-imports/README.md)
   next changes its specifier syntax, its bare `@<pin>` becomes `@pin=`, or it
   records why the specifier keeps a bare form the reference does not.

The alias in step 1 is the one place `@` keeps a second reading on input, and it
is confined to a segment that begins `@did:`, which no scope word or qualifier
name can. It is documented as an alias, not as grammar, and a later change may
retire it once rendered markdown from before step 2 is judged old enough.

## Relationship to existing decisions

| Decision                                                                                  | Where                                                                                   | This document                                                                                 |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| The reference is the one syntax; the bare form is an alias that never leads               | `packages/cli/README.md`; `llm-friendly-ref.ts` doc comment                             | confirms (R1)                                                                                 |
| Space by slash depth; leading `@` namespace rejected                                      | [Pattern imports](pattern-imports/README.md#alternatives-considered)                    | confirms and extends to the reference (D1)                                                    |
| `@` reserved for the trailing qualifier; the pin lives there                              | [Pattern imports](pattern-imports/README.md#specifier-syntax)                           | confirms (D2); asks the pin to take a name (D5, migration step 4)                             |
| Scope is expressible in every layer, on a `space < user < session` lattice                | [Scoped cell instances](scoped-cell-instances.md)                                       | confirms, and gives `inherit` its written form (D3)                                           |
| The space rides in front only when it differs; the scope only when not the base           | `createLLMFriendlyLink`; `packages/cli/README.md`                                       | confirms (D7)                                                                                 |
| `pwd` writes the scope rather than trusting it inferred; canonical absence means the base | [Shuttle grammar](../plans/shuttle/grammar.md#place-resolution)                         | confirms (R10, D7)                                                                            |
| Shuttle invents no spelling; a second scope spelling would be worse                       | [Shuttle README](../plans/shuttle/README.md), decision 13; its grammar's open questions | confirms: this document is the one place a spelling is decided                                |
| Page URL and reference stay mutually translatable                                         | [Shuttle README](../plans/shuttle/README.md#what-exists-to-build-on)                    | confirms (R8, D1)                                                                             |
| `#argument` is the one fragment, last, before anything else parses                        | `splitArgumentSuffix`                                                                   | confirms (D6)                                                                                 |
| The projection grammar is its own; `--schema @` is the file form                          | `packages/cli/README.md`, "Asking for an address instead of contents"                   | confirms as out of scope; records the borrowed characters                                     |
| The space is written `/@<space>/`                                                         | `parseReferenceParts`; `createLLMFriendlyLink`                                          | **replaces** (D1)                                                                             |
| A bare `@word` is the whole qualifier vocabulary                                          | `parseScopedIdSegment`, `CELL_SCOPE_VALUES`                                             | **replaces** with the named form; the bare form survives as the scope's abbreviation (D2, D3) |

## Open questions

- **A host slot.** `cf://<host>/<space>/…` names a toolshed; the reference has
  no host, because a connection serves one space and shuttle's v1 holds one
  connection. When a reference needs to name its host, the URL's answer is the
  `//` slot — `//<host>/<space>/<piece>` — and a host is distinguishable from a
  space by holding a `.` or a `:<port>` where a DID holds `did:` and a name
  holds neither. Whether that is enough, or whether the host wants its own
  introducer, is decided when a reader needs it and not before.
- **`#` at a shell.** The measured hazard on a leading `#` is real and predates
  this document. Whether the wish syntax moves, and to what, is a decision for
  the wish surface; the fragment's mid-word `#` is not affected.
- **The projection's trailing `@`.** It is a different grammar with its own
  document, and `@` there means "the address of this position". It is listed
  here so that a reader who finds four uses of `@` on the `cf` surface knows
  that two of them are this grammar's and settled, and two are the projection's
  to keep or change.
