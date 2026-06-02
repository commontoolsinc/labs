# Content-Addressed Module Loading — Implementation Plan

Companion to [module-loading.md](module-loading.md). That document specifies the
*what* and *why*; this one specifies the *how*: ordered, reviewable engineering
steps with the files each touches, exit criteria, and validation commands.

## Last Updated

2026-06-01

## Current status

| Phase | Status | Notes |
| --- | --- | --- |
| 0 — Loader shape confirmation | Done | SES `importNow` + virtual (third-party) module records load synchronously, incl. cycles. `ModuleSource`/`StaticModuleRecord` are not exposed by this `ses` build, so the loader uses `{ imports, exports, execute }` records. |
| 1 — Decouple identity | Done (merged) | Per-module Merkle hash; scheduler implementation fingerprint is content-addressed and entry-point/TCB independent. Shipped behind `EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE`. |
| 2 — ESM emission + SES module loading | Done (behind `CF_ESM_MODULE_LOADER`, default off) | `compileToRecordGraph` + `evaluateRecordGraph` (`engine.ts`) run the full `CommonFabricTransformerPipeline` (not bare `transpileModule`), assemble content-addressed records, register per-load/per-module source maps, and load multi-module programs end-to-end. Engine integration, `export *` re-exports, live module-namespace bindings (#3797), and CFC verified-source location resolution (#3785, #3787) are all wired. The flag is now also plumbed to the browser client (#3796). |
| 3 — Verifier port | Classification ported + wired; corpus parity oracle pending | The deep SES_SANDBOXING module-item classification (`verifyCompiledModuleBody`, reusing the shared `classifyModuleItems` core) runs **per module** in the ESM compile path (`engine.ts`). `verifyModuleGraph` validates graph shape/wiring. Additional hardening landed beyond the original plan: import-edge target validation (#3778), pattern provenance brand (#3779), frozen exported patterns (#3777). **Remaining (release gate):** the full-corpus differential parity oracle — `esm-verifier-parity.test.ts` currently covers crafted CF-shaped fixtures only, not every pattern-corpus verdict. |
| 4 — Per-module compilation cache | In-memory done; persistence pending | `ModuleRecordCache` keyed by module hash reuses the compiled artifact in memory. The ESM path in `PatternManager.compilePattern` intentionally **bypasses the persistent compilation cache**. **Remaining:** persist ESM records via the existing compilation-cache backends. |
| 5 — Default-on + AMD removal | Not started (intentionally) | Gated on the Phase 3 corpus parity oracle + a green full-suite flag-on sweep + benchmarks. The canary PR (#3782) is the standing CI signal for flag-on. The flag stays **off** by default. |

Phases 0–1 merged earlier. Phases 2–4 mechanism merged behind the default-off
flag (#3763), then substantially completed by follow-up work: ESM source-location
/ CFC verified-source identity (#3785, #3787), security hardening (#3777–#3779),
module-namespace live bindings (#3797), and client flag plumbing (#3796). The
`cfc-group-chat-demo` integration test — the original end-to-end blocker — passes
flag-on as of #3797.

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

## Phase 4 — Per-module compilation cache

> **Status: In-memory done; persistence pending.** The in-memory per-module
> record cache exists; the ESM path in `PatternManager.compilePattern`
> intentionally bypasses the persistent compilation cache. Remaining: persist
> ESM records via the existing compilation-cache backends.

- Re-key the compilation cache and the `ModuleSource` cache by `moduleHash(M)`
  instead of whole-program `computeId`
  (`packages/runner/src/compilation-cache/`).
- Editing one file invalidates only that module and its transitive importers;
  untouched modules keep their cache entries and identities.
- Carry over the compiler-version `fingerprint` and `sesValidated` gating per
  module (`compilation-cache/storage.ts`).

**Validation:** cache test asserting single-file edits invalidate exactly the
changed module + transitive importers; cold/warm compile benchmarks.
**Exit:** measured cache-hit improvement on multi-file patterns; no correctness
regression.

---

## Phase 5 — Default-on and cleanup

> **Status: Not started.** Gated on the Phase 3 corpus parity oracle, a green
> full-suite flag-on sweep (`CF_ESM_MODULE_LOADER=1 deno task test` +
> `deno task integration` from the repo root), and benchmarks. The canary
> PR (#3782) is the standing flag-on CI signal.

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

## Suggested commit/PR sequence

1. Phase 0 spike findings (notes only).
2. Phase 1.1–1.2: value-graph + Merkle hash + unit tests.
3. Phase 1.3–1.5: stable symbols + scheduler fingerprint wiring + restart test.
   *(Ships the persistent-scheduler-state fix.)*
4. Phase 2: ESM emit + loader behind flag + parity tests.
5. Phase 3: verifier port + parity harness.
6. Phase 4: per-module cache.
7. Phase 5: default-on + AMD removal.
