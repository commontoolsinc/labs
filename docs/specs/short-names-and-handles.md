# Short names for items in collections

A collection gives each of its items a short name that a person can remember,
type, say out loud, and cite: `top-42` for item 42 of a board that calls itself
`top`. This document defines where such a name lives, how it resolves, how a
renderer chooses which spelling to show, and what has to be in place before a
collection can offer one.

It governs any collection that wants short names for its children, not one
kind of board. Topics is the first customer; nothing here is specific to it.

**This standardizes the edges, not the policies.** A collection chooses its own
child-naming mechanism and its own rules about what those names mean over time.
What is standardized is the boundary around that choice: how a collection
declares itself, how its children are addressed and resolved, how a reference
is stored, and how a spelling is rendered — so that any consumer in the fabric
can name and cite a child without knowing how the collection arrived at the
name.

## Three layers of name

An item carries up to three names at once, and they are not interchangeable.
Only the first is guaranteed to exist.

| Layer | Example | Who states the guarantee |
| --- | --- | --- |
| Identity | `fid1:…` | the fabric: immutable, never reused, never retargeted |
| Handle | `top-42` | the collection that owns it |
| Space-level name | `verb-contract-arc` | the space: mutable, non-unique, retargetable |

A **handle** is a collection's name for one of its children, and the word
carries no policy: it says who assigned the name, not what the name promises.
The identity is what a stored reference resolves to. A handle is what a person
cites. A space-level name is a convenience that may move. The layers differ in
who owns the guarantee rather than in how strong it is: a collection may hold
its child names to something stronger than a space holds its slugs, or to
something weaker, and a consumer learns which by asking rather than by assuming.

## Names resolve through collections

A space is the root namespace. Any collection inside it may host a namespace of
its own, and a name resolves by walking segments:

