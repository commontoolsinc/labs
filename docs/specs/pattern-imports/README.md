# Pattern Imports — `import { … } from "cf:…"`

Letting authored patterns import other patterns published in the fabric:

```tsx
import { TodoItem, todoSchema } from "cf:piece/kitchen/todo-list";   // a deployed piece
import { TodoItem } from "cf:pattern/9f2ab…e41";                     // a content-addressed source
```

A reference is either a **deployed piece** — meaning "the pattern currently
used by that piece", a mutable pointer — or a **content-addressed pattern
source** — the immutable thing a deployed piece points to. Both resolve to the
same underlying artifact: a content-addressed source program whose entry-module
identity lives in the same namespace as the compile cache and `cf:module/<hash>`
(`packages/runner/src/harness/module-identity.ts`).

## Status

Design.

## Last Updated

2026-06-10

## Motivation

- **Reuse without copy-paste.** Today a pattern can import only its own files
  (`./`, `../`, `/`) and three allowlisted runtime modules
  (`packages/runner/src/sandbox/runtime-module-policy.ts`). Sharing a schema or
  a sub-pattern across separately-deployed patterns means duplicating source.
- **Typed reuse.** The `fetchProgram` builtin
  (`packages/runner/src/builtins/fetch-program.ts`) fetches and compiles remote
  programs at *runtime*, untyped at the call site. An import is compile-time:
  TypeScript checks the binding names and types against the real source.
- **Foundation for external packages.** The same resolution seam, pinning
  model, and collision rules are designed so that `npm:`/esm.sh support can be
  added later without revisiting this design (§ External packages).

## Non-goals

- **Live/reactive imports.** An importer does NOT recompile or re-run when the
  referenced piece's pattern changes. Runtime composition that follows a live
  pointer is a different feature (e.g. `getPattern`, wish); imports are static.
- **Version ranges / semver resolution.** References are exact: a slug pointer
  (resolved once, at pin time) or a content hash. Pattern lineage (`parents`,
  `spec` in the pattern meta cell) is metadata, not a resolution input.
- **A package registry product.** The toolshed surface below is a content
  mirror plus a pointer-resolution endpoint, both trust-free (hash-verified by
  the client); naming, discovery, and curation are out of scope.

## Background: what exists today

| Piece of machinery | Where | Role here |
|---|---|---|
| `ProgramResolver` seam (`main()` / `resolveSource(specifier)`, async) | `packages/js-compiler/program.ts`, `typescript/resolver.ts` | The hook where fabric imports plug in; compilation already runs inside a runtime with storage + network access |
| Authored-import policy | `packages/runner/src/sandbox/runtime-module-policy.ts:25` | Single dispatch point to extend for `cf:` specifiers |
| Per-module Merkle identity (source + deps; external deps fold the full specifier string into the leaf: `runtime:${specifier}@${fingerprint}`) | `packages/runner/src/harness/module-identity.ts:145-149` | Makes pinned specifiers content-derived with **no hashing changes** (§ Snapshot semantics) |
| Piece → pattern pointers: `meta("pattern")` = patternId URI; `meta("patternIdentity")` = `{ identity, symbol }` (entry-module identity) | `packages/runner/src/runner.ts:4137-4159` | "Current pattern of a piece" is read here at pin time |
| Pattern meta cell: `program {main, files}`, `entryIdentity`, `parents`, `spec` | `packages/runner/src/pattern-manager.ts:55-90` | Source-of-truth for a pattern's source set |
| Compile cache: source docs `pattern:<identity>`, compiled docs `compileCache:<rtVersion>/<identity>` | `packages/runner/src/compilation-cache/cell-cache.ts` | Content-addressed per-module source + compiled storage; imports resolve from and dedupe into it |
| Slugs: `[a-z0-9]+(-[a-z0-9]+)*`, ≤80 chars; slug id = `hashOf({causal:{space, slug}})`, redirect cell | `packages/runner/src/slugs.ts`, `packages/piece/src/slugs.ts` | Human-readable piece locators |
| `loadPatternByIdentity(entryIdentity, symbol, space)` | `packages/runner/src/pattern-manager.ts:985` | Existing by-identity load path the resolver builds on |

