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

All phases are complete. Identity decoupling (Phase 1, formerly behind
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

## Last Updated

2026-06-10

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
- **stable across TCB evolution**, because it hashes the author's source, not the
  compiled output. A transformer or compiler improvement must not retroactively
  change the identity of code the author never edited — code references can
  point at long-known-good versions, and the trusted computing base (the
  transformer/compiler) evolves independently of them;
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
- Keep code identity stable across TCB evolution: a transformer/compiler change
  must not invalidate references to unchanged authored source. Compilation-
  semantics changes are captured separately by the scheduler's
  `runtimeFingerprint`, not by the per-module content hash.
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
  - It keeps code identity **stable across TCB evolution.** The transformer and
    compiler are the trusted computing base; they improve over time. Hashing
    emitted output would give the same authored code a new identity on every
    transformer release, so a reference could never denote a long-known-good
    version of code. Hashing source ties identity to author intent. Compilation-
    semantics changes are handled on a separate axis by the scheduler's
    `runtimeFingerprint` (which already encodes the runtime/scheduler version),
    so the scheduler still invalidates correctly when the TCB changes — without
    destroying the durable code identity.
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
- **TCB independence.** `moduleHash(M)` is a function of authored source, not of
  the transformer/compiler version, so a TCB upgrade leaves it unchanged. The
  scheduler's `runtimeFingerprint` covers the "did the compilation semantics
  change" question separately, so trusting a persisted observation still
  requires both a matching `moduleHash` *and* a matching `runtimeFingerprint`.
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
module is stored as two regular cells, in the **target space** (per-space — there
is no global cache), and the storage layer's existing **sigil-link following**
under a schema loads the whole import closure transitively from a single request
(cycles handled by per-document dedup, as for any linked data):

1. **Source set — `pattern:<identity>`.** Authored TypeScript, keyed by the
   per-module Merkle `moduleHash` (`cf:module/<hash>`). It is runtime-version
   independent (written essentially once ever) and **self-verifying**: a reader
   checks `hash(content) === <identity>`, so content-addressing *is* the
   integrity — no separate label needed.
2. **Compiled set — `compileCache:<runtimeVersion>/<identity>`.** Compiled +
   verified JS, keyed by `(runtimeVersion, identity)`. A runtime/transformer
   upgrade rolls `runtimeVersion`, recompiling this set while the source set
   persists.

Each document holds `{ code, filename, imports: [{ specifier, link }] }`, where
`link` is a sigil link to the dependency's document in the same set. Because
`identity` is a one-way Merkle hash, the `imports` links are load-bearing (stored
explicitly), but the parent hash commits to its children's identities, so the
graph wiring is verifiable on load by recomputing identities and checking each
against its document key — the content-addressed analog of the structural graph
verifier. A module shared by N programs is stored once per `(space, identity)`;
a "program" is just an entry identity over a shared set of module documents.

This replaces the whole-program `PatternMeta` store after the flag flip (the two
coexist behind the flag until then). The compiler-version `fingerprint` and
`sesValidated` gating carry over: `runtimeVersion` is the fingerprint, and the
compiled set is only ever written from verified output (see the threat model).

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
  its own contents, so a reader self-checks `hash(content) === <identity>`. A
  tampered source document fails the check; a poisoned-but-different source would
  not hash to the requested identity. Recompiling a source document also re-runs
  the SES verifier, so a malformed source is rejected on the compile path.
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
  re-stamped on the child-space write by a legitimate child-space writer. Note
  for the server-compilation end state: a client can then no longer stamp
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
  across reloads, entry points, and TCB upgrades, and it changes when any
  transitive import (value or type) changes — exactly the validity condition the
  scheduler needs to decide whether a persisted observation may be trusted, in
  combination with the separately-checked `runtimeFingerprint`.
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
- Recompiling unchanged source under a changed transformer/compiler version
  leaves `moduleHash` unchanged (TCB independence); the scheduler still
  invalidates via `runtimeFingerprint`.
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
- Runtime-version bump misses the compiled set (recompile) while the source set
  (`pattern:<identity>`) persists.

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
