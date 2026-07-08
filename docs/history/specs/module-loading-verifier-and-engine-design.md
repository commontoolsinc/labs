# ESM Module Loading: Verifier Port & Engine Integration — Design
> **Historical — not maintained.** Created: 2026-05-31.
> Design for the now-shipped ESM module loader. See `docs/history/README.md` for what "historical" means here.


> **Status:** Shipped — the ESM module-record loader is now the only loader.
> The `esmModuleLoader`/`CF_ESM_MODULE_LOADER` flag and the AMD bundle path
> (bundler, whole-bundle verifier, `Engine.compile`/`evaluate`, AMD
> compilation cache) have been removed; flag/AMD references below are
> historical design context.

Companion to [module-loading.md](../../specs/module-loading.md) and
[module-loading-implementation-plan.md](./module-loading-implementation-plan.md).
Phase 1 (content-addressed identity) and the Phase 2–4 loader mechanism are
merged behind the default-off `esmModuleLoader` flag. This document designs the
two hard remaining pieces — the **security verifier port** and **Engine
integration** — plus the smaller items, and specifies how the whole transition
stays behind the flag until a final, deliberate rollout.

## Last Updated

2026-05-31

## Flag strategy: the entire transition stays behind `esmModuleLoader`

Every remaining piece lands as dormant or branch-gated code with the AMD bundle
path as the default, so `main` stays green throughout.

- **Verifier port, Engine integration, `export *`, live bindings, benchmarks**:
  reached only when `esmModuleLoader` is on (a branch in `Engine.compile`/
  `evaluate`); the AMD path is untouched when off.
- **Mandatory flag-on CI lane.** Dormant code that nothing exercises bit-rots,
  and parity we never run is parity we cannot claim. Add a CI job that runs the
  runner + pattern integration suites with `esmModuleLoader=true`, mirroring the
  existing `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE=true` pattern-reload job. The
  verifier **parity oracle** (below) runs here.
- **Keep the ESM path additive.** Minimize edits to shared code (CF transformer
  pipeline, source-location handling, executable registry). Where a shared change
  is unavoidable it must be behaviorally identical for the AMD path, covered by
  existing AMD tests.
- **AMD removal is the one inherently un-flaggable step**, done last (Phase 5):
  flip the default (small, reversible), bake, then delete AMD and the flag. Keep
  the flag as an escape hatch for a release or two before deletion.

## Ground truth (validated against this worktree)

### The AMD verifier's guarantee (`compiled-bundle-verifier.ts`, 1797 lines)

The verifier runs at compile and again at evaluate (before any compartment
execution) via `CompiledBundleValidator.verify()`. It has two distinct layers:

1. **Structural / packaging checks** — AMD-bundle-specific. Single wrapped
   function; canonical AMD loader text (`getAMDLoader.toString()`); one `define()`
   per module with string id/deps and a direct `function` factory; mandatory
   factory shadow guards (`const define = undefined;` etc.); `require` capture;
   `bootstrap → define → tail` phase ordering; `return { main, exportMap }` tail
   grammar; "no unsupported top-level executable code". These are emit artifacts
   of the AMD packaging and **do not transfer** — they must be re-expressed for
   per-module ESM.

2. **Security classification** — the real boundary, and **largely
   format-independent**. Operating on each module's top-level items
   (`classifyExpressionText`, `verifyTrustedBuilderCall`, `verifyAuthoredFactory`),
   it enforces:
   - top-level `const` only — `let`/`var` rejected (no mutable module state);
   - each `const` initializer must be one of: a **direct function**
     (function/arrow with brace body), a **trusted-builder call**
     (`pattern`/`lift`/`handler`/`action`/`computed`) whose callback
     argument is a *direct* callback at the builder-specific arg index
     (`callbackIndexesForBuilder`), a **trusted data-helper call**
     (`__cf_data`/`schema`/`safeDateNow`/`nonPrivateRandom` with exact arity), or
     a **primitive-like** literal;
   - raw mutable literals (`{…}`/`[…]`/`/re/`/`new …`) and **IIFEs** and
     arbitrary **call results** are rejected unless wrapped in `__cf_data()`;
   - builder non-callback args must be verified plain data / safe-global refs
     (`verifyTrustedValueExpression`);
   - **default export** must be a trusted builder, direct function, verified data,
     or import re-export (not a bare untrusted import / `require` / runtime
     namespace);
   - canonical **function-hardening** (`__cfHardenFn(fn)`) and
     **binding-identity** statements recognized by byte-equality to
     `sandbox-contract.ts` sources;
   - top-level class/generator declarations rejected.

   These rules classify items into `builder | data | function | import | unknown`
   and are independent of whether the surrounding packaging is AMD or ESM. In AMD
   they read `exports.x = …`; in ESM the equivalent is `export const x = …`.