## Specifier syntax

### Recommended: the `cf:` scheme

Two authored forms, one scheme:

```tsx
// Deployed piece — "the pattern this piece currently runs":
import { TodoItem } from "cf:piece/todo-list";                                // slug in the current space
import { TodoItem } from "cf:piece/kitchen/todo-list";                        // space by name
import { TodoItem } from "cf:piece/did:key:z6Mk…/todo-list";                  // space by DID
import { TodoItem } from "cf:piece/toolshed.common.tools/kitchen/todo-list";  // explicit toolshed host
import { TodoItem } from "cf:piece/~/todo-list/schemas";                      // ~ = current space (needed with subpaths)

// Content-addressed pattern source (immutable):
import { TodoItem } from "cf:pattern/9f2ab…e41";
import { todoSchema } from "cf:pattern/9f2ab…e41/schemas";                    // subpath (phase 2)

// Pinned piece reference — what a deployed importer actually stores (§ Snapshot semantics):
import { TodoItem } from "cf:piece/kitchen/todo-list@9f2ab…e41";
```

Grammar (`<hash>` is the prefix-free module-identity hex, the same string that
appears in `cf:module/<hash>` and the compile-cache keys):

```
fabric-import  = "cf:piece/" locator [ "/" subpath ] [ "@" hash ]
               | "cf:pattern/" hash [ "/" subpath ]

locator        = slug                          ; current space, current toolshed
               | space "/" piece               ; explicit space
               | host "/" space "/" piece      ; explicit toolshed

space          = space-name | space-did | "~"  ; "~" = the compiling space
piece          = slug | "fid1:" hash           ; slug or entity id
host           = domain[":" port]              ; recognized by containing "." or being localhost[:port]
```

Disambiguation rules (each segment class is syntactically disjoint):

- The pin is always a trailing `@<hash>`; strip it first. Slugs, space names,
  DIDs, and hosts cannot contain `@`.
- A leading segment is a **host** iff it contains a `.` (or is
  `localhost[:port]`). Slugs and space names used in references must match the
  slug grammar (no `.`/`:`); DIDs start with `did:` but contain no `.` before
  the method-specific part — references requiring an explicit host always use
  the 3-segment form, so the dot rule only has to separate hosts from space
  names.
- A single-segment `cf:piece/<slug>` is the current-space shorthand. Subpaths
  on current-space references require the `~` placeholder
  (`cf:piece/~/<slug>/<subpath>`) so segment counting stays unambiguous.

Why this shape:

- **`cf:` already exists** as the runtime's identity scheme (`cf:module/<hash>`
  in compiled output and `fn.src`). Authored imports get sibling namespaces
  (`cf:piece/`, `cf:pattern/`); the emitted namespace `cf:module/` stays
  compiler-internal and is rejected in authored source.
- **A scheme cannot collide** with npm bare specifiers (npm names cannot
  contain `:`), with `npm:`/`jsr:` (different prefixes), or with `https:` URLs
  (§ External packages).
- **Valid ESM specifier.** Schemes are legal in import specifiers; resolution
  is entirely ours via the `ProgramResolver`/compiler-host seam, and TypeScript
  is satisfied through the same mechanism that resolves `commonfabric` today
  (`packages/js-compiler/typescript/compiler.ts:176-207`).

### Alternatives considered

1. **URL-authority form: `cf://toolshed.common.tools/kitchen/todo-list`.**
   Standard URL parsing and a natural home for the host, but the common cases
   (current toolshed, current space) have no natural spelling — `cf:///kitchen/…`
   or an empty authority is awkward — and it diverges stylistically from
   `cf:module/<hash>`, which is authority-less. Rejected.