```text
<space>/top/42                  a handle in a collection that numbers
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
else is a slug — so that `<space>/top-42` resolves without a collection segment.
 It does not generalize. A flat namespace hosts exactly one unreserved
naming scheme; every additional scheme has to claim a distinguishable shape,
and shapes are scarce. The second collection wanting string-named children has
nothing left to claim, because "hyphenated words" is the entire slug grammar.
Resolving by longest-prefix match instead is worse: creating the name
`verb-arc` would make an existing reference to `verb/arc` ambiguous, so a write
in one namespace would break reads in another.

Segment walking costs one path segment in a URL and leaves the slug grammar
untouched.

## What a collection owes, and what it decides

**Naming children is optional.** Every item already has an identity, and that
identity addresses it on its own, from anywhere, with no collection involved. A
collection whose members are reached by identity alone needs nothing from this
document. What follows applies only when a collection wants its members
addressable *through it*, under a name a person can hold — and a collection may
want that for some of its members and not others.

A collection that does want it declares four things, and beyond them it is
free.

1. **A prefix** — the name other things bind to in order to reach it.
2. **A resolution** — given a child name, the link it currently names.
3. **Child names that fit the shared grammar**, so that each survives a URL
   segment and a prose citation.
4. **The policy it holds those names to**, published rather than implied.

The fabric adds one constraint, and only one: **at any moment, a child name
resolves to at most one child.** A resolver returns a target or nothing; it
does not return a set, because a URL and a citation each address one thing.
That constraint says nothing about what happens across moments.

### Policies a collection owns

What a name means over time belongs to the collection, and different
collections will decide differently for good reasons:

- whether a name is unique across the collection's whole history, or only
  among its current children
- whether a name is permanent, or may be retired, reassigned, or reused
- whether a retired name forwards to a successor, errors, or goes quiet
- whether a name is mutable, and who may change it
- who allocates — the collection, or the person creating the child
- when allocation happens — at creation, on first sight, or on request
- what a name is made of — a sequence, a random code, a human string, a
  derivation from content

None of these is settled here, and a collection need not give every child it
holds the same answers.

### What a consumer may assume

Only what the collection declares. Absent a declaration a consumer assumes
nothing: it stores the identity rather than the name, and it re-resolves a short
spelling before showing it. Both of those are required elsewhere in this
document for their own reasons, which is what makes an undeclared policy safe
rather than merely unknown — the conservative path is already the default path.

A consumer that needs to hold a name rather than an identity — a printed
citation, an external system, a message leaving the fabric — needs the
collection to promise permanence, and should say so plainly when it cannot get
one.

### Choosing a mechanism

Non-normative, for a collection author deciding.

A **monotonic sequence** is the strongest choice for a name people handle. `42`
is one chunk over an alphabet automatized in childhood; a four-character
alphanumeric code is four unrelated chunks, plus a case question and homoglyph
confusion between `0`/`O` and `1`/`l`. Spoken, a number survives a hallway
conversation and a code does not. A dense sequence also locates itself in time
— a low number is old, a high one recent — and it stays short, holding a
working collection at two or three digits for years where an uncoordinated
scheme is opaque from its first item and can never shrink. The price is an
allocation point.

A **random code** buys allocation without coordination, which suits a
collection whose children are created offline, or at a rate that makes a shared
allocator unattractive. It pays in memorability, and its density has to be
chosen against the collection's expected size rather than against aesthetics.
Widening on collision beats lengthening by default.

A **human string** suits a collection whose children are things people name
rather than count — pages, documents, entries with titles. It inherits the
questions a space-level name already faces: what a rename does, and what
happens when two people want the same word.

A **derivation from the child's own content or identity** needs no allocation
and is stable by construction, at the cost of being unmemorable and of needing
prefix-expansion behavior on collision.

**Allocating on first sight rather than at creation** is worth weighing
whichever mechanism is chosen. A child receives its identity when it is
created; if its name may arrive later, allocation never blocks creation and can
be retroactive, and a child without a name yet still exists, still links, and
still opens.

### If the mechanism needs a shared allocator

Appends to a collection merge: Tier-2 conflict detection is path-aware, so
concurrent writes to distinct keys of the same container do not collide
(`docs/specs/memory-v2/08-conflict-granularity.md`). A map keyed by child name
inherits that. A shared counter does not — it is a same-path read and write, so
concurrent allocations serialize through one retry under `editWithRetry`. That
is the whole cost, and a collection that finds it too high has the uncoordinated
mechanisms above.

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

Canonicalizing to the identity rather than to a qualified name is the safe
default, and it is what lets a consumer store a reference into a collection
whose name policy it has not read. A qualified name is the right thing to store
only where the collection promises the name outlives the reference.

## Authority

Space ACLs are space-granular: a principal is evaluated against the space ACL
document for every command, with READ, WRITE, and OWNER ordering
(`docs/specs/memory-v2/04-protocol.md`). There is no per-document
authorization, so no address in a space is protected from a principal who can
write the space. Per-document authority arrives with UCAN-authorized commands.

This design therefore does not prevent a name from being taken; it makes taking
one impossible by accident and detectable when deliberate.

- A handle lives in the collection that assigned it, so a person choosing a
  space-level name cannot land on one. Retargeting one means writing that
  collection's own
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
canonical. **This is a prerequisite: giving collections handles before it lands
makes URL rewriting nondeterministic.**

**2. Make name assignment refuse by default.** `setSlugLink` does not read the
slug cell before writing it, so assigning an assigned name overwrites it
silently. Sync the cell, read it inside the transaction, refuse when it is
already bound, and take an explicit flag to steal. `editWithRetry` re-runs its
body on a retryable rejection, so the check is a claim rather than a
time-of-check race. Confirm that a synced read inside the transaction becomes a
commit precondition before relying on it.

**3. Give collections child namespaces.** A collection declares its prefix, its
name policy, and a resolution from child name to link. Whatever allocator it
needs is its own; a collection that accepts names from people can reuse the
claim from step 2 at collection scope. Widen `resolvePieceAddress`
(`packages/piece/src/slugs.ts`), which rejects a name whose target has no
pattern identity, so that a name pointing at a collection nested in a piece is
not treated as an error.

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
- Whether a collection accepting names from people reuses the space-level claim
  path or needs its own.
- Whether a collection's name policy is declared in a form a consumer can
  branch on, or is documentation that a consumer's author reads.
- Whether the scope chain admits bindings from a collection to its siblings, or
  stops at the containing collection and the reader's own bindings.