3. **Load/execute-time enforcement** (representation-independent, reused as-is):
   `assertPlainData`/`freezeVerifiedPlainData` (`plain-data.ts`) freeze `__cf_data`
   payloads; `hardenVerifiedFunction` (`function-hardening.ts`) freezes builder
   functions; the verified-function registrar; recursive freezing of forwarded
   globals (`hardening.ts`); lockdown + per-pattern compartment.

Parity oracle: `packages/runner/test/compiled-module-verifier.test.ts` (45
cases) and `bundle-preflight.test.ts` (17 cases) encode the accept/reject
*semantics*. Their security verdicts are reusable; their AMD fixtures
(`support/amd-bundles.ts`) need ESM record equivalents.

### Engine.evaluate responsibilities (AMD path)

To reproduce on the ESM path (keep = format-agnostic; replace = AMD-specific):

| Responsibility | Keep / Replace |
| --- | --- |
| `loadId` mint; `beginVerifiedLoad`; `setVerifiedLoadBundleId(hash)`; `setVerifiedLoadSources` | Keep (hash over the ESM artifact; sources normalized the same way) |
| isolate-per-load; runtime-module export *values* | Keep |
| verified-function registrar install/restore | Keep |
| source-location frame push (`sourceLocationContext.script` = bundle text) so `fn.src` resolves | **Keep — critical (see below)** |
| `captureVerifiedValue(main)`/`(exportMap)`; `exportsByValue` + `exportsCallback` | Keep |
| return `{ main, exportMap, loadId }` (PatternManager consumes `{main, loadId}`) | Keep the contract |
| sourcemap load via `SESIsolate.execute(loadSourceMap)` | Keep (ESM artifact emits a sourcemap over the same filename) |
| module kind / `outFile` AMD bundle; `bundleAMDOutput`; `getAMDLoader`; `__cfAmdHooks`; `runtimeDeps =>` invoke contract; `{main, exportMap}` synthesis via `require()`; AMD `mapModuleName` keys | **Replace** with the ESM record loader (`importModuleGraphNow`) |
| `/${id}` prefix + synthetic `/index.ts` (a workaround for AMD `outFile` prefix-flattening) | **Re-evaluate** — likely unnecessary for a real module graph, but `evaluate`'s prefix-stripping, `collectVerifiedLoadSources`, and identity source normalization all assume it, so any change is consistent across all four sites |
| CF transformer pipeline (`CommonFabricTransformerPipeline`) | Keep — confirmed module-format-agnostic; feeds ESM emit unchanged |

#### `fn.src` source locations: CFC verified-source still depends on them

`annotateFunctionDebugMetadata` → `resolveLocationFromFunctionSource` produces
`fn.src = "source:line:col"` by `script.indexOf(fn.toString())` against the
active frame's bundle text, then mapping through the sourcemap; the reload-stable
canonical form is `cf:module/<hash>/<path>:line:col`.

This **used to** feed two consumers (CFC verified-source and the scheduler
implementation fingerprint). The scheduler consumer is **gone**: scheduler action
identity — action ids and the durable implementation fingerprint — was re-rooted
onto content-addressed `{ identity, symbol }` provenance and no longer reads
`fn.src`; the `Engine.implementationHashForSource` helper was removed. See
`docs/specs/content-addressed-action-identity.md`.

The remaining consumer is **CFC verified-implementation identity**
(`cfc/implementation-identity.ts`, `resolveProvenanceImplementationIdentity`).
Its anti-spoof proof is the content-addressed provenance WeakMap
(`harness/verified-provenance.ts`) — an entry exists only for a function
registered during a verified evaluation, so the lookup itself authenticates.
`fn.src` is then read as a **fail-closed consistency check**: the canonical
source must point INTO the provenance module
(`identityFromCanonicalSource(src) === provenance.identity`), else the identity
resolves `unsupported` and the gated `writeAuthorizedBy` write is denied. (The
former `isVerifiedSourceInLoad` / `bundleId` / `verifiedLoadId` registry arm was
removed with the provenance migration — PR E2.)