2. **Bare scope: `@fabric/kitchen/todo-list`.** Reads like npm, which is
   exactly the problem: it squats on the npm scope namespace we want to keep
   clean for real packages later, and "looks installable" misleads. Rejected.
3. **Pin as a separate sidecar lockfile** instead of in-specifier `@<hash>` —
   see § Snapshot semantics for why the pin lives in the source.

## Snapshot semantics: how piece references determine hashes

The question: a piece's current pattern is a mutable pointer. When does an
importer's hash sample it?

**Decision: a one-time snapshot at *pin time* (deploy/authoring), persisted in
the source itself — never at compile time, never continuously.**

Mechanics:

1. When a pattern containing an unpinned `cf:piece/...` import is **deployed**
   (or a dev/iterate flow explicitly resolves dependencies), the toolchain
   reads the piece's current `meta("patternIdentity").identity` (fallback:
   `meta("pattern")` → pattern meta cell → `entryIdentity`, computing it from
   `program` if absent) and **rewrites the specifier in the stored source** to
   the pinned form:

   ```tsx
   import { TodoItem } from "cf:piece/kitchen/todo-list@9f2ab…e41";
   ```

   The stored program is then fully deterministic: compilation, identity, and
   execution never read the piece pointer again.

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
   re-resolves the piece pointer and rewrites the pin — an ordinary source
   edit, visible in lineage (`parents`) like any other edit. The unpinned form
   never reaches deployed storage: deploying with an unpinned piece reference
   pins it; a stored program containing an unpinned `cf:piece/` specifier is a
   compile error. `cf dev`/`cf check` resolve unpinned references live against
   the connected toolshed and print what they resolved to.

Why not continuous tracking: re-snapshotting on target change would make the
importer's identity (and therefore its compiled artifacts, scheduler keys, and
every downstream content address) change without any edit to the importer —
exactly the build-order/reload-churn class of instability the content-addressed
identity work eliminated. Live composition stays a runtime feature.

In-source pinning vs a lockfile side-table: a side-table (`resolvedImports` on
the pattern meta cell) would preserve authored bytes exactly, but then program
identity becomes a function of *(source, lockmap)* and every consumer of
`computeId`/`computeModuleHashes`/`cf check` must thread the lockmap. The
in-source pin keeps "identity = hash of source" true, keeps the pin visible and
diffable, and retains provenance (the piece pointer stays in the specifier, so
tooling knows what to re-resolve). This deliberately borrows the
`npm:pkg@version` shape — the pin step is "lockfile semantics, written back
into the import statement."

### What `cf:pattern/<hash>` means exactly

The hash is the **entry-module identity** of the referenced source program —
the same prefix-free Merkle hash over (authored source, authored path, dep
hashes) used by the compile cache and `$patternRef`
(`docs/specs/content-addressed-action-identity.md`). Chosen over the
alternative candidates:

- *patternId* (`of:<hash>` of the pattern meta cell, what `meta("pattern")`
  stores): resolvable, but it is a causal ref whose derivation is not purely
  source-content in all paths, so a fetched program can't be verified against
  it by re-hashing alone. The pin records what `meta("patternIdentity")`
  carries instead — already the fast-path identity pieces store.
- *whole-program id* (`computeId`): entry-point and sibling-file sensitive, and
  not the namespace existing load machinery (`loadPatternByIdentity`, compile
  cache) keys on.

Because the identity is a Merkle root, the transitive source closure is
discoverable and verifiable from it (source docs in the cell cache store
per-module source + resolved import links), and cycles are impossible by
construction — a hash cannot reference itself. (Unpinned piece references can
form cycles — A imports piece B whose pattern imports piece A — only during
live dev resolution, where the resolver needs an ordinary cycle guard; pinned
chains are DAGs.)

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
| `cf:piece/ cf:pattern/` | this spec (authored) | new |
| `cf:module/` | compiled output only; rejected in authored source | today |
| `npm: jsr: https:` | future external packages | reserved now |

