# Short names for items in collections

A collection gives each of its items a short name that a person can remember,
type, say out loud, and cite: `top-42` for item 42 of a board that calls itself
`top`. This document defines where such a name lives, how it resolves, how a
renderer chooses which spelling to show, and what has to be in place before a
collection can mint one.

It governs any collection that wants short names for its children, not one
kind of board. Topics is the first customer; nothing here is specific to it.

## Three layers of name

An item carries up to three names at once, and they are not interchangeable.

| Layer | Example | Guarantee |
| --- | --- | --- |
| Identity | `fid1:…` | immutable, never reused, never retargeted |
| Handle | `top-42` | short and citable; minted by a collection, never reused |
| Name | `verb-contract-arc` | human-chosen; mutable, non-unique, retargetable |

The identity is what a stored reference resolves to. The handle is what a
person cites. The name is a convenience that may move. Conflating the second
and third is what makes a citation unreliable: a reader handed a link cannot
tell whether it is permanent.

## Names resolve through collections

A space is the root namespace. Any collection inside it may host a namespace of
its own, and a name resolves by walking segments:

```text
<space>/top/42                  a handle in a numeric collection
<space>/docs/getting-started    a string-named child
<space>/verb-arc                a space-level slug
```

Slugs generalize from space-scoped to collection-scoped. The grammar, the
derivation, and the claim semantics are the same one level down; only the scope
of the lookup changes. A collection needs no prefix registry and no new
document type. A prefix is a slug that points at a collection, and a handle is
a name that collection resolves.

**The collection resolves its own children, not the piece containing it.** A
piece holding three collections is not one namespace with internal routing; it
is three collections, each declaring its own prefix. A slug may point at a
collection nested inside a piece rather than at a piece root, which is what
makes this addressable without a new mechanism — `setPieceSlug`
(`packages/cli/lib/piece.ts`) accepts a source path and links the cell at that
path.

### Why not a reserved sub-grammar

A tempting alternative gives handles a reserved shape inside the flat
space-level namespace — a segment ending in hyphen-digits is a handle, anything
else is a slug — so that `<space>/top-42` resolves without a collection
segment. It does not generalize. A flat namespace hosts exactly one unreserved
naming scheme; every additional scheme has to claim a distinguishable shape,
and shapes are scarce. The second collection wanting string-named children has
nothing left to claim, because "hyphenated words" is the entire slug grammar.
Resolving by longest-prefix match instead is worse: creating the name
`verb-arc` would make an existing reference to `verb/arc` ambiguous, so a write
in one namespace would break reads in another.

Segment walking costs one path segment in a URL and leaves the slug grammar
untouched.

## Minted children and chosen children

A collection may allocate its children's names or accept them from a person.
The mechanics are identical; the guarantees are not.

| | Minted | Chosen |
| --- | --- | --- |
| Allocated by | the collection | a person |
| Unique | by construction | requires claim-if-absent |
| Stable | permanent, never reused | renameable, retargetable |
| Is | an identifier | a slug scoped to a collection |

Which a collection mints is part of what it promises about its children, and it
belongs in the collection rather than in the resolution grammar. `top/42` is
citable forever; `docs/getting-started` is a name that may move.

### Minted handles are numeric

Digits beat a short random code on every axis that matters for a name a person
handles. `42` is one chunk over an alphabet automatized in childhood;
a four-character alphanumeric code is four unrelated chunks, plus a case
question and homoglyph confusion between `0`/`O` and `1`/`l`. Spoken, a number
survives a hallway conversation and a code does not. A dense sequence also
locates itself in time — a low number is old, a high one recent — which no
random name can do. And it stays short: per-collection numbering keeps a
working collection at two or three digits for years, while an uncoordinated
scheme is opaque from its first item and can never shrink.

The price is a coordination point, and it is small at collection scale.

### Allocation is lazy

An item receives its identity when it is created and its handle when the
collection first sees it. The handle is a label, not the identity, so
allocation may be retroactive and can never be wrong: an item without a handle
still exists, still links, and still opens. This removes any dependence on
allocation being available at creation time.

Numbers are never reused and never reassigned. An item that moves to another
collection keeps its identity, gains a handle there, and keeps resolving under
the old one. Burned numbers are harmless.

### Contention