So the ESM artifact the compartment evaluates **must** still (a) contain each
function's source verbatim, in emit order, so `indexOf`/`nextSearchOffset`
resolves, and (b) carry a sourcemap over the same `filename`, and (c)
`setVerifiedLoadSources` must include the normalized ESM source paths — because
CFC's consistency check fail-closes when `fn.src` does not resolve. This remains
the single most delicate integration constraint and gets its own test (`fn.src`
resolves to the canonical authored source under the ESM loader, and CFC
verified-source resolves — `test/esm-source-location.test.ts`).

## Part A — Verifier classification port

**Goal:** an ESM-record verifier with byte-for-byte equivalent *security*
verdicts to the AMD verifier, replacing only the packaging checks.

1. **Split the existing verifier** into a format-agnostic `classifyModuleItems`
   core (the security layer: const-only, initializer classification,
   `verifyTrustedBuilderCall` + `callbackIndexesForBuilder`,
   `verifyTrustedValueExpression`, data-helper arity, default-export restriction,
   function-hardening/binding-identity recognition, mutable/IIFE/call-result
   rejection) and an AMD-packaging front-end (the current parser/preflight). The
   core should consume a normalized list of top-level items + a binding `env`,
   not AMD `ParsedDefineCall`s.
2. **ESM front-end** (`module-record-verifier.ts` grows from structural-only to
   full): parse each module record's compiled body into top-level items, map
   ESM/compiled-CJS forms to the same item kinds the core expects
   (`export const x = …` ↔ `exports.x = …`; `import … from` ↔ the dependency
   `env` seeding with `trustedRuntimeName` for runtime modules; native
   `export { x } from` re-export grammar). Re-express the *intent* of the AMD
   structural rules for ESM: exactly one module unit per record; import-specifier
   allow-list (reuse `isAllowedAuthoredImportSpecifier`); no top-level executable
   statements beyond the classified items; no mutable bindings.
3. **Parse substrate — DECIDED: scan the compiled output, no AST (cost-driven).**
   The current verifier is not a TS AST parse; it is a single-pass token scanner
   (`compiled-js-parser.ts`) over the compiled bundle text, and its security
   classifier (`classifyExpressionText` et al.) operates on text ranges, not AST
   nodes. Measured cost (≈1.9 KB module): `ts.createSourceFile` ≈ 70–120 µs vs a
   single scan pass ≈ 2–5 µs — i.e. an authored-AST verify is ~15–50× the current
   per-module cost. Absolute cost is sub-ms/module and dwarfed by the compile-time
   `createProgram`, but the budget is "no more expensive than today," so the
   default is to **reuse the existing AST-free scanner classifier on the compiled
   output** (the proven path — the AMD verifier already matches compiled-emit
   canonical forms like `Object.defineProperty(exports,"__esModule"…)` /
   `__importDefault` / `__exportStar`). Only the *structural* front-end is new
   (recognize ESM/CJS module-item forms instead of `define()`).
   - **Memoize the verdict by content-addressed module hash**, so evaluate-time
     re-verify is O(1) for unchanged modules and incremental edits re-verify only
     the changed module (cheaper than the AMD whole-bundle re-verify).
   - Authored-source AST classification is the fallback *only if* compiled-output
     classification proves too messy. If taken, keep it cost-neutral: the adapter
     already does ~2–3 `createSourceFile` calls/module (`collectExportNames`,
     `extractRuntimeImports`, `transpileModule`); parse **once** and share that
     SourceFile across export-collection + import-extraction + verification — a net
     reduction — and still memoize by hash.
   - **Cost gate:** a micro-bench plus the flag-on CI lane must show ESM total
     verify cost ≤ AMD verify cost before the default flips.