Reserving bare specifiers for runtime modules is the load-bearing rule: future
packages must be scheme-qualified, so no import-map shadowing ambiguity can
arise between a runtime module, a fabric reference, and an npm package. The
policy check stays a single dispatch on prefix
(`isAllowedAuthoredImportSpecifier`).

**(b) Syntax and semantics worth borrowing:**

- **Deno's `npm:pkg@version/subpath` and `jsr:@scope/pkg@version`** — the
  trailing-`@version` pin position is exactly what `cf:piece/...@<hash>`
  borrows, so pinned fabric refs and pinned npm refs read the same way.
- **Lockfile semantics, but written into the source** (above). For npm, a
  version pin is *not* content-addressed (registries are mutable), so the pin
  step should additionally **vendor**: fetch the resolved module graph (e.g.
  from esm.sh), store it as a content-addressed source set in the fabric — the
  same source-doc shape patterns use — and record the vendored identity. An
  npm import then *is* a `cf:pattern/<hash>` underneath: one resolution path,
  one storage shape, one verification step, integrity for free, reproducible
  offline. The authored specifier keeps the npm provenance
  (`npm:preact@10.26.4` plus the vendored pin), mirroring the piece/pattern
  split: mutable pointer in the specifier, content hash as the pin.
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
  for the grammar above (locator, pin, subpath; host/space/slug
  disambiguation).
- `runtime-module-policy.ts`: `isAllowedAuthoredImportSpecifier` accepts
  `cf:piece/` and `cf:pattern/` prefixes (and continues to reject `cf:module/`
  in authored source).

### 2. Resolution (a `FabricProgramResolver` wrapper)

Engine wraps the authored resolver; on a `cf:` specifier:

1. **Locator → identity** (piece refs): pinned → use the pin, never read the
   piece. Unpinned (dev only) → resolve space (name → DID via toolshed, or
   `~` → compiling space), slug → slug cell redirect → piece, read
   `meta("patternIdentity").identity` (fallback chain per § Snapshot
   semantics).
2. **Identity → source set**, first hit wins, every hop hash-verified:
   1. local/space compile cache source docs (`pattern:<identity>`, walking
      import links);
   2. the referenced piece's space (for piece refs);
   3. the toolshed registry endpoint (below);
   4. for host-qualified refs, that host's registry endpoint.
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

### 4. Toolshed surface

Two new endpoints (names indicative), both per-toolshed — this is the "which
toolshed" in a host-qualified reference, defaulting to the toolshed the
compiling runtime's session is connected to:

- `GET /api/registry/piece/:space/:pieceRef` → `{ spaceDid, pieceId,
  patternId, patternIdentity }` — resolves a space name/DID + slug/entity-id
  to the piece's current pattern pointers. Auth: requires read access to the
  space (same authz as a memory read; this is a convenience projection, not a
  bypass). Used by CLI/CI pin steps and cross-toolshed resolution without a
  full memory session.
- `GET /api/registry/pattern/:identity` → the source set
  (`{ main, files: [{name, contents}] }`, plus per-module identities) for a
  **published** pattern. Backed by a publish flow: `cf publish` (or
  deploy-to-a-public-space) writes the source docs to a well-known
  toolshed-readable space. Responses are immutable and cacheable
  (`Cache-Control: immutable`, like blobs); clients verify by re-hashing, so
  mirroring is safe.

The existing `/api/patterns/:filename` (repo-file serving) is unrelated and
unchanged.

### 5. CLI / shell

- `cf deploy`: pins unpinned piece refs (writes the rewritten source into the
  pattern meta `program`), publishes source sets if the target is public.
- `cf deps update [specifier]`: re-resolve + rewrite pins.
- `cf dev` / `cf check`: live-resolve unpinned refs against the connected
  toolshed; `--frozen` to forbid (CI). `--show-transformed` shows mounted
  files like any other program file.
- Shell iterate flow: show pins; "update dependencies" action mirrors
  `cf deps update`.