Appends to a collection merge: Tier-2 conflict detection is path-aware, so
concurrent writes to distinct keys of the same container do not collide
(`docs/specs/memory-v2/08-conflict-granularity.md`). A handle map keyed by
number inherits that. An allocation counter does not — it is a same-path read
and write, so concurrent allocations serialize through one retry under
`editWithRetry`. That is the whole cost, and it is paid once per creation.

## Resolution scope

A prefix is a name, and a name resolves through a scope chain, innermost
first:

1. the containing collection's own declared prefix
2. other collections bound in that scope
3. the reader's home-space bindings
4. space-level slugs

This is ordinary lexical scope. A person subscribes to a collection by binding
a name to it in their own home space, beside the cross-space lists the home
default pattern already holds (`docs/common/conventions/HOME_SPACE.md`). A
binding in a person's own space is the one place where nobody else is renaming
things.

### The elision rule

> A local binding may be elided exactly when its name is identical to the name
> its target declares for itself — and the elision is checked, not assumed.

A short form is then an assertion that the reader's vocabulary and the target's
agree, which the resolver verifies. Expansion is total and single-candidate:
`p-n` expands to `p/p-n`, resolves, or fails. It never selects among
candidates.

Two properties follow. At most one binding per prefix can be elided, because
only one binding can carry that name — a default expressed as a naming act
rather than as a flag. And a name that stops matching fails loudly instead of
resolving to something else.

**An alias never appears in handle position.** A binding name appears only as a
scope selector; a declared prefix appears only as part of an item's own name.
The grammar therefore says which kind of name is in hand without context, and
the two can never be substituted for one another.

### Nothing hidden decides what a name means

If a bare name is ambiguous, it is an error, or it is settled by an explicit,
visible, editable binding. Recency may order a picker; it may never decide the
meaning of text. A reference whose meaning depends on invisible state means
different things on different days, and nothing in the string says which.

## Prose and URLs

A URL has segments to separate scope from name. Prose does not, so prose uses a
sigil, and the sigil is what lets a short form be safely compressed:

> Compress where there is a sigil; keep segments where there is not.

| Form | Means |
| --- | --- |
| `#42` | child 42 of the collection this text is in |
| `#top-42` | child 42 of the collection bound to `top` in scope |
| `#work/top-42` | the same, with the binding named explicitly |
| `#@<space>/top-42` | fully qualified; depends on no binding |

`#` already means "resolve this name in the fabric" for wish tags, and the two
grammars do not overlap. A leading `@` marks a space segment, matching what
`asSpaceSegment` (`packages/runner/src/fabric-url.ts`) already recognizes, and
it keeps a binding name and a space name from competing for the same slot.

`#` cannot appear in the URL form, where it delimits the fragment. The prose
form and the URL form differ by construction, and the canonical URL carries the
handle in its segments, so nothing is lost between them.

### The bare form

`#42` names no collection. It is relative, cannot be wrong about which
collection it means, and is well defined only where the surrounding context
resolves to exactly one collection. Rendering an item gives that context;
a view holding several collections does not, and there the bare form is an
error rather than a guess.

## Rendering

A stored reference is canonical, so its spelling is free. **A renderer computes
the spelling from the reader's context and never stores it.** The same
reference renders as `#42` inside its own collection, `#top-42` where the
reader's `top` binds there, `#work/top-42` where it binds elsewhere, and fully
qualified where the reader has no binding at all.

This is what makes a curated set of prefixes safe. Brevity is earned by the
reader's own bindings; a reader without them sees more qualification; nobody
sees a wrong name.

The invariant: **a reader's bindings change how a reference is spelled, never
what it means.** Rendering is a spelling function over a fixed target, not a
resolution step. Adding a binding shortens existing text without moving
anything.

### Choosing the spelling

Not by rules about context, but by round trip: try spellings shortest to
longest, and use the first that, re-resolved under this reader's resolver,
returns the identical target. A short form is displayed only when re-resolving
it provably comes back to the same item.

The default display is prefix-qualified rather than bare. A screenshot of `#42`
is unrecoverable; `#top-42` is recoverable by anyone who knows one prefix.

### Two modes, chosen by destination

- **In place** — read inside the application. Adaptive shortest spelling.
- **Portable** — export, copy-as-markdown, print, anything generated to leave.
  Always fully qualified, whatever the renderer's context.

