# Content-Addressed Module Loading

## Status

**Shipped and exclusive.** The ESM module-record loader described here is the
only loader: the `esmModuleLoader` / `CF_ESM_MODULE_LOADER` flag, the AMD
bundle pipeline (bundler, whole-bundle verifier, `Engine.compile`/`evaluate`),
and the AMD compilation cache (`CachedCompiler`) have been removed. References
to the flag and to the AMD path below are historical context from the design
phase.

This document specifies a replacement for the former
AMD-bundle module pipeline with (1) per-module content-addressed identity
computed as a Merkle hash over each module's authored TypeScript source and the
transitive import graph, and (2) ES-module loading into SES compartments. The
motivating consumer is [persistent scheduler state](persistent-scheduler-state.md),
whose action implementation fingerprint is currently unstable across reloads.

All phases of the original loader rollout are complete. Identity decoupling
(Phase 1, formerly behind
`EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE`) is merged. The module-loading
mechanism (Phases 2–4) is the production path: a synchronous SES
virtual-module-record loader, a TS→record adapter that runs the full CF
transformer pipeline, per-load/per-module source maps with CFC verified-source
identity (#3785, #3787), per-module SES classification wired into the compile
path, and a structural graph verifier. Security hardening landed alongside
(frozen exported patterns #3777, import-edge validation #3778, provenance brand
#3779). Compiled modules persist as content-addressed cells (Phase 4, the
`cell-cache` compile cache). The default-on/AMD-removal rollout (Phase 5) is
done: the flag was flipped, then the flag, the AMD bundle pipeline, and the AMD
compilation cache were deleted.

The module hash accepts an optional runtime fingerprint, and unit tests cover
its effect on external-dependency leaves. Production pattern compilation,
entry-identity calculation, source verification, and replication currently use
the empty default. The fingerprint-aware executable-identity and lifecycle
rules below are settled target behavior that still requires integration.

## Last Updated

2026-07-22

## Summary

Pattern compilation today hashes the entire resolved program — entry file plus
its whole import closure — into a single id, then stamps that id as a path
prefix (`/${id}/…`) onto every emitted file. That prefix flows into each
function's `src` source location, which the scheduler uses as its durable
implementation fingerprint. Because the id is a property of the *bundle*, not of
the *module*, the same function gets a different `src` whenever it is compiled
from a different entry point or with a different surrounding file set. Reloading
a pattern from a different starting point therefore produces a different
fingerprint for byte-identical code, and persistent-scheduler-state rehydration
misses.

This spec changes module identity from bundle-grained to module-grained.
Each module is content-addressed by a Merkle hash over its own **authored
TypeScript source** and the hashes of every module it imports. That hash is:

- **stable** across entry points and unrelated sibling files, because it depends
  only on the module's own reachable import closure;
- **stable as authored source across TCB evolution**, because a runtime-neutral
  module identity hashes the author's source and pinned specifiers rather than
  compiled output. The executable module identity separately folds the runtime
  fingerprint into external-dependency leaves. An affected importer therefore
  receives a new executable identity after a runtime upgrade;
- **transitively sensitive**, because changing any module in that closure changes
  the importing module's hash too — behavior can change when an imported function
  *or an imported type* changes, and the fingerprint must reflect that.

Imports are tracked regardless of whether they are value or type imports.
TypeScript types are load-bearing in Common Fabric: the transformer lowers types
into the emitted output (JSON schemas are generated from types, and those schemas
drive runtime validation and reactivity). A change to an imported type can change
runtime behavior, so type-import edges belong in the graph alongside value
imports.

To make per-module identity natural, the loader moves from a single flattened
AMD bundle evaluated with `compartment.evaluate(string)` to ES modules
registered as content-addressed specifiers and executed through the SES module
system (`ModuleSource` + synchronous `importNow`). The `/${id}/` prefix hack and
the synthetic `/index.ts` re-export disappear, because a registry keyed by
content hash cannot have filename collisions.

The iframe sandbox path (`packages/iframe-sandbox`) is entirely independent of
this work and is out of scope.

## Goals

- Give every authored module, and every action within it, an identity that is
  stable across reloads and across the entry point used to compile it.
- Make that identity sensitive to transitive changes: editing an imported
  function or type invalidates the fingerprint of everything that transitively
  imports it.
- Keep a runtime-neutral identity for unchanged authored source across TCB
  evolution. Fold the runtime fingerprint into executable identities whose
  reachable graphs contain external dependencies. Revision history can then
  distinguish a runtime rebuild from an authored-source edit.
- Track type imports as well as value imports, because the transformer lowers
  types into emitted output (schema generation), so types affect runtime
  behavior.
- Replace the AMD bundle + string-eval loader with ES-module loading in SES
  compartments, preserving the existing synchronous execution contract.
- Preserve the verifiable-execution guarantees: every module item is still
  classified and verified before it can execute or become observable.
- Improve compilation-cache granularity from whole-program to per-module.

## Non-goals

- Do not change the SES security model, lockdown options, hardening, or the
  invocation-isolation guarantees described in
  [SES_SANDBOXING_SPEC.md](sandboxing/SES_SANDBOXING_SPEC.md). This changes how
  modules are *named and loaded*, not what authority they receive.
- Do not change the `packages/iframe-sandbox` DOM-iframe path. Confirmed
  independent.
- Do not change the ts-transformer pipeline's semantics. Transformers run as
  today; only the emitted module format and the identity computation change.
- Do not require asynchronous action execution. The scheduler runs actions
  synchronously; module loading must remain synchronous at run time.
- Do not attempt cross-runtime-version identity stability. A different runtime
  fingerprint (builder/runtime version, transformer version, scheduler mode)
  still invalidates observations, as it does today.

## Current System Overview

### Compilation

`Engine.compile(program)` ([packages/runner/src/harness/engine.ts:175][c1])
receives a `RuntimeProgram` = `{ main, files[] }`, where `files` is the entry
file plus its resolved import closure, then:

1. Computes a single id over the whole program:

   ```ts
   // Shown inside a pattern body.
   // packages/runner/src/harness/engine.ts
   const id = options.identifier ?? computeId(program);
   // computeId(program) = hashOf([program.main, ...files.filter(non .d.ts)])
   ```

2. Rewrites **every** file path to `/${id}${originalPath}` and synthesizes a new
   `/index.ts` entry that re-exports `main`
   ([pretransform.ts:36][c2]). The inline comment is explicit that the prefix
   exists only to stop TypeScript from "flatten[ing] the output, eliding the
   common prefix" — i.e. it is a collision-avoidance namespace for bundling.

3. Compiles the closure with `ModuleKind.AMD` and `outFile`
   ([js-compiler/typescript/options.ts][c3]) through the
   `CommonFabricTransformerPipeline`, producing one IIFE that contains
   `define("<id>/path", [deps], factory)` calls. The AMD `define`/`require`
   shim is inlined from [amd-loader.ts][c4] ([bundle.ts:9][c5]).

4. Re-parses those `define()` calls in the bundle verifier
   ([compiled-js-parser.ts][c6]) for verifiable execution.

### Loading

`lockdown()` runs once ([ses-runtime.ts:262][c7]). A fresh `Compartment` is
created per `execute()` and the entire bundle is run with
`compartment.evaluate(js)` — string evaluation under `evalTaming: "safe-eval"`
([ses-runtime.ts:135][c8]). Runtime modules (`commonfabric`,
`commonfabric/schema`, aliases) are `define`d into the bundle via `runtimeDeps`
([engine.ts:503][c1]). SES is pinned at `npm:ses@^1.15.0`.

### Identity flow into `action.src`

- The `/${id}/…` prefix becomes each function's source-map filename.
- `annotateFunctionDebugMetadata` reads the source location via
  `getExternalSourceLocation()` and assigns
  `fn.src = "/<id>/pattern.tsx:line:col"` ([builder/module.ts:585][c9]).
- The scheduler turns that into the durable fingerprint:
  `schedulerImplementationFingerprint` returns `src:${action.src}`
  ([scheduler/run.ts][c10]), which keys persistent scheduler
  observations.

## Problem Statement

Module identity is **bundle-grained, not module-grained**. `computeId` hashes
the entire `[main, ...files]` set and that hash is stamped into every function's
`src`. The identity of one unchanged function therefore depends on:

- which entry point was compiled (different `main`),
- which subset and ordering of the import closure was included,
- any unrelated sibling file present in the bundle.

Reloading a pattern from a different entry point yields a different `program`,
hence a different `id`, hence a different `fn.src` for every function, hence a
fingerprint mismatch against the persisted observation — for code that has not
changed at all. This is the direct cause of persistent-scheduler-state
rehydration misses.

The naive inverse — hashing each module's bytes in isolation — would be stable
across entry points but **incorrect**, because a module's runtime behavior
depends on what it imports. If module `A` imports `compute` from `B` and `B`'s
implementation changes, `A`'s behavior changes even though `A`'s own bytes did
not — and likewise if `A` imports a *type* from `B` that `B` redefines, because
that type is lowered into `A`'s generated schema. A correct fingerprint must be
both stable across entry points and sensitive to transitive changes in any
imported module, value or type.

## Proposed Model

### Module Identity: Merkle hash over the import graph

Define identity per module, bottom-up over the import graph, including **all**
imports — value and type.

For each authored module `M`:

- `normSrc(M)` — the canonical normalized representation of `M`'s **own** code
  (not its dependencies', which enter the hash via the Merkle edges below).
  **Decision: hash the authored TypeScript source of `M`**, as written, before
  the CF transformer pipeline and before TypeScript emit. Normalization is
  limited to line-ending canonicalization; type annotations and comments are
  retained. Hashing the author's source rather than compiled JS is deliberate:
  - It keeps the runtime-neutral module identity **stable across TCB
    evolution.** The transformer and compiler are the trusted computing base;
    they improve over time. Hashing emitted output would make it impossible to
    tell a runtime rebuild from an authored-source change. The executable module
    identity separately includes `runtimeFingerprint` on external-dependency
    leaves. A runtime upgrade therefore changes affected executable identities
    without changing the runtime-neutral module identity.
  - It naturally **includes types**, which are load-bearing (the transformer
    lowers types into emitted schemas). We therefore do *not* strip types, and
    do *not* need to distinguish type-only from value imports.
- `deps(M)` — the ordered set of `M`'s imports (value and type alike), each a
  pair `(specifierText, target)` where `target` is either another authored
  module or an external runtime module.

The module hash is:

```
moduleHash(M) = H(
  "cf/module-id/v1",
  normSrc(M),
  sortByText([
    (specifierText_i, leafOrHash(target_i))   for each import i
  ])
)

leafOrHash(target) =
  authored module N        -> moduleHash(N)
  external runtime module  -> "runtime:<name>@<runtimeFingerprint>"
```

`H` is the existing `hashOf` SHA-256 construction
([packages/data-model/src/value-hash.ts:526][c11]). External runtime modules
(`commonfabric`, etc.) are leaves keyed by the runtime fingerprint, so a runtime
upgrade invalidates everything that imports them, consistent with the existing
`runtimeFingerprint` invariant.

The executable runtime fingerprint comes from one authoritative provider,
`getExecutableRuntimeFingerprint()`. Its version-1 value is a domain-separated
hash with the tag `cf/executable-runtime-fingerprint/v1`. The hash includes:

- the value returned by `getCompileCacheRuntimeVersion()`;
- `schedulerRuntimeFingerprint()`;
- an automatically generated catalog hash of the implementations and export
  surfaces of every pattern-facing runtime module; and
- an automatically generated catalog hash of the sandbox and execution-policy
  inputs that can change pattern behavior.

The existing compile-cache runtime version intentionally hashes a broad set of
compiler, transformer, schema, harness, sandbox, API, compiler-option, and
dependency inputs. Version 1 uses that value as a mandatory input even though it
can over-invalidate executable identities. A later design may split
representation-only cache inputs from executable semantics. Such a split may
roll `runtimeVersion` alone only for an input proven unable to affect compiled
behavior. A compiler, transformer, generated-schema, runtime-module, sandbox,
execution-policy, or scheduler-semantics change must roll the executable runtime
fingerprint.

The provider and its input catalogs are required production work. Once the
provider is enabled, inability to calculate its value fails closed. The empty
fingerprint remains only the canonical interpretation of source documents
published before this integration. It is not a valid fingerprint for newly
published source whose identity depends on an external module.

Piece history compares complete authored programs with a versioned,
runtime-neutral digest:

```text
const hashes = computeModuleHashes(authoredProgram, {
  runtimeFingerprint: "",
});
const runtimeNeutralProgramDigest = hashStringOf({
  v: "cf/runtime-neutral-program-digest/v1",
  main: authoredProgram.main,
  modules: [...hashes]
    .sort(([a], [b]) => utf8Compare(a, b))
    .map(([filename, identity]) => [filename, identity]),
});
```

The input is the explicitly enumerated canonical authored program before adding
fabric-mounted files or synthetic retention links. It includes every enumerated
authored file, including an unreachable sibling and an authored declaration
file. Each per-module identity includes the canonical filename, normalized
source, internal import graph, and external specifier text, including fabric
pins. The digest excludes the selected export, which revision comparison checks
separately. It is comparison metadata rather than a fabric URL, executable
identity, or revert target.

The lifecycle source service must materialize that complete `Program` before
import-closure resolution. The current `ProgramResolver` interface cannot
enumerate unreachable files, so existing resolver-only flows define their input
as the reachable closure until they adopt an explicit program manifest.

Authored and verified mounted `.d.ts` files are source-only identity nodes. A
value or type import of one of these declarations contributes the declaration's
module identity to every transitive importer. The declaration is stored in
source history but does not produce a JavaScript module record.

Declaration stubs supplied by the runtime for modules such as `commonfabric`
remain type-check inputs rather than authored identity nodes. The authored bare
specifier stays an external leaf that contains the runtime fingerprint. Record
assembly, compiled-cache membership, and compiled links include only emitted
modules.

Production `Engine` paths currently filter every `.d.ts` file before
`computeFabricModuleIdentities`, `CacheableModule` construction, and
`writeSourceDocs`. Replacing that blanket filter with provenance-aware
type-check, identity and source-history, and emitted sets is required integration
work.

**Cycles.** ES modules permit import cycles, so the import graph is not strictly
a DAG. Compute over the condensation: find strongly-connected components, hash
each SCC as a unit (members sorted by stable path, concatenating their
`normSrc` and their out-of-component import edges), and assign every member the
pair `(sccHash, memberIndexWithinScc)`. Acyclic modules are singleton SCCs and
reduce to the formula above.

#### Stability and sensitivity properties

- **Entry-point independence.** `moduleHash(M)` is a function only of the
  transitive import closure reachable from `M` and the authored source text of
  those modules. It does not reference the entry point, sibling modules outside
  `M`'s closure, file ordering, or any whole-program prefix. Therefore the same
  module with the same reachable imports hashes identically no matter which
  entry point pulled it into a compilation.
- **Runtime sensitivity with source continuity.** `moduleHash(M)` changes with
  `runtimeFingerprint` when `M` or its reachable dependencies import an external
  module. A module with no reachable external dependency remains unchanged. A
  separate runtime-neutral module identity over authored source and pinned
  specifiers identifies the module across runtime rebuilds. Trusting a persisted
  observation still requires both a matching `moduleHash` and a matching
  `runtimeFingerprint`.
- **Transitive sensitivity.** If any module `N` in `M`'s closure changes,
  `moduleHash(N)` changes; since `moduleHash(N)` is an input to every module that
  transitively imports `N`, all of their hashes change. Changes propagate to
  fingerprints along every import edge, value or type.

#### Action / function identity

Replace the line:col-into-prefixed-path source location with a stable
intra-module symbol assigned by a transformer:

```
actionImplId = moduleHash(M) + "#" + stableSymbol(M, decl)
```

`stableSymbol` is the exported binding name where one exists, or a
declaration-path / ordinal for anonymous callbacks (`pattern`, `lift`,
`handler`, `action` arguments). This becomes the new `fn.src`, and thus
`schedulerImplementationFingerprint` becomes a genuine content hash rather than
a bundle-relative location string. This closes the staleness gap in the
persistent-scheduler-state spec, where a stable `src:` string could otherwise
match even after the underlying code changed.

The instance binding hash already computed in
`schedulerJavaScriptActionName` / `schedulerRawActionName`
(over process cell + read/write links) remains and is orthogonal: it
distinguishes multiple instances of the same implementation. Identity is the
pair *(implementation hash, instance binding hash)*.

#### Type Imports Are Included

Type imports are part of the graph, not excluded from it. In Common Fabric the
transformer lowers TypeScript types into emitted output — JSON schemas are
generated from types, and those schemas drive runtime validation and reactivity
— so an imported type is load-bearing: redefining it can change runtime
behavior. Hashing authored TS source (which retains type annotations and
`import type` declarations) and counting every import edge therefore captures
type changes by construction.

This means the import-graph extraction must collect **all** import and
`export … from` edges, including `import type` and type-only named specifiers.
There is no value/type filtering and no dependence on emit elision. The earlier
"non-type imports only" framing is withdrawn: it would have silently treated a
behavior-changing type edit as a no-op, which is exactly the under-counting we
must avoid.

A static fabric type edge in the supported ESM-style syntax also follows the
ordinary pin-in-source rule. An `import type`, type-only named import or export,
or inline `import("cf:…").Type` reference cannot remain mutable in deployed
source. If it could, a later type change could alter generated schemas and
executable behavior without changing the importing pattern's stored source. The
current `rewriteFabricPins` visitor already rewrites import declarations, export
declarations, and inline import-type nodes. `collectImportSpecifiers` already
includes these edges in module identity. Automatic piece deployment still
uses an ordinary local resolver before invoking the rewriter. It therefore
rejects every fabric import or export declaration at that stage, including an
already-pinned reference. Correct pin-on-deploy ordering remains required
integration work.

The CommonJS-style TypeScript form
`import type Alias = require("cf:…")` is unsupported. The current visitors do
not recognize its `ImportEqualsDeclaration`, so graph discovery, rewriting, and
identity calculation must reject it explicitly rather than allow it to bypass
the pin. Production resolution and persistence of all authored declaration
inputs also require the integration described in
[pattern-imports/implementation-plan.md](pattern-imports/implementation-plan.md).

### Loader: ES modules in SES compartments

Move from one flattened AMD bundle to ES modules loaded through the SES module
system.

1. **Emit ESM.** Switch `ModuleKind` from `AMD` to `ES2022`/`ESNext` and drop
   `outFile` and the AMD bundler. Each authored file emits as its own ES module.
   The transformer pipeline is unchanged.

2. **Content-addressed specifiers.** Each emitted module is registered under
   `cf:module/<moduleHash(M)>`. A compile-time import map records, per module,
   `relativeSpecifierText -> cf:module/<hash>` for that module's own imports.
   Runtime modules map to fixed specifiers (`cf:runtime/commonfabric`, …). There
   is no `/${id}/` prefix and no synthetic `/index.ts`; collisions are
   impossible under content addressing.

3. **Synchronous load via `ModuleSource` + `importNow`.** SES 1.15 supports
   `Compartment` with `resolveHook` and `importNowHook`, and precompiled
   `ModuleSource`s. Precompile each emitted module to a `ModuleSource` at compile
   time (cacheable), register all of a pattern's sources in the compartment's
   module map before execution, then drive the entry with
   `compartment.importNow(entrySpecifier)`. Because every reachable source is
   present up front, no asynchronous import occurs at run time, preserving the
   scheduler's synchronous-execution contract
   ([engine.ts:273][c1] `isolate.execute().invoke().inner()`).

4. **Runtime modules as module-map entries.** `commonfabric` and friends become
   entries in the module map / `importNowHook` rather than `define()` injections
   into a bundle. Endowment and hardening are unchanged.

5. **Compartment lifecycle.** Unchanged in spirit: one isolate per load
   ([ses-runtime.ts:198][c7]); the per-load module map replaces the per-load
   bundle. Whether a single compartment hosts all of a pattern's modules or one
   compartment per module is an implementation choice; a single compartment per
   load with a content-addressed module map is the natural starting point.

## Compilation Cache Implications

The cache key moves from whole-program `computeId` to per-module
`moduleHash(M)`. Editing one file in a multi-file pattern then:

- recompiles and re-precompiles only that module and its transitive importers
  (whose hashes changed), not the whole pattern;
- leaves the identities and cache entries of untouched modules stable;
- yields strictly better hit rates than the current whole-program key.

### Storage model: two content-addressed document sets, per space

The persistent cache is **content-addressed cells**, not an in-process map. Each
emitted module is stored as two regular cells in the **target space**. Authored
and mounted declarations have only a source document because they emit no
JavaScript record. There is no global cache. The storage layer's existing
**sigil-link following** under a schema loads the whole import closure
transitively from a single request. Per-document dedup handles cycles, as for any
linked data:

1. **Source set — `pattern:<identity>`.** Authored TypeScript implementation and
   declaration source, keyed by the per-module Merkle `moduleHash`
   (`cf:module/<hash>`). It is independent of the compiled-cache
   `runtimeVersion`. An affected module receives another source set when
   `runtimeFingerprint` changes. It is **self-verifying**: a reader recomputes
   the identity from the source, import graph, and recorded identity
   fingerprint. Content addressing is the integrity check, so no separate label
   is needed.
2. **Compiled set — `compileCache:<runtimeVersion>/<identity>`.** Compiled and
   verified JS, keyed by `(runtimeVersion, identity)`. Under the version-1
   executable-fingerprint rule, the existing broad compiler-input fingerprint
   rolls both `runtimeVersion` and `runtimeFingerprint`. That creates a new
   executable identity for an affected module and writes a new source set. A
   future representation-only cache change may roll `runtimeVersion` alone only
   after the fingerprint inputs distinguish it from executable semantics.

Each new source document whose reachable graph contains an external dependency
also records the runtime fingerprint used for its identity. A source document
without such a dependency uses the canonical empty fingerprint, and writers
omit the field for that value. The same identity therefore never has two
effective fingerprint representations. Other non-normative fields, including
annotations and synthetic retention links, may differ without changing module
identity. An absent fingerprint field always means the empty value for legacy
compatibility. Verification recomputes that document under the effective value.
Removing the non-empty field from a newer document therefore produces an
identity mismatch without a separate missing-field rule. A verifier rejects a
non-empty value on a document whose identity does not depend on it because that
fingerprint representation is not canonical.
As in the existing per-view verifier, each source document becomes the root of
its authored-import view and supplies that view's effective fingerprint.
Synthetic retention links are excluded. This lets one retained source set hold
unrelated legacy and current roots without applying one entry fingerprint to
every document.

Source and compiled documents share the base shape
`{ code, filename, imports: [{ specifier, link }], delegatedModuleIdentities? }`.
A source document may additionally carry the runtime fingerprint used for its
identity. Their link sets are different. A source document stores internal
authored-import links, including links to authored declarations. It omits fabric
edges so one program's source closure does not absorb another program.
Synthetic retention links may keep other source roots alive, but they are
excluded from the identity hash and executable graph traversal. A compiled
document stores runtime edges only between emitted modules. It includes fabric
edges needed by the self-contained compiled closure. The entry compiled
document also uses synthetic `cf:cache-root/` links to load emitted modules that
no runtime edge reaches. Compiled runtime and synthetic links only target
emitted modules. They never target a declaration document.

`delegatedModuleIdentities` is mutable metadata, excluded from the Merkle
identity, that records predecessor module hashes whose writer authority the
current module may exercise. Since content addressing does not authenticate
that mutable field, source documents carry the compiler integrity stamp on the
delegation field alone. Compiled documents authenticate it with their existing
root compiler stamp. Loaders discard delegation metadata without the applicable
stamp. The general source and compiled save path computes one union of newly
derived entries and authenticated entries already stored in either document set
under `editWithRetry`. It writes that same union to both sets and registers the
union from the successful commit under the attesting space in the active
runtime. It never replaces entries, because one content-addressed successor can
be shared by patterns updated from different predecessors.

Because `identity` is a one-way Merkle hash, internal source links are
load-bearing and stored explicitly. The parent hash commits to those children's
identities. The authored graph wiring is verifiable on load by recomputing
identities and checking each against its document key. This is the
content-addressed analog of the structural graph verifier. A module shared by N
programs is stored once per `(space, identity)`. An executable graph is an entry
identity over a shared set of module documents.
Piece revision history separately uses the immutable
`cf/authored-program-manifest/v1` value from
[piece-source-lifecycle.md](piece-source-lifecycle.md) to bind the canonical main
and every authored file, including files outside that executable graph.

This replaces the whole-program `PatternMeta` store after the flag flip (the two
coexist behind the flag until then). The compiler-version and `sesValidated`
gating carry over. `runtimeVersion` selects a compiled-cache variant. It is
separate from the `runtimeFingerprint` input to executable module identity. The
compiled set is only ever written from verified output (see the threat model).

### Module update delegation (`piece setsrc`)

`piece setsrc` is the temporary authority handoff while pattern files remain
local, content-addressed modules. Before compiling the replacement it loads the
current entry's verified recursive source closure. After compilation it matches
old and new modules by their canonical full authored filename (resolved relative
imports therefore meet at the same stored path; basenames are never matched).
For every unambiguous match, the successor records the direct predecessor plus
the predecessor's cumulative delegation list. This makes an update chain
cold-reload-stable.

Verified source loads register only field-integrity-authenticated lists;
integrity-valid compiled-cache loads register lists from their root-authenticated
documents. Registration and transitive closure are scoped by the space carrying
that attestation. Each transaction snapshots the resulting per-space maps, and
`writeAuthorizedBy` consults only the map for the target document's space. It may
then match the live writer's module hash directly or through that space's
snapshot, while its binding path must still match exactly. Delegation metadata
loaded from another space grants no authority. Source and compiled closure
loaders reject a cache graph containing any cross-space import link, so a child
document's local attestation cannot be flattened into the root's space.
Source-file spelling is diagnostic at verification because it is
resolver-dependent; a rename still receives no delegation because old and new
modules no longer match by canonical authored filename.
Ambiguous canonical filenames and unauthenticated metadata fail closed by
receiving no delegation. If a runtime-version miss recompiles from source, the
compiled-cache repair carries the authenticated map forward so later warm loads
retain the same authority chain. Cross-space closure replication copies code and
imports but omits the origin space's delegation metadata; the destination save
preserves only authority already authenticated in the destination. When multiple
patterns converge on one successor within a space across restarts, save-time
unioning preserves every predecessor in both cache sets and in the runtime that
performed the later update.

## Verifiable Execution Implications

The bundle verifier currently hand-parses AMD `define()` calls
([bundle-preflight.ts][c13], [compiled-bundle-verifier.ts][c14],
[compiled-js-parser.ts][c6]). Under ESM it must instead verify each
`ModuleSource`. Endo's precompiled module record exposes the module's imports,
exports, re-exports, and functor source in an analyzable, re-serializable form,
which is a cleaner substrate for the module-item classification that
SES_SANDBOXING_SPEC requires than regex-scanning a concatenated bundle. The
classification rules themselves (direct callbacks to trusted builders, safe
top-level functions, verified module-safe data) are unchanged; only the parser
that feeds them changes.

## Threat Model — the persistent compilation cache

Moving the compiled artifact into a **storage cell** changes the trust posture
versus the in-process cache, because the runtime `eval`s the cell's contents.
The cache is designed around this:

- **Source set integrity is free.** `pattern:<identity>` is keyed by a hash of
  its own contents, import graph, and recorded identity fingerprint, so a reader
  recomputes and checks the requested identity. A tampered source document or
  fingerprint fails the check. The verifier also rejects a non-empty fingerprint
  on a module whose identity does not depend on one. Recompiling a source
  document also re-runs the SES verifier, so a malformed source is rejected on
  the compile path. Mutable delegation metadata is deliberately outside that
  hash and requires its own field-level compiler integrity stamp before a loader
  can use it as authority.
- **Compiled set integrity is a CFC label.** `compileCache:<runtimeVersion>/<identity>`
  is keyed by the *source* identity, which does not bind the *JS* bytes.
  The compiled document therefore carries a **CFC integrity label**, written with
  the entry (`addIntegrity`) and **required on read** (`requiredIntegrity`). The
  label — not the SES verifier — is the security boundary for cache hits.
- **Fail-closed, not fail-hard.** A compiled document with a missing or invalid
  integrity label is treated as a **cache miss** and recompiled from the
  (self-verifying) source set, which re-runs the SES verifier. So the verifier
  always guards the compile/miss path; only integrity-valid warm hits skip it.
- **Why skip the SES verifier on a hit.** That verifier's guarantee is that no
  data flows between components in a way the runtime does not track. An attacker
  who can write arbitrary storage can already create such untracked flows
  (writing data a pattern reads), so re-verifying integrity-labeled cache hits
  adds no protection beyond the label while costing per-load work. Once the label
  is unforgeable (below), re-verification is redundant.
- **Per-space containment, then server-only writes.** The cache is per-space, so
  cross-tenant poisoning is impossible — only a space's own writers can affect
  its cache. The stamp is the constant `cf-compiled-by:cf-compiler` atom: it
  attests to the **code** that produced the doc (the system compiler), not the
  user who ran it, so every member of a shared space reads one cache (a
  per-user stamp made every other member a permanent miss and made their
  write-backs collide on the label merge). Minting is gated — prepare strips
  `cf-compiled-by:` atoms from any write not authored by a trusted builtin — so
  pattern code cannot stamp a forged doc. While compilation is still
  client-side, the label remains client-asserted at the raw-storage level, so
  within a space it amounts to self-poisoning (acceptable, and contained by the
  per-space scope). The end state moves **compilation to the server**: the
  server becomes the sole acceptor of that write integrity and can attach real
  attestation data, making the label a hard guarantee — with no change to the
  read path, which already requires it.
- **Cross-space closure replication (CT-1687).** Cache docs do not only live
  where they compiled: when a pattern materializes a child piece in another
  space (`Factory.inSpace(...)`), the runner replicates the child pattern's
  source + compiled closures into the child's space so the piece is
  independently loadable there (`PatternManager.replicatePatternToSpace`).
  Chain-of-custody holds — compiled docs are read through the integrity-gated
  loader (only docs already carrying the compiler stamp replicate) and
  re-stamped on the child-space write by a legitimate child-space writer.
  Module-update authority does not cross that boundary:
  `delegatedModuleIdentities` from the origin is omitted during replication,
  while any entries already authenticated in the destination are preserved.
  Note for the server-compilation end state: a client can then no longer stamp
  replicated compiled docs, so child spaces will need server-side replication
  or by-identity source recovery instead.
- **CFC verified-source derives from the source set, not the cached JS.** A
  poisoned-but-SES-safe JS document must not be able to spoof `fn.src` /
  authorship, so the CFC verified-source identity is anchored to the
  content-addressed `pattern:<identity>` source, never to the compiled
  document's source maps.

## Source Maps and Diagnostics

Per-module source maps replace the single inlined bundle map. `SESInternals`
already loads source maps keyed by filename ([ses-runtime.ts:142][c8]), so this
is plumbing: register each module's map under its content-addressed specifier.
Diagnostic names move from `/<id>/file.tsx:line:col` to
`cf:module/<hash>#<symbol>`, which is both stable and directly meaningful as an
identity.

## Interaction With Persistent Scheduler State

This spec supplies the stable implementation identity that
[persistent-scheduler-state.md](persistent-scheduler-state.md) assumes but does
not currently have. Concretely:

- `SchedulerActionObservationV1.implementationFingerprint` becomes
  `moduleHash(M)#symbol` instead of `src:/<id>/path:line:col`. It is stable
  across reloads and entry points. It changes when any transitive import (value
  or type) changes. It also changes when the runtime fingerprint changes and the
  reachable graph contains an external dependency. The scheduler continues to
  check `runtimeFingerprint` separately before trusting a persisted observation.
- The version-1 "implementation fingerprint is a placeholder" limitation in that
  spec is resolved: the fingerprint is now content-derived, so a clean
  observation can no longer be trusted against changed code.
- `processGeneration` and durable graph-snapshot identity remain future work and
  are not addressed here.

The identity decoupling can ship before the loader migration (see Phasing), so
the scheduler benefit does not block the larger loader change.

## Migration / Phasing

Sequence identity first to retire the rehydration bug quickly, then the loader.

1. **Phase 1 — Decouple identity (no loader change).** Compute `moduleHash(M)`
   over the per-module import graph (all edges) during compilation and stamp it into
   `fn.src` / the action implementation fingerprint, replacing the whole-program
   `computeId` prefix as the identity source. Keep AMD emission. This alone fixes
   the persistent-scheduler-state miss and the staleness gap, and is independently
   shippable behind the existing experimental flag.
2. **Phase 2 — ESM emission + SES module loading.** Switch `ModuleKind` to ESM,
   register content-addressed `ModuleSource`s, load via `importNow`, drop the
   `/${id}/` prefix and synthetic index. Port the verifier to `ModuleSource`.
3. **Phase 3 — Per-module compilation cache.** Re-key the compilation cache and
   `ModuleSource` cache by `moduleHash(M)`.
4. **Phase 4 — Cleanup.** Remove the AMD bundler, `amd-loader.ts`, the AMD
   define-parsing path in the verifier, and the prefix/index machinery in
   `pretransform.ts` once nothing depends on them.

## Risks and Open Questions

- **Synchronous loading.** Assumed: `importNow` + a fully-populated module map
  loads synchronously, covering every load path the scheduler invokes. Phase 0
  confirms the `importNow` shape and censuses the synchronous call sites rather
  than treating this as a go/no-go gate.
- **`ModuleSource` precompile cost.** Many small modules vs one bundle eval may
  shift setup cost. Benchmark compartment construction and `importNow` across
  realistic pattern sizes against today's single eval.
- **Verifier port effort.** Re-implementing classification against `ModuleSource`
  is the largest engineering item; budget accordingly and keep parity tests
  against the AMD verifier during transition.
- **Complete import-edge extraction.** Every `import`, `import type`, and
  `export … from` edge must be collected (the resolver already walks both import
  and export declarations [resolver.ts:94][c15]); confirm `import type` and
  type-only named specifiers are not dropped. Missing a type edge would silently
  treat a behavior-changing type edit as a no-op.
- **Cycle hashing.** Confirm the SCC condensation is deterministic and that SES's
  ESM cycle semantics match expectations for the existing pattern corpus.
- **Re-export and barrel files.** `export * from` edges must be counted (they
  are, via the resolver's export-declaration handling [resolver.ts:117][c15]);
  confirm barrels do not collapse distinct modules into one hash.
- **`normSrc` canonicalization.** The hash is over authored TS source with only
  line-ending normalization. Confirm it does not accidentally fold in our
  pretransform decorations (helper-import injection, `/${id}/` prefix), which
  would reintroduce TCB-version sensitivity. Define the canonical form precisely
  in implementation: it is the module's original authored bytes, pre-transform.

## Test Strategy

- Identical module compiled from two different entry points produces the same
  `moduleHash` and the same action implementation fingerprint.
- Changing a transitively-imported value function changes the importer's
  `moduleHash`; changing a transitively-imported **type** also changes it.
- Changing an authored `.d.ts` declaration changes every importer identity that
  reaches it, invalidates the compiled-cache entry, and persists the declaration
  as source-only history without emitting a JavaScript record. A later warm load
  does not request a compiled declaration document. Runtime-provided declaration
  stubs remain external fingerprinted dependencies.
- Recompiling unchanged source under a changed runtime fingerprint changes the
  `moduleHash` of every module whose reachable graph contains an external
  dependency. Its runtime-neutral module identity and the complete program's
  runtime-neutral digest remain unchanged. A module with no reachable external
  dependency keeps its `moduleHash`.
- An unrelated sibling file added to or removed from the compilation does not
  change an untouched module's hash.
- Import cycles produce deterministic, stable hashes across reloads.
- Re-export/barrel edges propagate transitive changes correctly.
- ESM loading via `importNow` produces the same exports and the same runtime
  behavior as the AMD bundle for the full pattern corpus.
- Verifier parity: every classification verdict the AMD verifier produces is
  reproduced by the `ModuleSource` verifier.
- Persistent-scheduler-state restart test: a pattern reloaded from a different
  entry point rehydrates clean (no rerun) where it previously missed.
- Compilation-cache test: editing one file invalidates only that module and its
  transitive importers.
- Content-addressed cache: a cold compile writes the source and compiled
  document sets into the space; a warm load hits the compiled set with no
  recompilation and identical exports. Two programs sharing a module produce a
  single compiled document (per-module dedup).
- Cross-space (`Pattern.inSpace`): a pattern authored/loaded in space A but
  instantiated through `PatternFactory.inSpace(B)` writes its source and compiled
  documents into **space B**, with import links resolving within B and the
  compiled documents carrying the required CFC integrity; a later load in B is a
  warm hit.
- Cache integrity fail-closed: a compiled document with a missing/invalid
  integrity label is treated as a miss and recompiled from the self-verifying
  source document; only integrity-valid documents are reused without
  re-verification.
- A future representation-only compile-cache `runtimeVersion` bump with an
  unchanged runtime fingerprint misses the compiled set and recompiles while
  the source set (`pattern:<identity>`) persists. Version 1 treats the current
  broad compiler-input version as executable and therefore rolls both values.
- A `runtimeFingerprint` bump gives an affected entry module a new executable
  identity and writes a new source set. The prior source set remains retained
  for history. Tests compare the runtime-neutral digest to classify this as a
  runtime rebuild rather than an authored-source change.

## Appendix: Current Pipeline Reference

[c1]: ../../packages/runner/src/harness/engine.ts
[c2]: ../../packages/runner/src/harness/pretransform.ts
[c3]: ../../packages/js-compiler/typescript/options.ts
[c4]: ../../packages/js-compiler/typescript/bundler/amd-loader.ts
[c5]: ../../packages/js-compiler/typescript/bundler/bundle.ts
[c6]: ../../packages/runner/src/sandbox/compiled-js-parser.ts
[c7]: ../../packages/runner/src/sandbox/ses-runtime.ts
[c8]: ../../packages/runner/src/sandbox/ses-runtime.ts
[c9]: ../../packages/runner/src/builder/module.ts
[c10]: ../../packages/runner/src/scheduler/run.ts
[c11]: ../../packages/data-model/src/value-hash.ts
[c12]: ../../packages/runner/src/compilation-cache/storage.ts
[c13]: ../../packages/runner/src/sandbox/bundle-preflight.ts
[c14]: ../../packages/runner/src/sandbox/compiled-bundle-verifier.ts
[c15]: ../../packages/js-compiler/typescript/resolver.ts

- Compilation entry: `Engine.compile` / `Engine.evaluate`
  ([engine.ts:175][c1], [engine.ts:232][c1]).
- Whole-program id: `computeId(program) = hashOf([main, ...files])`
  ([engine.ts][c1]).
- Prefixing and synthetic index: `transformProgramWithPrefix`
  ([pretransform.ts:36][c2]).
- AMD emission and loader shim ([options.ts][c3], [amd-loader.ts][c4],
  [bundle.ts:9][c5]).
- SES lockdown, per-execute compartment, string eval
  ([ses-runtime.ts:135][c8], [ses-runtime.ts:262][c7]).
- `fn.src` assignment from source location
  ([builder/module.ts:585][c9]).
- Scheduler implementation fingerprint
  ([scheduler/run.ts][c10]).
- Hash primitive: `hashOf` ([value-hash.ts:526][c11]).
- Import resolution / import graph: `getImports`, including `export * from`
  ([resolver.ts:94][c15]).
