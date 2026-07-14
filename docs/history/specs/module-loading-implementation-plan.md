---
status: historical
created: 2026-05-31
archived: 2026-07-08
reason: "Executed plan; the ESM module-record loader is the only loader."
---

# Content-Addressed Module Loading — Implementation Plan

> **Status:** Shipped — the ESM module-record loader is now the only loader.
> The `esmModuleLoader`/`CF_ESM_MODULE_LOADER` flag and the AMD bundle path
> (bundler, whole-bundle verifier, `Engine.compile`/`evaluate`, AMD
> compilation cache) have been removed; flag/AMD references below are
> historical design context.

Companion to [module-loading.md](../../specs/module-loading.md). That document specifies the
*what* and *why*; this one specifies the *how*: ordered, reviewable engineering
steps with the files each touches, exit criteria, and validation commands.

## Last Updated

2026-06-10

## Current status

| Phase | Status | Notes |
| --- | --- | --- |
| 0 — Loader shape confirmation | Done | SES `importNow` + virtual (third-party) module records load synchronously, incl. cycles. `ModuleSource`/`StaticModuleRecord` are not exposed by this `ses` build, so the loader uses `{ imports, exports, execute }` records. |
| 1 — Decouple identity | Done (merged) | Per-module Merkle hash; scheduler implementation fingerprint is content-addressed and entry-point/TCB independent. Shipped behind `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE`. |
| 2 — ESM emission + SES module loading | Done (shipped; the only loader) | `compileToRecordGraph` + `evaluateRecordGraph` (`engine.ts`) run the full `CommonFabricTransformerPipeline` (not bare `transpileModule`), assemble content-addressed records, register per-load/per-module source maps, and load multi-module programs end-to-end. Engine integration, `export *` re-exports, live module-namespace bindings (#3797), and CFC verified-source location resolution (#3785, #3787) are all wired. The flag is now also plumbed to the browser client (#3796). |
| 3 — Verifier port | Done (the ESM verifier is the enforcement path) | The deep SES_SANDBOXING module-item classification (`verifyCompiledModuleBody`, reusing the shared `classifyModuleItems` core) runs **per module** in the ESM compile path (`engine.ts`). `verifyModuleGraph` validates graph shape/wiring. Additional hardening landed beyond the original plan: import-edge target validation (#3778), pattern provenance brand (#3779), frozen exported patterns (#3777). **Remaining (release gate):** the full-corpus differential parity oracle — `esm-verifier-parity.test.ts` currently covers crafted CF-shaped fixtures only, not every pattern-corpus verdict. |
| 4 — Per-module compilation cache | Done (shipped) | Content-addressed cell cache built and wired into the ESM `PatternManager` load path (`compilation-cache/cell-cache.ts`, `pattern-manager.ts`). Per space: source set `pattern:<identity>` (self-verifying via Merkle recompute) + compiled set `compileCache:<runtimeVersion>/<identity>` (CFC `addIntegrity` on write, fail-closed on read). A warm full hit feeds cached bodies back through `compileToRecordGraph` and skips the TypeScript compile / transformer pipeline; a miss compiles and writes both sets back on a fresh transaction. Gated on `cfcEnforcementMode !== "disabled"`. **Divergence from the original design:** the plan assumed the per-module `cf:module/<hash>` identity was already entry-point independent, but the ESM compile path resolved a `/<computeId>/`-prefixed program, leaking the whole-program prefix into the identity — so cross-program dedup and the spec's entry-point-independence guarantee did not actually hold. Step 5a (`computeModuleIdentities` in `module-record-compiler.ts`) strips the prefix for identity computation only, making identities prefix-free/dedupable while leaving source maps + `fn.src` resolution on the prefixed path untouched. Full runner suite green flag-on and flag-off. |
| 5 — Default-on + AMD removal | Done | The flag was flipped on by default, then the flag itself, the AMD bundle pipeline (bundler, whole-bundle verifier, `Engine.compile`/`evaluate`), and the AMD compilation cache (`CachedCompiler`) were removed. |

Phases 0–1 merged earlier. Phases 2–4 mechanism merged behind the (since
removed) default-off flag (#3763), then substantially completed by follow-up
work: ESM source-location / CFC verified-source identity (#3785, #3787),
security hardening (#3777–#3779), module-namespace live bindings (#3797), and
client flag plumbing (#3796). The `cfc-group-chat-demo` integration test — the
original end-to-end blocker — passed flag-on as of #3797, the flag was flipped
on by default, and Phase 5 finished by deleting the flag and the AMD path.

## Guiding constraints

- **Ship the scheduler fix first.** Identity decoupling (Phase 1) does not
  require the loader change and resolves the persistent-scheduler-state
  rehydration miss on its own. It is the priority.
- **Never under-count dependencies (value or type).** Over-approximation (extra
  invalidation) is acceptable; missing a real behavioral change — including a
  change to an imported type that the transformer lowers into a schema — is not.
- **Synchronous execution is a given.** The scheduler runs actions
  synchronously; the loader must load synchronously (SES `ModuleSource` +
  `importNow` with a pre-populated module map). This is assumed, not something
  to re-litigate — no run-time `await` may be introduced into the load path.
- **Keep AMD and ESM paths parallel behind a flag** until the ESM path reaches
  full verifier and corpus parity. No big-bang switch.
- **Each phase lands independently** with its own tests green and is revertible.

## Flags

- Reuse `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE` for Phase 1 identity changes
  consumed by the scheduler (already plumbed through runtime, shell, toolshed,
  CLI, memory).
- Add a new `EXPERIMENTAL_ESM_MODULE_LOADER` flag for Phases 2–5, defaulting
  off, mirroring the existing experimental-option plumbing
  (`packages/runner/src/runtime.ts`, `packages/shell/src/lib/env.ts`,
  `packages/toolshed/env.ts`, `packages/cli/lib/utils.ts`).

---

## Phase 0 — Loader shape confirmation (no production code)

Synchronous loading is assumed (see constraints). Phase 0 is a short
confirmation that the chosen mechanics fit, not a go/no-go gate.

### 0.1 `importNow` shape prototype

Throwaway script under `packages/runner/scratch/` (do not commit to `src/`):

- `lockdown()` with the existing `DEFAULT_LOCKDOWN_OPTIONS`.
- Build a `Compartment` whose module map contains three precompiled
  `ModuleSource`s: module `a` (entry) imports a function from module `b` and a
  symbol from a stub `cf:runtime/commonfabric`.
- Resolve with a `resolveHook` over content-addressed specifiers and load with
  `compartment.importNow("cf:module/<hashA>")`.
- Confirm exports resolve, cyclic `a<->b` works, and a thrown error surfaces a
  usable stack.

**Exit criteria:** a working `importNow` + pre-populated-module-map skeleton to
template Phase 2's loader from.

### 0.2 Synchronous-caller census

Enumerate every caller of `Engine.evaluate`
(`packages/runner/src/harness/engine.ts:232`) and `SESIsolate.execute`
(`packages/runner/src/sandbox/ses-runtime.ts:135`) so the ESM path covers each
synchronous load site. Output a short table in this plan's follow-up notes.

---

## Phase 1 — Decouple identity (no loader change) — PRIORITY

Goal: the action implementation fingerprint becomes a per-module Merkle content
hash, stable across entry points **and across TCB (transformer/compiler)
upgrades**, and sensitive to transitive changes in any imported module (value or
type), while still emitting AMD.

### 1.1 Import-graph extraction (all edges)

- Extend `getImports` (`packages/js-compiler/typescript/resolver.ts:94`) to
  collect **every** import and `export … from` edge — including `import type`,
  `export type`, type-only named specifiers, side-effect imports, and barrels.
  There is no value/type filtering: type edges are kept because types are
  load-bearing (the transformer lowers them into generated schemas).
- No `verbatimModuleSyntax` requirement and no dependence on emit elision; the
  graph is read directly from the authored source AST.

**Decided:** `normSrc` is the **authored TypeScript source** of each module
(line-ending-normalized, pre-transform, pre-emit), not compiled JS. Hashing
source keeps code identity stable across transformer/compiler upgrades (the TCB
evolves independently of code references) and naturally includes types. The
scheduler's separate `runtimeFingerprint` handles compilation-semantics changes.
See the spec's Module Identity section.

**Files:** `packages/js-compiler/typescript/resolver.ts`.
**Exit:** a function returning, per module, its ordered import-edge specifiers
(value and type alike).

### 1.2 Merkle module-hash computation

- New module `packages/runner/src/harness/module-identity.ts`:
  - `computeModuleHashes(program): Map<filePath, string>`.
  - `normSrc(M)` is the module's authored source bytes with line-ending
    normalization only — taken before pretransform's helper-import injection and
    `/${id}/` prefixing, so those decorations never enter the hash.
  - Build the import graph from 1.1; resolve specifiers to module paths or
    external runtime leaves.
  - Condense strongly-connected components (Tarjan) to handle ESM cycles; hash
    each SCC as a unit (members sorted by path) and assign members
    `(sccHash, index)`.
  - Leaf for external runtime modules: `runtime:<name>@<runtimeFingerprint>`.
  - Hash via `hashOf` (`packages/data-model/src/value-hash.ts:526`) with a
    version tag `"cf/module-id/v1"`.
- Define and document the canonical `normSrc` form: strip inline source maps,
  `//# sourceURL`, and any `/${id}/` path decoration; retain every behavioral
  byte.

**Files:** new `harness/module-identity.ts`; unit tests
`packages/runner/test/module-identity.test.ts`.
**Exit:** unit tests below green.

### 1.3 Stable intra-module action symbol

- Assign each trusted-builder callback (`pattern`, `lift`, `handler`, `action`)
  and each exported function a stable symbol: export name where available,
  else a deterministic declaration-path/ordinal. The closure/hoisting
  transformers already name these callbacks
  (`packages/ts-transformers/src/closures/`,
  `module-scope-callback-hoisting.ts`); extend them to emit a stable symbol
  annotation rather than relying on `line:col`.

**Files:** `packages/ts-transformers/src/closures/*`, relevant transformer in
`packages/ts-transformers/src/transformers/`.
**Exit:** every action-bearing declaration carries a deterministic symbol that
does not depend on surrounding files.

### 1.4 Thread `implementationHash` to the scheduler

- Add an `implementationHash` carrier on actions distinct from `src` (keep `src`
  for diagnostics, hover preview, and the source view — do **not** overload it).
  - Set it where action names are built:
    `schedulerJavaScriptActionName` / `schedulerRawActionName`
    (`packages/runner/src/runner.ts`) compose
    `moduleHash(M) + "#" + stableSymbol`.
  - `setRunnableName` (`packages/runner/src/runner-utils.ts`) gains an option to
    set `implementationHash`.
- Change `schedulerImplementationFingerprint`
  (`packages/runner/src/scheduler/action-run.ts:589`) to prefer
  `action.implementationHash`, falling back to `src:${action.src}` when absent
  (so behavior is unchanged when the flag is off / hash missing).
- Confirm the value flows into
  `SchedulerActionObservationV1.implementationFingerprint`
  (`packages/runner/src/scheduler/persistent-observation.ts`).

**Files:** `runner.ts`, `runner-utils.ts`, `scheduler/action-run.ts`,
`scheduler/persistent-observation.ts`.
**Exit:** with the scheduler flag on, observations carry the content hash; with
it off, fingerprints are byte-for-byte unchanged from today.

### 1.5 Tests (Phase 1 gate)

- `module-identity.test.ts`:
  - identical module compiled from two different entry points → identical hash;
  - changing a transitively-imported function → importer hash changes;
  - changing a transitively-imported **type** → importer hash changes
    (`import type` edges count);
  - recompiling unchanged source under a bumped transformer/compiler version →
    hash unchanged (TCB independence);
  - adding/removing an unrelated sibling file → untouched module hash stable;
  - import cycle → deterministic, stable hash across repeated runs;
  - `export *` barrel propagates a transitive change.
- Scheduler restart test (extend
  `packages/runner/test/scheduler-observations.test.ts`): a pattern reloaded
  from a different entry point rehydrates clean (no rerun) where it previously
  missed.

**Validation:**
```
deno test -A packages/runner/test/module-identity.test.ts
deno test -A packages/runner/test/scheduler-observations.test.ts
deno task check
```
**Exit:** the entry-point rehydration miss is gone; full runner + memory suites
green with the scheduler flag on and off.

---

## Phase 2 — ESM emission + SES module loading (behind flag, dev/trusted only)

> **Status: Done** (behind `CF_ESM_MODULE_LOADER`, default off). Implemented as
> `Engine.compileToRecordGraph` + `Engine.evaluateRecordGraph` rather than a
> branch inside the old `Engine.evaluate`. The sub-steps below are kept as the
> design record; deviations: the CF transformer pipeline runs (not bare
> `transpileModule`), source maps are composed per-load and per-module for CFC
> verified-source identity (#3785, #3787), and the flag is plumbed to the
> browser client (#3796).

### 2.1 ESM compiler mode

- Add an ESM emit path to the compiler: `ModuleKind.ES2022`, no `outFile`. Keep
  the AMD path intact, selected by `EXPERIMENTAL_ESM_MODULE_LOADER`.
  (`verbatimModuleSyntax` is optional here for emit hygiene only; module identity
  no longer depends on emit-time type elision — it is computed from authored
  source in Phase 1.)

**Files:** `packages/js-compiler/typescript/options.ts`,
`packages/js-compiler/typescript/compiler.ts`, bundler bypass in
`packages/runner/src/harness/engine.ts:175` (`compile`).

### 2.2 Content-addressed registration

- For each emitted module, precompile a `ModuleSource` and register it under
  `cf:module/<moduleHash(M)>` (reuse Phase 1 hashes).
- Build a per-load `resolveHook` (relative specifier + referrer →
  content-addressed specifier, from the compile-time import map) and an
  `importNowHook` that returns the registered `ModuleSource`.
- Runtime modules registered as `cf:runtime/<name>` entries instead of
  `define()` injections.

**Files:** new loader in `packages/runner/src/sandbox/` (e.g.
`esm-module-loader.ts`); `runtime-modules.ts`; `engine.ts` (`createRuntimeDeps`
replacement for ESM).

### 2.3 Synchronous evaluate path

- New branch in `Engine.evaluate` that, under the flag, populates the module map
  and runs `compartment.importNow(entrySpecifier)`, returning exports through the
  same synchronous `.inner()` contract used today (`engine.ts:273`).
- Remove the `/${id}/` prefix and synthetic `/index.ts` for the ESM path
  (`packages/runner/src/harness/pretransform.ts:36`); the content-addressed
  registry makes them unnecessary.

**Exit:** under the flag, a pattern loads and runs via ESM with identical
exports to the AMD path; AMD remains default.

### 2.4 Source maps and diagnostics

- Register each module's source map under its content-addressed specifier via
  `SESInternals.loadSourceMap` (`packages/runner/src/sandbox/ses-runtime.ts:142`).
- Confirm stack traces and the shell source view resolve `cf:module/<hash>#sym`.

**Validation:**
```
EXPERIMENTAL_ESM_MODULE_LOADER=true deno test -A packages/runner
EXPERIMENTAL_ESM_MODULE_LOADER=true HEADLESS=1 deno task integration patterns
```
**Exit:** runner + pattern integration corpus passes under the ESM flag (trusted
path); behavior parity with AMD.

---

## Phase 3 — Verifier port (gates default-on for untrusted code)

> **Status: Classification ported and wired; corpus parity oracle pending.**
> `verifyCompiledModuleBody` (reusing the shared `classifyModuleItems` core) runs
> per module in the ESM compile path (`engine.ts`), and `verifyModuleGraph`
> checks graph shape/wiring. The remaining release gate is the full-corpus
> differential parity oracle — `packages/runner/test/esm-verifier-parity.test.ts`
> exists but covers crafted CF-shaped fixtures, not every pattern-corpus verdict.

The bundle verifier currently parses AMD `define()` calls and must verify
`ModuleSource` records before ESM can run untrusted patterns by default.

- Port classification (`packages/runner/src/sandbox/bundle-preflight.ts`,
  `compiled-bundle-verifier.ts`, `compiled-js-parser.ts`) to operate on the
  precompiled `ModuleSource` (imports/exports/reexports + functor source) rather
  than on a concatenated bundle.
- Keep the SES_SANDBOXING_SPEC classification rules unchanged (direct callbacks
  to trusted builders, safe top-level functions, verified module-safe data); only
  the parser feeding them changes.
- **Parity harness:** for the full pattern corpus, assert every verdict the AMD
  verifier produces is reproduced by the `ModuleSource` verifier. Treat any
  divergence as a release blocker.

**Files:** the three verifier files above; new parity test under
`packages/runner/test/`.
**Exit:** verifier parity green across the corpus; ESM path is now safe for
untrusted execution.

---

## Phase 4 — Per-module compilation cache (content-addressed cells)

> **Status: Done** (behind `CF_ESM_MODULE_LOADER`, default off). Both jobs
> shipped: the production ESM path is now cacheable **and** persisted as
> content-addressed cells. The cell cache (`compilation-cache/cell-cache.ts`) is
> wired into `PatternManager.compileViaCellCache`; on a warm full hit the cached
> per-module bodies are fed back through `compileToRecordGraph` (via the
> `precompiledModulesFor` seam) so the TypeScript compile + transformer pipeline
> are skipped, and on a miss both document sets are written back on a fresh,
> CFC-prepared transaction. The full runner suite passes both flag-on and
> flag-off (incl. the formerly-failing `pattern-manager.test.ts` AMD cases, now
> pinned to the AMD loader).
>
> **One design assumption proved false during implementation** and was corrected
> in step 5a: the per-module `cf:module/<hash>` identity was *not* actually
> entry-point independent on the ESM path — `compileSourcesToRecords` hashed the
> resolved program whose files carry the whole-program `/<computeId>/` prefix, so
> the prefix leaked into the identity (no cross-program dedup; contradicting the
> entry-point-independence guarantee in `module-loading.md`). The fix strips the
> prefix for identity computation only (`computeModuleIdentities`), leaving record
> source URLs, source-map keys, and `fn.src` resolution on the prefixed path.
> The injected, already-unprefixed `cfc.ts` helper is reached on load via a
> synthetic root link from the entry document (nothing imports it at runtime).

### 4.0 Design — two content-addressed document sets, per space

Both sets are stored as **regular cells** in the **target space** (per-space;
no global cache). Loading relies on the existing storage behavior that follows
**sigil links** under a schema and transitively loads the closure — the same way
ordinary linked data loads — so requesting the entry document pulls in its whole
import graph. Cycles are handled by the loader's per-document dedup, as for any
linked data.

Each document, in either set, stores:

```
{
  code: string,                                   // TS (set 1) or compiled JS (set 2)
  filename: string,                               // authored module path
  imports: Array<{ specifier: string; link: <sigil link to the dep's doc> }>,
}
```

1. **Source documents — `pattern:<identity>`.** Authored TypeScript, keyed by the
   module's content-addressed **identity** (the Phase 1 per-module Merkle hash,
   already surfaced as `cf:module/<moduleHash>`; `computeModuleHashes` in
   `harness/module-identity.ts`). `imports[].link` points at the dependency's
   `pattern:<dep-identity>` doc. Runtime-version independent — written
   essentially once ever.
   - **Self-verifying:** a reader checks `hash(content) === <identity>`, so the
     source set needs no separate integrity label — content-addressing is the
     integrity.

2. **Compiled documents — `compileCache:<runtimeVersion>/<identity>`.**
   Compiled + verified JS, keyed by `(runtimeVersion, identity)`.
   `imports[].link` points at the dependency's
   `compileCache:<runtimeVersion>/<dep-identity>` doc. A runtime/transformer
   upgrade changes `runtimeVersion`, so the compiled set is recompiled while the
   source set persists.
   - **Integrity, not content-addressing:** the key's `identity` is the *TS*
     hash, which does **not** bind the JS bytes. The compiled doc therefore
     carries a **CFC integrity label** (`addIntegrity` on write,
     `requiredIntegrity` on read), which is the binding/provenance — see the
     threat model in `module-loading.md`.

`identity` is a one-way Merkle hash, so the `imports` links are **load-bearing,
not derivable** — they are stored explicitly. But the parent hash *commits to*
its children's identities, so on load the graph wiring is verifiable by
recomputing identities from the loaded source set and checking each equals its
document key (the content-addressed analog of `verifyModuleGraph`).

### 4.1 Load flow (warm-full / partial / cold)

1. Compute per-module identities for the program (`computeModuleHashes`).
2. Request `compileCache:<runtimeVersion>/<entry-identity>` with a
   link-following schema; the storage layer loads the reachable compiled closure.
3. **Warm full hit** — every reachable compiled doc present and integrity-valid:
   assemble the record graph from the cached bodies and `evaluateRecordGraph`
   directly. **No TS compile and no SES re-verification.**
4. **Partial / cold** — any module missing or integrity-invalid: fall back to the
   source set (`pattern:<identity>`, or the program input on a total miss),
   compile through the CF transformer pipeline, **SES-verify** the freshly
   compiled bodies, reuse cached compiled bodies for unchanged-identity modules
   during record assembly, then write back (4.2) the modules that were compiled.
5. Evaluate via `evaluateRecordGraph` (unchanged).

Fail-closed: a missing or invalid integrity label on a compiled doc is treated
as a **cache miss → recompile from source**, never as a hard error. The SES
verifier thus runs on the compile/miss path only; warm hits trust the integrity
label. (Mirrors AMD's "skip evaluate-time validation for SES-validated hits".)

### 4.2 Write flow (on compile)

On any compile (cold or partial), write into the **target space**:

- the source doc `pattern:<identity>` for each compiled module (idempotent;
  content-addressed, so a re-write is a no-op);
- the compiled doc `compileCache:<runtimeVersion>/<identity>` with the CFC
  integrity label, for each compiled module.

Dedup: a module shared by N programs (same identity) is written once per
`(space, identity)` — programs are just different entry identities over a shared
set of module docs.

### 4.3 Ordered steps

- **4.3.1 Cache-doc schemas + keys.** ✅ Done. Source-doc / compiled-doc cell
  schemas (`code`, `filename`, `imports: [{ specifier, link }]`), the
  `pattern:<identity>` / `compileCache:<runtimeVersion>/<identity>` key scheme,
  and the integrity-label constant live in
  `packages/runner/src/compilation-cache/cell-cache.ts`. Import-link entries use
  sigil links (`asCell`) + a link-following schema. `runtimeVersion` is the
  `COMPILE_CACHE_RUNTIME_VERSION` constant, set automatically from
  `cf/esm-compile/<fingerprint>`, a hash of the compiler inputs defined in
  `compiler-fingerprint.deno.ts`. Deno source runs resolve the checked-in source
  marker to that fingerprint at runtime. Runtimes without repository file access
  skip compiled-cache reads and writes until a binary build writes the
  fingerprint into `compile-cache-version.ts` before `deno compile`.
- **4.3.2 Source-set store.** ✅ Done. `writeSourceDocs` / `loadSourceClosure`
  (link-following, `sync()`-ing each cell for cross-session loads) +
  `verifySourceDocs` (Merkle `hash(content) === key` recompute). **Files:**
  `cell-cache.ts`.
- **4.3.3 Compiled-set store.** ✅ Done. `writeCompiledDocs` stamps the constant
  `cf-compiled-by:cf-compiler` atom via `ifc.addIntegrity` — it attests to the
  system compiler, not the user (a per-user `cf-compiled-by:<did>` atom made a
  shared space's cache a permanent miss for every other member and made their
  write-backs collide on the label merge). Minting is gated: prepare strips
  `cf-compiled-by:` atoms from non-builtin-authored writes (audit S4 family).
  `loadCompiledClosure` fail-closes on a missing/mismatched label (treated as a
  miss). Requires an enforcing CFC mode + `prepareCfc()` + commit. **Files:**
  `cell-cache.ts`, `cfc/metadata.ts`, `cfc/prepare.ts`.
- **4.3.4 Engine seam.** ✅ Done. `Engine.compileToRecordGraph` accepts
  `precompiledModules` / `precompiledModulesFor` (cached bodies keyed by
  **content identity**, not path) and returns `entryIdentity` +
  `modules: CacheableModule[]` for write-back; a full hit skips the TS compile.
  **Files:** `packages/runner/src/harness/engine.ts`, `harness/types.ts`. (The
  identity-space keying + prefix normalization are step 5a, above.)
- **4.3.5 PatternManager ESM load.** ✅ Done. `compileViaCellCache`:
  identity-keyed compiled-set fetch (lazy, via `precompiledModulesFor`) → warm
  full hit OR full recompile → `evaluateRecordGraph` → write-back on miss
  (fire-and-forget, fresh tx). Threaded `{ space, tx }` from `compilePatternOnce`.
  **Files:** `packages/runner/src/pattern-manager.ts`.
- **4.3.6 Graph-wiring verification.** ✅ Done. `loadVerifiedSourceClosure`
  recomputes each module's Merkle identity from the loaded source set and
  requires it to equal its doc key; `verifyCompiledModuleBody` + `verifyModuleGraph`
  still run on every emitted body on the warm path (defense-in-depth while the
  integrity label is client-asserted). **Files:** `cell-cache.ts`,
  `sandbox/module-record-verifier.ts`.
- **4.3.7 Replace whole-program pattern storage (gated).** Deferred to Phase 5
  (intentional). The `pattern:<patternId>` `PatternMeta` store and the new
  content-addressed source set coexist behind the flag; Phase 5 removes the old
  store. (No migration: cache + pattern data are cleared at the flip.)

### 4.4 Tests

- **Cold → warm.** First compile writes both doc sets into the space; second
  load hits the compiled set with **no recompile** (assert via a compile spy /
  the absence of TS-compile work), producing identical exports.
- **Partial invalidation.** Editing one module in a multi-file program changes
  only that module's identity (+ its transitive importers); untouched modules
  keep their `pattern:`/`compileCache:` docs and are reused. Assert exactly the
  changed module + importers are recompiled/rewritten.
- **Per-module dedup.** Two programs importing the same util produce a single
  `compileCache:<rtver>/<util-identity>` doc in the space.
- **`Pattern.inSpace(...)` — A → B (required).** A pattern authored/loaded in
  space A but instantiated through `PatternFactory.inSpace(B)` writes its source
  and compiled docs into **space B**, with `imports` links resolving within B;
  a subsequent load in B is a warm hit. Assert the docs land in B (not A), the
  link closure resolves in B, and the compiled docs carry the required integrity.
  Build on `packages/runner/test/pattern-scope.test.ts`, which already exercises
  `inSpace`.
- **Integrity fail-closed.** A compiled doc with a missing/invalid integrity
  label is treated as a miss and recompiled from the (self-verifying) source doc;
  only integrity-valid docs are reused without re-verification.
- **Runtime-version bump.** Changing `runtimeVersion` misses the compiled set
  (recompile) while the source set (`pattern:<identity>`) persists.
- **Replace the AMD-shaped cache tests for ESM.** Make the two
  `pattern-manager.test.ts` "compilation cache integration" cases loader-aware:
  the AMD path keeps the `jsScript`/`harness.evaluate(skipBundleValidation)`
  assertions; the ESM path asserts the content-addressed-cell behavior above.

**Validation:**

```
deno test -A packages/runner/test/pattern-manager.test.ts
deno test -A packages/runner/test/pattern-scope.test.ts
CF_ESM_MODULE_LOADER=1 deno task test
CF_ESM_MODULE_LOADER=1 deno task integration patterns
```

**Exit:** warm loads skip compilation; single-file edits invalidate exactly the
changed module + transitive importers; the A→B `inSpace` test passes; the two
compilation-cache tests pass under both loaders; no correctness regression.

> **Future optimization (not gated on this phase):** truly isolated per-module
> recompilation (compile only changed modules rather than re-running the TS
> program pass and reusing cached bodies at assembly). The warm-full-hit path
> already avoids all compilation; this only sharpens the partial-miss cost.

---

## Phase 5 — Default-on and cleanup

> **Status: Not started.** Gated on the Phase 3 corpus parity oracle, a green
> full-suite flag-on sweep (`CF_ESM_MODULE_LOADER=1 deno task test` +
> `deno task integration` from the repo root), and benchmarks. The canary
> PR (#3782) is the standing flag-on CI signal.

> **Source-location fidelity: RESOLVED (no longer a default-on blocker).**
> Earlier code comments in `module-record-compiler.ts` / `engine.ts` flagged
> `fn.src` / source-location resolution under the ESM loader as "the remaining
> item before the flag can be enabled by default." That is done. Both consumers
> resolve flag-on to the canonical reload-stable `cf:module/<hash>/<path>` form:
> CFC verified-source (`isVerifiedSourceInLoad` → `kind: "verified"`) and the
> scheduler content-addressed implementation hash. Two mechanisms cover it —
> Deno's `indexOf`-into-`script` fallback (`resolveLocationFromFunctionSource`)
> and the per-module source maps the engine registers for browsers (whose stacks
> surface the per-module eval frame). Covered by
> `packages/runner/test/esm-source-location.test.ts` (CFC parity + scheduler
> hash + source-location suffix parity flag-on/flag-off) and the browser
> eval-frame resolution case in `module.test.ts`. The stale comments were
> corrected. **Remaining verification (not a blocker):** a full browser
> integration test under `packages/patterns/integration` driving the shell with
> `CF_ESM_MODULE_LOADER=1` — the resolution logic + wiring are unit-covered, but
> end-to-end browser stacks are only exercised by the canary, not a committed
> assertion.

> **Cross-loader action-identity re-key (state migration, discovered).** The
> scheduler implementation hash is `cf:module/<hash>:line:col`. The `:line:col`
> source-location suffix is identical flag-on/flag-off (asserted), but the
> per-module `<hash>` DIFFERS across loaders: ESM uses the prefix-free
> `computeModuleIdentities` hash, AMD its legacy whole-program scheme. So
> flipping the default re-keys persisted scheduler action identity once. This is
> acceptable (AMD removal below collapses to a single scheme) but the flip must
> account for it — either accept a one-time re-run of persisted actions or stage
> the rollout. Tracked here rather than as a source-location regression.

- Flip `EXPERIMENTAL_ESM_MODULE_LOADER` default on after Phases 2–4 are green and
  benchmarks acceptable.
- Remove the AMD bundler, `packages/js-compiler/typescript/bundler/amd-loader.ts`,
  the AMD parse path in the verifier, and the prefix/synthetic-index machinery in
  `pretransform.ts`.
- Update `module-loading.md` status to Implemented and fold these notes into an
  `implementation_notes.md` log.

**Exit:** AMD path deleted; full `HEADLESS=1 deno task test`,
`HEADLESS=1 deno task integration`, and `deno task check` green with ESM as the
only loader.

---

## Cross-cutting work items

- **Benchmarks.** Add compartment-construction and `importNow` benchmarks vs the
  current single bundle eval, across small/large patterns
  (`packages/runner/test/*.bench.ts`). Watch many-small-modules setup cost.
- **`normSrc` canonicalization tests.** Prove the hash is invariant to incidental
  emit noise and variant to every behavioral byte.
- **Telemetry.** Count identity-stability hits/misses so we can confirm in the
  field that reload-from-different-entry-point no longer changes fingerprints.
- **Docs.** Update `docs/development/` debugging notes that reference AMD module
  names / `/<id>/` source paths once Phase 5 lands.

## Risk checkpoints

| Risk | Phase | Mitigation / gate |
| --- | --- | --- |
| Missing an import edge (esp. `import type`) | 1 | Collect all import/export-from edges from the source AST; test that a type-only edit changes the importer hash. |
| Pretransform decorations leaking into `normSrc` | 1 | Hash authored source pre-transform; test TCB-version independence. |
| Verifier divergence on ESM | 3 | Corpus parity harness as release blocker before default-on. |
| Many-small-modules perf regression | 2/4 | Benchmarks; consider one compartment per load with shared map. |
| Cycle hashing nondeterminism | 1 | SCC condensation with sorted members; determinism test. |
| Hidden async load site | 0/2 | Synchronous-caller census in Phase 0. |
| Action-identity re-key on default flip (ESM vs AMD module hash) | 5 | Source-location suffix parity asserted; accept one-time persisted-action re-run or stage rollout; AMD removal collapses to one scheme. |

## Suggested commit/PR sequence

1. Phase 0 spike findings (notes only).
2. Phase 1.1–1.2: value-graph + Merkle hash + unit tests.
3. Phase 1.3–1.5: stable symbols + scheduler fingerprint wiring + restart test.
   *(Ships the persistent-scheduler-state fix.)*
4. Phase 2: ESM emit + loader behind flag + parity tests.
5. Phase 3: verifier port + parity harness.
6. Phase 4: per-module cache.
7. Phase 5: default-on + AMD removal.