The mode follows where the output is going, not what the content is. Surfaces
designed to travel never emit a context-dependent spelling.

### Copying

A copy carries several representations, and each is set deliberately:

| Flavor | Contents | Lands in |
| --- | --- | --- |
| `text/html` | an anchor to the canonical URL, labeled with the short form | rich editors |
| `text/plain` | the canonical URL | terminals, commit messages, chat |

The plain-text flavor is the lossy channel, so it carries the self-contained
form rather than the displayed one. The canonical URL is the qualified name
plus a host, so the handle stays legible in pasted text and resolves where no
resolver exists.

Screenshots, speech, and retyping carry only what is visible. That residue is
why the displayed form stays prefix-qualified by default.

## Storage

References canonicalize on write. A stored reference never depends on any
reader's bindings, so two people whose bindings disagree cannot break each
other's links. The short form is an input and display convenience at both ends,
and the middle is always qualified.

## Authority

Space ACLs are space-granular: a principal is evaluated against the space ACL
document for every command, with READ, WRITE, and OWNER ordering
(`docs/specs/memory-v2/04-protocol.md`). There is no per-document
authorization, so no address in a space is protected from a principal who can
write the space. Per-document authority arrives with UCAN-authorized commands.

This design therefore does not prevent a name from being taken; it makes taking
one impossible by accident and detectable when deliberate.

- Handles live in the collection that mints them, so a person choosing a name
  cannot land on one. Retargeting a handle means writing the collection's own
  cell through its own actions — a visible edit, not a silent redirect on an
  invisible document.
- The prefix binding is the one name that remains exposed, and it fails loudly:
  every reference through it breaks at once, and one write repairs it.
- A collection stores its own declared prefix, so a resolver can verify that
  the binding and the target agree and report a mismatch.

## Implementation road

Each step is usable on its own, and the order is load-bearing.

**1. Restructure the reverse map.** A piece carries one single-valued `slug`
entry in its metadata, written by `setSlugLink` (`packages/piece/src/slugs.ts`)
and read by `handlePageGetSlug`
(`packages/runtime-client/backends/runtime-processor.ts`); the shell rewrites a
visited identity URL to that name. One slot cannot hold both a handle and a
human name, so the canonical URL becomes whichever was written last. Two
further gaps close here: the entry is never cleared from a previous target when
a name is retargeted, and `setPieceSlug` writes target metadata only for piece
roots, so a collection-targeted name has no reverse entry at all. The map needs
a structured form that distinguishes handle from name and designates one as
canonical. **This is a prerequisite: minting handles before it lands makes URL
rewriting nondeterministic.**

**2. Make name assignment refuse by default.** `setSlugLink` does not read the
slug cell before writing it, so assigning an assigned name overwrites it
silently. Sync the cell, read it inside the transaction, refuse when it is
already bound, and take an explicit flag to steal. `editWithRetry` re-runs its
body on a retryable rejection, so the check is a claim rather than a
time-of-check race. Confirm that a synced read inside the transaction becomes a
commit precondition before relying on it.

**3. Give collections child namespaces.** A collection declares its prefix,
holds a map from child name to link, and allocates lazily. Minting collections
add a counter; accepting collections reuse the claim from step 2 at collection
scope. Widen `resolvePieceAddress` (`packages/piece/src/slugs.ts`), which
rejects a name whose target has no pattern identity, so that a name pointing at
a collection nested in a piece is not treated as an error.

**4. Walk segments in the URL layer.** `parseFabricUrl`
(`packages/runner/src/fabric-url.ts`) reads a trailing segment as a slug and
the rest as a cell path. Resolution of `<space>/<collection>/<child>` follows
from letting a resolved collection resolve the next segment. The slug grammar
in `packages/runner/src/slugs.ts` does not change.

**5. Add the prose layer.** Sigil parsing, canonicalize-on-write,
context-computed rendering with round-trip verification, the two render modes,
and the clipboard flavors.

## Open questions

- Whether a synced read inside an `editWithRetry` body becomes a commit
  precondition, which is what step 2 rests on.
- Whether a collection accepting chosen names reuses the space-level claim path
  or needs its own.
- Whether the scope chain admits bindings from a collection to its siblings, or
  stops at the containing collection and the reader's own bindings.