### Phasing

1. **`cf:pattern/<hash>`, same-space.** No new endpoints, no pinning step —
   resolution entirely via existing cell-cache source docs +
   `computeModuleHashes` verification. Proves the resolver/mounting/emit seams.
2. **`cf:piece/…` + pinning + slugs**, current toolshed; registry piece
   endpoint; deploy-time pin rewrite; `cf deps update`.
3. **Publish flow + registry pattern endpoint + host-qualified refs**
   (cross-toolshed).
4. **Subpaths; `npm:`/esm.sh vendoring** on the same rails.

## Security considerations

- **Imported code runs with the importing pattern's full authority.** An
  import is a trust decision equivalent to pasting the source in: same SES
  verification, same CFC treatment, same space access. The pin makes that
  decision about *exact bytes* — review-at-pin is meaningful.
- **Slug re-pointing is inert for deployed importers.** Re-pointing a piece (or
  swapping its pattern) cannot change any pinned importer; it changes only
  future pins. This closes the classic "dependency hijack via mutable pointer"
  hole by construction.
- **Mirrors and registries are trust-free.** Every fetched source set is
  verified by recomputing the Merkle identity; a malicious toolshed can refuse
  to serve but cannot substitute code.
- **CFC.** Module identities are already the content-addressed provenance
  CFC verified-identity resolution uses
  (`docs/specs/content-addressed-action-identity.md`); imported modules verify
  and register exactly like authored ones. No new identity kind is introduced.
- **No ambient escalation surface.** The registry endpoints expose only what a
  space-read already grants (piece endpoint) or what publishing deliberately
  made public (pattern endpoint).

## Failure modes (all compile-time errors with actionable messages)

| Failure | Error |
|---|---|
| Slug/space/piece not found, or no read access | "cannot resolve cf:piece/… (space/slug/permission)" naming the failing hop |
| Piece has no pattern pointer | "piece … has no current pattern" |
| Unpinned piece ref in deployed/`--frozen` compile | "unpinned fabric import; run `cf deps update` / deploy to pin" |
| Source set unavailable at every resolution hop | "source for cf:pattern/<hash> not found (tried: local, space …, registry …)" |
| Hash mismatch on fetched source | "integrity failure for <hash> from <source>" (and the hop is skipped, next source tried) |
| Cycle during live (unpinned) resolution | "cyclic piece imports: A → B → A" |
| Imported source fails SES verification | existing verifier error, attributed to the imported module's original path |

## Test plan

- **Grammar**: parse/format round-trips; host/space/slug disambiguation table;
  rejection of `cf:module/` in authored source.
- **Identity folding** (red-green): two importers identical except for the pin
  hash get different module identities; pin rewrite changes `computeId`.
- **Snapshot semantics**: deploy piece A; deploy importer B (pin captured);
  update A's piece to a new pattern; B's compile, identity, and behavior are
  byte-identical until `cf deps update`, after which only the specifier line
  differs.
- **Dedupe**: importer of a running piece's pattern reuses its compiled docs
  and live module namespace (assert on `esmCacheStats` / `modulesByIdentity`
  hits).
- **Verification**: tampered source set from a mock registry → integrity
  error; fallback hop succeeds.
- **Multi-runtime** (`multiUserTest` harness): user 1 deploys + publishes;
  user 2 imports across spaces; CFC verified identity intact.
- **Failure modes**: one test per row of the table.

## Open questions

1. **Publish granularity.** Is "publish" a distinct user action (`cf publish`)
   or implicit for any piece readable by the reference resolver? Implicit is
   ergonomic but turns space-read into source-disclosure; explicit publish is
   the conservative default proposed here.
2. **Space-name resolution.** Piece refs with space *names* (not DIDs) need a
   name→DID resolution authority; the shell resolves names client-side today.
   The registry piece endpoint can own this, but name squatting/renaming
   semantics need a decision before phase 2 (DID-form refs sidestep it).
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