4. **Wire** `verifyModuleGraph` to call `classifyModuleItems` per record and to
   refuse to run when classification is absent/failed (remove the "structural
   only" disclaimer once this lands).
5. **Parity oracle.** Port `compiled-module-verifier.test.ts`'s 45 accept/reject
   cases to ESM module fixtures and assert identical verdicts; add a differential
   test that, for a corpus of authored sources, the AMD verifier and ESM verifier
   agree (accept↔accept, reject↔reject). This is the release gate for Phase 5.

**Open questions:** how the
content-addressed identity (`__cfHardenFn`/binding-identity byte-equality) ports
when the ESM emit differs from AMD emit (the canonical helper sources may need an
ESM-emit variant); whether `export *` (Part C) needs a classification rule.

## Part B — Engine integration

1. **Compile branch** (`Engine.compile`, behind flag): emit per-module ESM
   (reuse Phase 2 `compileSourcesToRecords` but run it through the full
   `CommonFabricTransformerPipeline`, not bare `ts.transpileModule`). Produce the
   record graph + a single concatenated artifact string (for `fn.src` `indexOf`
   resolution and bundle hashing) + a sourcemap. Run the Part-A verifier.
2. **Evaluate branch** (`Engine.evaluate`, behind flag): reproduce the "keep"
   responsibilities table above; replace bundle execution with
   `importModuleGraphNow` over records whose `globals` are the frozen runtime
   exports, returning the entry namespace as `main` and building the `exportMap`
   from per-record namespaces. Preserve the source-location frame + sourcemap so
   both identity consumers work.
3. **Runtime modules** become records (`cf:runtime/<name>`) carrying the same
   frozen `runtimeExports` values, replacing AMD `define()` injection.
4. **Prefix decision:** prototype without the `/${id}` prefix and synthetic
   `/index.ts`; if `fn.src`/identity normalization can be kept stable with real
   module paths, drop the prefix on the ESM path only (AMD keeps it). Otherwise
   keep it for symmetry. Decide with a test, not by guessing.
5. **Differential test:** the same pattern loaded under AMD and under
   `esmModuleLoader=true` yields equal exports, equal `fn.src` for each action,
   equal scheduler implementation fingerprints, and a working verified-load
   identity.

## Part C — Smaller items (DONE)

- **`export *` expansion** — DONE. `collectModuleExports` returns direct names +
  `export *` targets; `compileSourcesToRecords` unions targets transitively
  (memoized, cycle-safe), excluding `default`. Multi-hop test added.
- **Live bindings** — DECIDED: keep the snapshot for v1. Exported values are
  copied onto the namespace at module-init time. A later reassignment of an
  exported `let` is not reflected as a true ESM live binding; acceptable for
  compiled patterns. Revisit (getters delegating to `finalExports`) only if a
  real pattern needs live `let` re-export semantics.
- **Benchmarks** — DONE (`packages/runner/test/esm-loader.bench.ts`): AMD bundle
  compile+evaluate vs the ESM module-record loader for a representative
  multi-file pattern. Local result: ESM ~45 ms vs AMD ~142 ms (~3.1× faster),
  reflecting per-module CommonJS + content-addressed records vs AMD bundling +
  full bundle verification. (Cold-start graph-load + first-render metrics, and a
  flag-on CI lane, belong with the eventual default-on rollout — out of scope
  while the flag stays off.)

## Part D — Phased PR sequence (each green, behind the flag)

1. **Verifier core split** — extract `classifyModuleItems` from the AMD verifier
   with no behavior change; existing AMD tests stay green. (Pure refactor.)
2. **ESM verifier + parity oracle** — ESM front-end calling the core; port the
   45+17 cases to ESM fixtures; differential AMD/ESM agreement test. Flag still
   off in production.
3. **Engine compile/evaluate ESM branch** — behind the flag; the differential
   load test; add the flag-on CI lane.
4. **`export *`, live-binding decision, benchmarks.**
5. **Phase 5 rollout** — flip `esmModuleLoader` default on (reversible); bake;
   then delete the AMD bundler/loader/verifier-packaging and the flag.

## Risks

- **Verifier parity is security-critical.** A missed classification = sandbox
  escape. Mitigation: the differential oracle is a hard release gate; do not flip
  the default until AMD and ESM verdicts match across the corpus.
- **`fn.src` resolution under ESM — KNOWN GAP (remaining before default-on).**
  The ESM evaluate path loads each module via a bare `compartment.evaluate`; SES
  `errorTaming` strips the `//# sourceURL` from stack traces, so `fn.src` does
  not resolve and both identity consumers (scheduler implementation hash, CFC
  verified-source) degrade gracefully (fall back / telemetry id) rather than
  fail — patterns still compile, load, and run correctly. Full fidelity needs
  SES-isolate-level source-map integration (load per-module maps + map eval
  positions), the design's highest-risk piece. The record `sourceURL` tag and
  `registerModuleHashes` wiring are in place as hooks; this is the last item to
  close before the flag can be enabled by default. It does not block the
  flag-off, manual-testing milestone.
- **Shared-code drift.** Any edit to the transformer pipeline or source-location
  code risks the AMD path. Mitigation: keep ESM additive; rely on existing AMD
  tests as the regression guard.
- **CI cost of the flag-on lane.** Bounded by scoping it to the suites that
  exercise loading, as the persistent-scheduler reload job does.
