# Pattern Imports — `import { … } from "cf:…"`

Letting authored patterns import other patterns published in the fabric:

```tsx
// Shown for illustration only.
import { TodoItem, todoSchema } from "cf:/kitchen/todo-list";  // a slug — names a piece OR a published pattern
import { TodoItem } from "cf:pattern:AvcnyZ…rC1c";               // a content-addressed source, directly
```

A reference names a **starting cell** — by slug or by cell URI, optionally
qualified by space and toolshed host — and resolution **follows the pointer
chain until it reaches a content-addressed pattern source**. A slug may point
at a deployed piece (then we mean "the pattern that piece currently runs" —
one more hop, reading the piece's `patternIdentity`) or directly at a pattern
(a named, updatable publication). Either way the chain terminates at an
entry-module identity in the same namespace as the compile cache and
`cf:module/<hash>` (`packages/runner/src/harness/module-identity.ts`), and that
terminal hash is what deployed importers pin.

There is deliberately **no type tag in the specifier** (`cf:piece/…` vs
`cf:pattern/…` was considered and dropped, § Alternatives): slug cells are
already type-agnostic redirects, the slug-vs-URI distinction already has a
codebase convention (`isSlugAddress` = "no colon"), and the piece/pattern
distinction evaporates at pin time — both freeze to the same kind of hash.

## Status

**Implemented for content-addressed and same-toolshed references** (`#4081`):
parsing, slug and piece resolution, deploy-time pinning, and mounting. Dynamic
host-qualified routing, `cf publish`, and source subpaths remain planned as
listed under Phasing. This remains the design of record; for the as-built
pointer model note that the patternId + pattern **meta cell** this document
originally leaned on were **retired** in `#4156`
(`docs/specs/pattern-id-retirement.md`) — a piece now carries only
`patternIdentity = { identity, symbol }`, and a pattern's source lives in the
`pattern:<identity>` source-doc closure. References below are updated to match.
System-root update propagation is described in `pattern-updates.md`; the
general piece origin model is described in `../piece-source-lifecycle.md`.

## Last Updated

2026-07-21

## Motivation

- **Reuse without copy-paste.** Today a pattern can import only its own files
  (`./`, `../`, `/`) and three allowlisted runtime modules
  (`packages/runner/src/sandbox/runtime-module-policy.ts`). Sharing a schema or
  a sub-pattern across separately-deployed patterns means duplicating source.
- **Typed reuse.** The `fetchProgram` builtin
  (`packages/runner/src/builtins/fetch-program.ts`) fetches and compiles remote
  programs at *runtime*, untyped at the call site. An import is compile-time:
  TypeScript checks the binding names and types against the real source.
- **A publishing story built from naming and placement.** Pointing a slug at a
  cell that carries a `patternIdentity` (a piece, or a lightweight
  published-pointer cell) gives a pattern a human-readable, updatable name (a
  dist-tag) within that space. It does not change the space's ACL. Publishing
  into another space creates a replica under that destination space's ACL.
  No registry product required.
- **Foundation for external packages.** The same resolution seam, pinning
  model, and collision rules are designed so that `npm:`/esm.sh support can be
  added later without revisiting this design (§ External packages).

## Non-goals

- **Live/reactive imports.** An importer does NOT recompile or re-run when the
  slug or piece it references moves to a new pattern. Runtime composition that
  follows a live pointer is a different feature (e.g. `getPattern`, wish);
  imports are static.
- **Version ranges / semver resolution.** References are exact: a mutable
  pointer (resolved once, at pin time) or a content hash. Any version label or
  lineage is non-hashed metadata (the entry source doc's `annotations` field is
  the seam), never a resolution input. (`parents`/`spec` were removed with the
  meta cell; lineage is not currently stored.)
- **A package registry product.** There is no registry service at all: every
  resolution hop — including cross-host — is an ordinary authenticated cell
  read, and content is hash-verified by the client regardless of which host
  served it. Discovery and curation are out of scope.

## Background: what exists today

| Piece of machinery | Where | Role here |
|---|---|---|
| `ProgramResolver` seam (`main()` / `resolveSource(specifier)`, async) | `packages/js-compiler/program.ts`, `typescript/resolver.ts` | The hook where fabric imports plug in; compilation already runs inside a runtime with storage + network access |
| Authored-import policy | `packages/runner/src/sandbox/runtime-module-policy.ts` | Single dispatch point for `cf:` specifiers |
| Per-module Merkle identity (source + deps; external deps fold the full specifier string into the leaf: `runtime:${specifier}@${fingerprint}`) | `computeModuleHashes` in `packages/runner/src/harness/module-identity.ts` | Makes pinned specifiers content-derived with **no hashing changes** (§ Snapshot semantics) |
| Piece → pattern pointer: `meta("patternIdentity")` = `{ identity, symbol }` (entry-module identity), the sole pointer post-`#4156` (a separate `meta("pattern")` survives only as a builtin parent-backlink) | write `applySetupState`, read `getPatternIdentityRef` in `packages/runner/src/runner.ts` | The terminal hop of the resolution chain |
| Pattern source-of-truth: the `pattern:<identity>` source-doc closure (there is no longer a meta cell; the retired one's `program` was pure duplication of these docs) | `packages/runner/src/compilation-cache/cell-cache.ts` | Recovered via `getPatternSourceProgramByIdentity` / `loadVerifiedSourceClosure` |
| Compile cache: source docs at cell key **`pattern:<identity>`**, compiled docs at `compileCache:<rtVersion>/<identity>` | `packages/runner/src/compilation-cache/cell-cache.ts` (`sourceDocKey`/`compiledDocKey`) | **The URI a pattern is saved under by hash.** Content-addressed per-module source + compiled storage; imports resolve from and dedupe into it |
| Slug cells: generic **redirect link to any cell** (`setSlugLink` is target-agnostic; only `resolvePieceAddress` layers a "must be a piece" check) | `packages/piece/src/slugs.ts` | Slugs can name pieces *or* patterns today, mechanically |
| Slug ids: `hashOf({causal:{space, slug}})`; slug grammar `[a-z0-9]+(-[a-z0-9]+)*`, ≤80 chars; **`isSlugAddress(t) = !t.includes(":")`** | `packages/runner/src/slugs.ts` | The existing slug-vs-URI discriminator the grammar reuses |
| `loadPatternByIdentity(entryIdentity, symbol, space)` | `packages/runner/src/pattern-manager.ts` | Existing by-identity load path the resolver builds on |
| Per-space host routing: `spaceHostMap` resolves each space to its memory host; foreign-host sessions are ordinary authenticated memory sessions (#3947) | `packages/runner/src/storage/v2-remote-session.ts` | Reads work for a foreign space whose route is already known; applying a host from an explicit `cf://` reference remains planned |

### The two "pattern by hash" handles, explicitly

Because both come up, and only one is the pin:

- **`of:fid1:<hash>`** — the entity URI of a **cell that carries a pattern
  pointer** (a piece result cell), `toURI(createRef(...))`
  (`packages/runner/src/uri-utils.ts:12`). A *causal* ref: resolvable (it's a
  cell address) but not re-hash-verifiable from fetched content alone. Usable as
  a reference *starting point* (the chase reads its `patternIdentity`); never
  the pin.
- **`pattern:<identity>`** — the per-module **source-set document key**
  (`cell-cache.ts:sourceDocKey`), where `<identity>` is the prefix-free
  entry-module Merkle hash (authored source + authored path + dep hashes;
  `computeModuleHashes`). Verifiable by re-hashing, entry-point independent,
  and the namespace all existing by-identity machinery keys on
  (`cf:module/<hash>`, compile cache, `$patternRef`,
  `meta("patternIdentity")`). **This is the pin**, and `cf:pattern:<identity>`
  is its reference spelling.

### Tooling reference for a running piece

Piece tooling exposes the running pattern and its source as deliberately
separate fields:

```json
{
  "identity": "<prefix-free-entry-module-hash>",
  "symbol": "default",
  "source": {
    "ref": "cf:pattern:<prefix-free-entry-module-hash>",
    "repository": "https://github.com/commontoolsinc/labs",
    "entry": "/packages/patterns/annotation.tsx",
    "origin": "cf:/did:key:z6Mk.../annotation"
  }
}
```

- `identity` + `symbol` is the authoritative reference to the executable
  export (`cf:module/<identity>#<symbol>` in display form).
- `source.ref` is the immutable, in-fabric reference to the verified source
  closure that produced the running identity. It uses the same
  `cf:pattern:<hash>` grammar as imports and is derived from `identity`; it does
  not depend on how or where the pattern was authored.
- `source.repository` is the optional repository locator supplied explicitly at
  deployment. It is descriptive discovery metadata, not proof of which bytes
  are running; `source.ref` remains authoritative for that. The CLI stores the
  value exactly as supplied and never derives it from local Git configuration.
- `source.entry` is the optional authored entry filename recovered from that
  verified closure. Authored filenames are relative to the compilation root.
  For a local deployment, passing the repository root as `--root` therefore
  preserves a path inside that repository rather than only a basename.
  Absolute paths from the author's machine are never persisted.
- `source.origin` is the optional `patternSource` update provenance carried by
  the piece. Today only toolshed system-pattern paths drive an implemented
  update check. General source URLs include external `https://` URLs and
  fabric-internal `cf:` URLs, including the host-qualified `cf://...` form. A
  fabric URL that is unpinned and resolves to a piece or another mutable
  `patternIdentity`-bearing entity follows that entity's current pattern. A
  fabric URL that resolves to `pattern:<identity>` names content-addressed
  source and cannot update. A trailing `@<identity>` pin makes any fabric URL
  immutable, even when its unpinned form names a piece. These piece-origin
  semantics are specified in
  [`../piece-source-lifecycle.md`](../piece-source-lifecycle.md) and require
  work. An origin answers "where did this source come from, and should that
  place be checked again?"; `source.ref` answers "which exact bytes are
  running?"

`cf piece new`, `cf piece setsrc`, and custom `cf piece set-home` accept
`--repository <locator>` alongside `--root`. `new` and custom `set-home` stamp
the locator on the new piece. `setsrc` replaces it when the flag is present and
preserves the existing locator when the flag is omitted. `set-home --reset`
rejects the flag because the system pattern was not deployed from the caller's
repository. No Git remote or revision is inferred automatically.

## Specifier syntax

### One grammar, no type tag

The prefix encodes the qualification level, like relative path / absolute
path / protocol-relative URL:

```
cf:<ref>[/<subpath>][@<pin>]                       ; current space
cf:/<space>/<ref>[/<subpath>][@<pin>]              ; explicit space
cf://<host>/<space>/<ref>[/<subpath>][@<pin>]      ; explicit toolshed

ref     = slug                ; no ":" — isSlugAddress convention
        | "of:fid1:" hash     ; cell URI (a piece / a cell carrying patternIdentity)
        | "pattern:" hash     ; entry-module identity (content-addressed source)
space   = space-name | space-did
host    = domain[":"port]     ; a toolshed
pin     = "@" hash            ; entry-module identity
hash    = 43 base64url chars  ; hashStringOf/hashOf output (value-hash.ts):
                              ; [A-Za-z0-9_-], case-SENSITIVE, no padding —
                              ; e.g. Avcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c
```

(Hashes are **not** hex: `hashStringOf` emits unprefixed base64url
(`packages/data-model/src/value-hash.ts:553`), and entity URIs carry the
`fid1:` tag inside `of:` — `of:fid1:<hash>` is what `toURI` produces. The
base64url alphabet contains no `/`, `@`, or `:`, so pin-splitting and
segment-splitting stay unambiguous.)

Examples:

```tsx
// Shown for illustration only.
import { TodoItem } from "cf:todo-list";                            // slug, current space
import { todoSchema } from "cf:todo-list/schemas";                  // subpath (phase 2)
import { TodoItem } from "cf:/kitchen/todo-list";                   // space by name
import { TodoItem } from "cf:/did:key:z6Mk…/todo-list";             // space by DID
import { TodoItem } from "cf://toolshed.common.tools/kitchen/todo-list";  // explicit toolshed
import { TodoItem } from "cf:pattern:AvcnyZ…rC1c";                    // content-addressed, space-free
import { TodoItem } from "cf:/kitchen/of:fid1:ZwjMI…A2Os";          // a piece (patternIdentity-bearing cell) by URI

// What a deployed importer actually stores (§ Snapshot semantics):
import { TodoItem } from "cf:/kitchen/todo-list@AvcnyZ…rC1c";
```

Parsing rules (each form is disjoint by prefix; no segment counting needed):

- The **pin** is always a trailing `@<hash>`; strip it first. Slugs, space
  names, DIDs, and hosts cannot contain `@`.
- After `cf:`: `//` ⇒ the next segment is a **host**, then space, then ref.
  A single `/` ⇒ the next segment is a **space** (name or DID — colons inside
  a segment are fine), then ref. No slash ⇒ the first segment is the `ref` in
  the current space. All remaining segments are the `subpath`. Because
  space-qualification *requires* the leading slash, `cf:todo-list/schemas` is
  unambiguously ref + subpath — no placeholder needed.
- A `ref` containing `:` is a cell URI (`of:`, `pattern:`); otherwise it must
  validate as a slug. `pattern:` refs are space-free-capable (content
  addressed; the space, if given, is only a resolution hint). Slug refs are
  always space-scoped (slug ids are `slugIdForSpace(space, slug)`), with the
  current space as default.
- The emitted-namespace specifiers `cf:module/<hash>` and `cf:cache-root/`
  remain compiler-internal and are **rejected in authored source**.

### Resolution rule (uniform, type-free)

Starting from the named cell, follow pointers until a pattern source is
reached:

1. slug → slug cell's redirect target (`resolveSlugTargetCell`);
2. a cell carrying a `patternIdentity` meta (a **piece**) → its `.identity` is
   the terminal identity (`getPatternIdentityRef`, `runner.ts:4441`);
3. a `pattern:<identity>` ref → already terminal.

Anything that doesn't chase to a pattern is a compile error ("does not resolve
to a pattern", naming the chain followed). The chain is short (≤2 hops) and
each hop is an ordinary cell read under ordinary space authz. (This matches the
as-built chase in `packages/runner/src/fabric-ref-resolution.ts`; the retired
meta cell added no hop.)

Why this shape:

- **`cf:` already exists** as the runtime's identity scheme (`cf:module/<hash>`
  in compiled output and `fn.src`); authored references get the human-facing
  side of the same scheme.
- **A scheme cannot collide** with npm bare specifiers (npm names cannot
  contain `:`), with `npm:`/`jsr:` (different prefixes), or with `https:` URLs
  (§ External packages).
- **Valid ESM specifier.** Schemes are legal in import specifiers; resolution
  is entirely ours via the `ProgramResolver`/compiler-host seam, and TypeScript
  is satisfied through the same mechanism that resolves `commonfabric` today
  (`packages/js-compiler/typescript/compiler.ts:176-207`).
- **It is the shell's URL shape with a scheme on it** —
  `/{spaceNameOrDid}/{pieceIdOrSlug}` — so users learn one addressing model.
- **Publication = naming.** `slug → a cell carrying patternIdentity` (a piece,
  or a published-pointer cell) in a readable space is the whole publish story;
  updating the slug is publishing a new version (dist-tag semantics). Pieces and
  published patterns are then *the same kind of reference target*.

### Alternatives considered

1. **Type-tagged namespaces: `cf:piece/…` and `cf:pattern/…`** (this spec's
   first draft). Encodes in the specifier whether the name is a live piece or
   a published source. Dropped: slug cells are type-agnostic redirects anyway,
   the tag duplicates information that resolution discovers in one hop and
   that the pin erases entirely, and it forbids the natural
   slug-points-at-pattern publishing story (or forces `cf:piece/` to
   sometimes name patterns, which is worse). The only real loss is that a
   reader can't tell pointer kind from the import line — but the pinned form
   is what's stored, and the pin means the same thing in both cases.
2. **Bare scope: `@fabric/kitchen/todo-list`.** Reads like npm, which is
   exactly the problem: it squats on the npm scope namespace we want to keep
   clean for real packages later, and "looks installable" misleads. Rejected.
3. **Pin as a separate sidecar lockfile** instead of in-specifier `@<hash>` —
   see § Snapshot semantics for why the pin lives in the source.

## Snapshot semantics: how mutable references determine hashes

Both mutable pointer kinds — a slug (re-assignable) and a piece's current
pattern (changes on iterate/edit) — raise the same question: when does an
importer's hash sample the pointer?

**Decision: a one-time snapshot at *pin time* (deploy/authoring), persisted in
the source itself — never at compile time, never continuously.**

Mechanics:

1. When a pattern containing an unpinned mutable reference is **deployed** (or
   a dev/iterate flow explicitly resolves dependencies), the toolchain runs
   the resolution rule to the terminal entry-module identity and **rewrites
   the specifier in the stored source** to the pinned form:

   ```tsx
   import { TodoItem } from "cf:/kitchen/todo-list@AvcnyZ…rC1c";
   ```

   The stored program is then fully deterministic: compilation, identity, and
   execution never read the slug or piece again.

2. **The pinned hash folds into the importer's identity for free.** Module
   identity already hashes external deps as `runtime:${specifier}@${fingerprint}`
   (`module-identity.ts:145-149`) — the specifier string contains the pin, so
   two importers differing only in pin have different module identities, and
   transitively different program ids (`engine.ts:computeId` hashes the source
   files, which contain the specifier). No changes to any hashing code.

3. **No re-resolution on recompile.** Cold compiles (cache-version bumps,
   eviction) recompile from the stored, pinned source. This is the reason the
   pin lives *in the source* rather than being an emergent property of "first
   compile": if resolution happened at compile time, an unrelated cold compile
   of an unchanged program could silently re-pin to a newer target — a
   different program identity with no authoring action. Pin-in-source makes
   identity a pure function of stored bytes.

4. **Updating is an explicit authoring action.** `cf deps update
   [<specifier>]` (and an equivalent affordance in the shell's iterate flow)
   re-runs resolution and rewrites the pin — an ordinary source edit. The
   unpinned form never reaches
   deployed storage: deploying with an unpinned mutable reference pins it; a
   stored program containing one is a compile error. `cf dev`/`cf check`
   resolve unpinned references live against the connected toolshed and print
   what they resolved to. `cf:pattern:<hash>` refs are born pinned (the ref
   *is* the pin; no rewrite).

Why not continuous tracking: re-snapshotting on target change would make the
importer's identity (and therefore its compiled artifacts, scheduler keys, and
every downstream content address) change without any edit to the importer —
exactly the build-order/reload-churn class of instability the content-addressed
identity work eliminated. Live composition stays a runtime feature.

In-source pinning vs a lockfile side-table: a side-table (a `resolvedImports`
map stored alongside the source) would preserve authored bytes exactly, but then program
identity becomes a function of *(source, lockmap)* and every consumer of
`computeId`/`computeModuleHashes`/`cf check` must thread the lockmap. The
in-source pin keeps "identity = hash of source" true, keeps the pin visible and
diffable, and retains provenance (the mutable pointer stays in the specifier,
so tooling knows what to re-resolve). This deliberately borrows the
`npm:pkg@version` shape — the pin step is "lockfile semantics, written back
into the import statement."

### Why the pin is the entry-module identity

The pin records what `meta("patternIdentity")` already carries. The
alternatives fail:

- *a piece's `of:` entity URI* (a causal/cell ref): its derivation is not
  purely source-content, so a fetched program can't be verified against it by
  re-hashing alone — fine as a reference starting point, unusable as an
  integrity anchor. (This is why the retired `patternId`, an `of:`-style causal
  ref, could not have been the pin.)
- *whole-program id* (`computeId`): entry-point and sibling-file sensitive,
  and not the namespace existing load machinery keys on.

Because the identity is a Merkle root, the transitive source closure is
discoverable and verifiable from it (source docs at `pattern:<identity>` store
per-module source + resolved import links), and pinned chains cannot cycle — a
hash cannot reference itself. (Unpinned mutable references can form cycles —
A imports slug B whose pattern imports slug A — only during live dev
resolution, where the resolver needs an ordinary cycle guard.)

## What an import gives you

The imported module's **exports**: patterns, schemas (`schemas.tsx` sharing is
a first-class use case), types, lifts/handlers, plain helpers. Imports are
type-checked against the real fetched source, not declarations. The entry
module is the program's `main`; subpaths (`/schemas` etc.) address other files
in the same program and are a phase-2 extension (same resolution, an extra path
join inside the mounted program).

## Coexistence with esm.sh / npm / jsr (later)

**(a) No collisions, by partition of the specifier space:**

| Specifier class | Owner | Status |
|---|---|---|
| `./ ../ /` | program-relative files | today |
| bare (`commonfabric`, `turndown`, …) | **reserved for runtime modules only**, allowlist | today; never used for packages |
| `cf:` (authored reference grammar above) | this spec | today for content-addressed and same-toolshed references; host-qualified routing and subpaths planned |
| `cf:module/`, `cf:cache-root/` | compiled output / cache internals; rejected in authored source | today |
| `npm: jsr: https:` | future external packages | reserved now |

Reserving bare specifiers for runtime modules is the load-bearing rule: future
packages must be scheme-qualified, so no import-map shadowing ambiguity can
arise between a runtime module, a fabric reference, and an npm package. The
policy check stays a single dispatch on prefix
(`isAllowedAuthoredImportSpecifier`).

**(b) Syntax and semantics worth borrowing:**

- **Deno's `npm:pkg@version/subpath` and `jsr:@scope/pkg@version`** — the
  trailing-`@version` pin position is exactly what `cf:…@<hash>` borrows, so
  pinned fabric refs and pinned npm refs read the same way.
- **Lockfile semantics, but written into the source** (above). For npm, a
  version pin is *not* content-addressed (registries are mutable), so the pin
  step should additionally **vendor**: fetch the resolved module graph (e.g.
  from esm.sh), store it as a content-addressed source set in the fabric — the
  same `pattern:<identity>` source-doc shape — and record the vendored
  identity. An npm import then *is* a `cf:pattern:<hash>` underneath: one
  resolution path, one storage shape, one verification step, integrity for
  free, reproducible offline. The authored specifier keeps the npm provenance
  (`npm:preact@10.26.4` plus the vendored pin), mirroring the fabric split:
  mutable pointer in the specifier, content hash as the pin.
- **esm.sh's target/bundle query conventions** (`?target=es2022`, `?bundle`)
  only if we ever serve compiled variants; authored-source identity hashing
  deliberately ignores compiled form, so these stay out of identity.

Caveat to record now: vendored npm code must pass the same SES verifier as
authored modules (no top-level mutable bindings, no ambient DOM/process access)
— most utility libraries will pass, many won't. That filter is a feature, but
it bounds which packages are importable; it does not affect this spec's
mechanics.

## Build sketch

Compilation already happens inside a runtime (`Engine` is `runtime.harness`,
with storage and network access, and `ProgramResolver.resolveSource` is async)
— so resolution is a download/read away, as suspected. The pieces:

### 1. Specifier parsing + policy

- New `packages/runner/src/sandbox/fabric-import-specifier.ts`: parse/format
  for the grammar above (host/space/ref/subpath/pin), reusing
  `isSlugAddress`/`validateSlug`.
- `runtime-module-policy.ts`: `isAllowedAuthoredImportSpecifier` accepts
  specifiers parsing under the `cf:` reference grammar (and continues to
  reject the emitted namespaces `cf:module/`, `cf:cache-root/`).

### 2. Resolution (a `FabricProgramResolver` wrapper)

Engine wraps the authored resolver; on a `cf:` specifier:

1. **Reference → identity**: pinned (or `pattern:` ref) → use the hash, never
   touch the mutable pointer. Unpinned (authoring/dev only) → run the uniform
   chase **as ordinary cell reads through the compiling runtime's storage**
   (slug cell redirect → the piece's `patternIdentity`) —
   `cf check`/`cf dev` already construct a runtime (`packages/cli/lib/dev.ts`),
   and every production compile happens inside one, so space authz is exactly
   memory-read authz. Host-qualified refs are the same reads with the space
   routed to its host via `spaceHostMap` (§ Cross-host references).
2. **Identity → source set**, first hit wins, every hop hash-verified:
   1. local/space compile-cache source docs (`pattern:<identity>`, walking
      import links);
   2. the space named in the reference, routed to its host if the ref is
      host-qualified.
3. **Verify**: recompute `computeModuleHashes` over the fetched program (its
   own namespace, its own authored paths) and require the entry hash to equal
   the requested identity. Mismatch = compile error. This is what makes every
   mirror trust-free.
4. **Mount for type-checking**: splice the fetched files into the TS program
   under a reserved prefix (e.g. `/~cf/<identity>/<original-path>`), and
   thread a specifier→mounted-entry alias map into the compiler so
   `resolveModuleNameLiterals` (`compiler.ts:176`) maps the `cf:` specifier to
   the mounted file. Relative imports inside the subtree resolve as ordinary
   path joins.

### 3. Identity and emit: keep the imported subtree in its own universe

The subtle part. Imported modules must keep their **published** identities
(authored paths hashed in their own program namespace) so that compiled
artifacts dedupe with the already-deployed pattern and verification means
anything. Therefore:

- The importer's modules treat the `cf:` specifier as an **external dep** for
  identity purposes (status quo hashing; the pin in the specifier carries the
  content into the hash — § Snapshot semantics).
- The imported subtree is **not re-emitted** as part of the importer's
  compilation. Mounted files participate in type-checking only; the importer's
  emitted module records reference `cf:module/<published-identity>` edges
  (`module-record-compiler.ts` already emits cross-module edges in exactly
  this form).
- If the compiled set for the imported identity is missing (runtime-version
  bump, never compiled here), compile the imported program **as its own
  compilation** (existing `loadPatternByIdentity`-shaped path) and let the
  compile cache absorb it; then the importer's edges resolve normally.

Payoff: at runtime, an importer and a running piece of the imported pattern
share compiled artifacts and live module namespaces
(`modulesByIdentity`, `addressableByIdentity` in `pattern-manager.ts`) — the
import costs nothing the deployed pattern hasn't already paid.

**Availability is a compile-time concern only.** The compile's write-back
copies the imported modules' source + compiled docs into the **compiling
space** (content-addressed keys, idempotent), so both rehydration paths —
warm (compiled-doc links) and cold (source docs re-fetched by hash) — read
locally. The referenced space/host must be reachable when a ref is pinned or
first compiled, never to reload a deployed importer. (This copy is exactly
the provenance-relevant flow flagged under § Security.)

### 4. Cross-host references: no service surface at all

A runtime is no longer bound to one memory host: `spaceHostMap`
(`storage/v2-remote-session.ts:createStorageAddressResolver`, PR #3947)
routes each space to its host, and a foreign-host session is an ordinary
authenticated memory session. (`spaceHostMap` itself is an **interim
mechanism** — per-space host resolution will evolve; this design depends only
on the property "a space's cells are readable wherever the space lives", not
on the map's current shape.) So a `cf://host/space/ref` reference resolves
exactly like a local one — slug chase, piece/meta hops, and `pattern:<identity>`
source-doc reads are all cell reads in a space that happens to live on
another host, under that host's normal authz. No resolve endpoint, no
content endpoint; nothing re-implements space authorization in an HTTP
route, and hash verification of fetched sources is unchanged (it never
depended on the transport).

Consequences:

- **Publication separates naming from placement.** Assigning a slug to a
  pattern already present in a space only gives it another name; it does not
  change that space's ACL. `cf publish --space` creates a lightweight
  patternIdentity-bearing publication cell in the target space, copies the
  verified source closure, then optionally assigns a slug. It does not copy the
  source piece or any of that piece's state. The replica has the target space's
  ACL and may therefore have a different audience. The operation requires
  source-read authorization, destination-write authorization, and a permitted
  CFC flow. Whoever can read the target space can import its replica; nobody
  else can.
- **The host segment maps to a `spaceHostMap` entry.** One mechanical work
  item: the map is fixed at storage construction today
  (`v2.ts` options), while a host-qualified ref is discovered mid-compile —
  the resolver needs either dynamic registration of a space→host route on the
  live session or a short-lived secondary session for the foreign space.
- A cacheable, anonymous HTTP mirror for published patterns (CDN-style
  distribution to readers with no fabric identity) remains *possible* later.
  It would need an explicit anonymous visibility policy that covers the whole
  pattern, including its source, and hash verification would still protect
  integrity. It is not part of this design (§ Open questions).

The existing `/api/patterns/:filename` (repo-file serving) is unrelated and
unchanged.

### 5. CLI / shell

- `cf deps update <file> [--import <specifier>]`: pins unpinned mutable refs by
  rewriting the stored source, which re-derives the pinned identity and its
  `pattern:<identity>` source documents.
- Automatic pinning during piece deployment remains required work. The CLI
  intentionally has no `cf deploy` command.
- `cf publish <pattern> [--slug name] [--space …]` *(not yet built)*: after
  source-read authorization, destination-write authorization, and CFC
  approval, copy the verified source closure and create a lightweight
  patternIdentity-bearing publication cell in the target space, then
  optionally assign the slug. Do not copy the source piece or its state.
- `cf dev` / `cf check`: live-resolve unpinned refs against the connected
  toolshed; `--frozen` to forbid (CI). `--show-transformed` shows mounted
  files like any other program file.
- Shell iterate flow: show pins; "update dependencies" action mirrors
  `cf deps update`.

### Phasing

1. **`cf:pattern:<hash>`, same-space.** No pinning step — resolution entirely
   via existing cell-cache source docs + `computeModuleHashes` verification.
   Proves the resolver/mounting/emit seams.
2. **Slug/piece refs + pinning**, current toolshed; deploy-time pin rewrite;
   `cf deps update`. (Resolution = the compiling runtime's storage reads
   throughout — no phase adds a service endpoint.)
3. **`cf publish` + host-qualified refs** — cross-host reads via
   `spaceHostMap` routing, incl. the dynamic-route work item above.
4. **Subpaths; `npm:`/esm.sh vendoring** on the same rails.

## Security considerations

- **Imported code runs with the importing pattern's full authority.** An
  import is a trust decision equivalent to pasting the source in: same SES
  verification, same CFC treatment, same space access. The pin makes that
  decision about *exact bytes* — review-at-pin is meaningful.
- **Re-pointing is inert for deployed importers.** Re-assigning a slug or
  swapping a piece's pattern cannot change any pinned importer; it changes
  only future pins. This closes the classic "dependency hijack via mutable
  pointer" hole by construction.
- **Hosts are trust-free for content.** Every fetched source set is verified
  by recomputing the Merkle identity; a malicious host can refuse to serve
  but cannot substitute code.
- **CFC.** Module identities are already the content-addressed provenance
  CFC verified-identity resolution uses
  (`docs/specs/content-addressed-action-identity.md`); imported modules verify
  and register exactly like authored ones. No new identity kind is introduced.
- **Source shares the containing space's ACL.** Within a space, every cell and
  document that makes a pattern resolvable, including its verified source
  closure, has that space's visibility. Anyone authorized to resolve the
  pattern in that space may read its source; there is no separate
  source-publication permission. Assigning a slug names the pattern but does
  not grant access. Knowing a content identity or fabric URL is also not
  authorization. The same content identity can be replicated into spaces with
  different ACLs, and each replica follows its containing space's ACL.
  Resolution and content fetch remain memory reads under existing space authz,
  including cross-host reads through authenticated `spaceHostMap` sessions.
- **Pattern source is data with provenance.** Patterns can contain private
  information (literals, prompts, embedded knowledge), so source docs are not
  exempt from CFC: fetching an imported pattern's source is a labeled read,
  and the compile-cache write-back that copies fetched source docs into the
  importing space is a labeled **flow** that must respect the source's
  provenance (fail closed when a label forbids it). Wiring CFC labels through
  fetch and write-back is deliberate **follow-up work** — flagged here so the
  initial implementation doesn't silently launder source across spaces; until
  it lands, cross-space imports should be treated as moving data with the
  same care as any cross-space link.

## Failure modes (all compile-time errors with actionable messages)

| Failure | Error |
|---|---|
| Slug/space not found, or no read access | "cannot resolve cf:… (space/slug/permission)" naming the failing hop |
| Chain does not terminate at a pattern (slug → data cell, piece without pattern, …) | "cf:… does not resolve to a pattern" + the chain followed |
| Unpinned mutable ref in deployed/`--frozen` compile | "unpinned fabric import; run `cf deps update` / deploy to pin" |
| Source set unavailable at every resolution hop | "source for pattern:<hash> not found (tried: local cache, space … on host …)" |
| Hash mismatch on fetched source | "integrity failure for <hash> from <source>" (and the hop is skipped, next source tried) |
| Cycle during live (unpinned) resolution | "cyclic imports: A → B → A" |
| Imported source fails SES verification | existing verifier error, attributed to the imported module's original path |

## Test plan

- **Grammar**: parse/format round-trips; prefix-form table (`cf:ref`,
  `cf:/space/ref`, `cf://host/space/ref`, subpaths, pins, DIDs-as-space,
  `of:`/`pattern:` refs); rejection of `cf:module/` and `cf:cache-root/` in
  authored source.
- **Resolution chase**: slug→piece→pattern, slug→pattern (direct
  publication), `of:<patternId>` start, `pattern:<hash>` terminal; "not a
  pattern" failures per chain shape.
- **Identity folding** (red-green): two importers identical except for the pin
  hash get different module identities; pin rewrite changes `computeId`.
- **Snapshot semantics**: deploy piece A; deploy importer B (pin captured);
  move A's piece (and separately: re-point the slug) to a new pattern; B's
  compile, identity, and behavior are byte-identical until `cf deps update`,
  after which only the specifier line differs.
- **Dedupe**: importer of a running piece's pattern reuses its compiled docs
  and live module namespace (assert on `esmCacheStats` / `modulesByIdentity`
  hits).
- **Verification**: tampered source set served by a mock host → integrity
  error; fallback hop succeeds.
- **Multi-runtime** (`multiUserTest` harness): user 1 deploys + publishes;
  user 2 imports across spaces; CFC verified identity intact.
- **Authorization**: within one space, pattern and source visibility match; a
  slug, URL, or content identity grants no access; a cross-space publish adopts
  the target space's ACL only after authorization and CFC checks; revoking
  origin access blocks future resolution without deleting source already
  accepted into another space.
- **Failure modes**: one test per row of the table.

## Resolved questions

1. **Publish granularity and source visibility.** Within a space, a pattern and
   its verified source closure have the same ACL and visibility: that space's.
   A caller that can resolve the pattern there may read its source. A caller
   that cannot resolve it gains nothing from knowing its URL or content
   identity. Assigning a slug to a pattern already present in the space is only
   naming and discovery; it creates no separate source grant. Publishing into
   another space is different: it creates an ACL-scoped replica under the
   destination space's visibility and requires destination write authorization
   plus a permitted CFC flow.

## Open questions

1. **Space-name resolution.** Refs with space *names* (not DIDs) need a
   name→DID mapping per host; the shell resolves names client-side today and
   there is no service surface here to hang it on. Name squatting/renaming
   semantics need a decision before phase 2 (DID-form refs sidestep it).
2. **Slug-cell typing.** The uniform chase duck-types its hops (a
   `patternIdentity` meta present ⇒ a pattern-bearing cell). Good enough, or
   should slug assignment stamp an explicit kind on the slug cell for better
   errors and tooling?
3. **Type-only imports.** Should `import type { … }` from a fabric ref skip
   the pin requirement (types don't affect runtime identity)? Tempting, but
   the transformer lowers types into schemas — so types DO affect emitted
   behavior, and the conservative answer is no special-casing. Revisit with
   evidence.
4. **Subpath surface.** Whether subpaths may address any file in the program
   or only files the entry re-exports (an "exports map" discipline, like npm's
   `exports`). Start permissive, tighten if published-internal-file coupling
   becomes a problem.
5. **Runtime-fingerprint interaction.** External-dep leaves include
   `runtimeFingerprint`; a runtime upgrade thus shifts importer identities even
   with identical pins (status quo for runtime modules, now also for fabric
   refs). Acceptable, but worth stating in the compile-cache invalidation
   docs.
6. **Public distribution surface.** Should the product standardize a dedicated
   distribution space whose space-wide ACL grants `READ` to `*`, making every
   pattern in that space readable by any authenticated identity? Should it also
   offer an anonymous, CDN-cacheable HTTP endpoint? An anonymous endpoint would
   need an explicit visibility policy applied equally to a pattern and its
   source. It could serve only patterns copied under that policy after CFC
   allows unrestricted disclosure. A URL or content identity alone must never
   qualify a pattern for either form of distribution.
7. **Dynamic space→host routes.** `spaceHostMap` is fixed at storage
   construction; host-qualified refs discovered mid-compile need dynamic
   route registration (or a short-lived secondary session). Small, but it
   touches session lifecycle — design alongside phase 3.
