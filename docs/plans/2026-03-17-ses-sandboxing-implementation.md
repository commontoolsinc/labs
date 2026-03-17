# SES Sandboxing Implementation Plan

> **For agentic workers:** REQUIRED: Use trycycle-executing to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current `UnsafeEval`-based authored-pattern execution path with a single verified SES runtime that preserves valid pattern behavior, rejects unsafe module-load code before execution, keeps one Compartment per loaded pattern, and preserves mapped authored stack traces.

**Architecture:** Keep the existing TypeScript-to-AMD pipeline and `runtimeDeps` ABI, but add a dedicated SES-oriented transformer pass that emits a tiny canonical wrapper language plus hoists only post-closure-lowered callbacks that still depend on imports or module scope. On the runner side, add a new `packages/runner/src/sandbox/` subsystem that preflights bundles, verifies AMD factories with a minimal recognizer, executes verified bundles in SES Compartments, records verified function references, and feeds the runner frozen function objects rather than raw source strings. Preserve the current `Engine` / `PatternManager` surface where possible, but remove authored `eval` fallback from the runtime path entirely.

**Tech Stack:** TypeScript AST transforms, `@commontools/js-compiler` AMD bundling, SES Compartments (`npm:ses`), Deno test, existing runner and generated-pattern integration harnesses.

---

## Scope And Locked Decisions

This plan implements the final steady-state architecture directly. Do not add an interim “SES plus legacy fallback” mode for authored pattern execution.

Locked decisions from the spec and user discussion:

- The trust boundary is verified module-load state plus each callback invocation, not “the pattern” as a unit.
- One verified SES runtime path only. No authored raw-string `eval` fallback.
- One Compartment per loaded pattern for containment; verification remains primary.
- Dynamic `import()` is rejected in v1.
- Ambient authored globals are minimal: SES intrinsics, sandboxed `console`, `harden`, and internal wrapper helpers only.
- Common Tools capabilities continue to flow through trusted AMD runtime modules via `runtimeDeps`.
- Top-level non-builder values must be a versioned inert subset of `StorableValue`; v1 allows only `null`, `undefined`, `boolean`, `number`, `string`, `bigint`, arrays, and plain records.
- `console` is the only tolerated authored module-load side effect.
- The compiler may help, but the runtime verifier must be able to reject incorrect or malicious compiler output.

## Critical Contracts And Invariants

These are implementation invariants, not aspirational guidance. Every task below should preserve them.

1. **No authored code runs before bundle preflight passes.**
   The runtime must validate the outer AMD bundle shape before any `compartment.evaluate(...)`.

2. **No AMD factory executes before module verification passes.**
   Registering a module factory is allowed after bundle preflight; executing a factory is not.

3. **The verifier is fail-closed against a tiny emitted grammar.**
   If the emitted JS deviates from the canonical wrapper language, reject the module. Do not “best effort” parse arbitrary JS.

4. **All surviving top-level authored bindings are one of:**
   - trusted builder wrapper
   - direct top-level function wrapper
   - data-safe function wrapper
   - verified plain-data wrapper
   - normalized import/export/type scaffolding

5. **No authored runtime path depends on `module.implementation` string source.**
   Live pattern/module objects must carry function objects and stable verified implementation IDs. Stringified authored code is allowed only as inert display/debug metadata, not as executable input.

6. **Pattern/module serialization must not silently reintroduce eval.**
   If a serialized pattern/module crosses a persistence boundary, it must either:
   - retain enough verified reference metadata to rebind to frozen functions, or
   - be recompiled from source before execution.
   Do not leave a path that “works” only by calling `eval` on stored source strings.

7. **Mapped stack traces remain a release-blocking requirement.**
   SES cutover is not complete unless stack traces for lift/handler/pattern failures still point to authored files and lines.

8. **Valid existing patterns keep their observable behavior.**
   The generated-pattern integration harness and runner tests are the primary evidence here, not unit tests that only validate internal bookkeeping.

## Canonical Wrapper ABI

Use these exact helper names so the transformer, verifier, and runtime share one contract:

- `__ct_builder(kind, itemId, callback)`
- `__ct_fn(itemId, fn)`
- `__ct_pure_fn(itemId, captureIds, fn)`
- `__ct_data(itemId, captureIds, value)`

Use these exact wrapper classes:

- `kind` is one of `"pattern"`, `"recipe"`, `"lift"`, `"handler"`.
- `itemId` is a stable per-module identifier derived from module path + top-level ordinal + local name.
- `captureIds` is an emitted manifest of previously approved top-level bindings used by `__ct_pure_fn(...)` or `__ct_data(...)`.

Emit a stable sentinel comment immediately before each surviving top-level item:

```js
/*__CT_TOPLEVEL__:main.tsx:003:myLift:builder*/
const myLift = __ct_builder("lift", "main.tsx#003:myLift", function (input) {
  return transform(input);
});
```

The verifier may rely on these sentinels for fast top-level splitting, but it must still reject malformed delimiter structure or wrapper forms.

## Verified Implementation Reference Contract

The current runtime stores authored JavaScript module bodies as strings in `module.implementation` and later rehydrates them with `getInvocation()`. That must be removed.

Adopt this steady-state contract:

- Live `javascript` modules carry a real function object in `module.implementation`.
- Live `javascript` modules also carry `module.implementationRef`, a stable verified ID produced during module load.
- `__ct_builder(...)`, `__ct_fn(...)`, and `__ct_pure_fn(...)` tag returned functions with the same `implementationRef` metadata.
- `createNodeFactory()` / `handlerInternal()` copy the function tag onto the produced `Module`.
- `moduleToJSON()` serializes `implementationRef` and preview/location metadata for authored JavaScript modules; it does **not** stringify authored code for later execution.
- The runner resolves `implementationRef` through the SES sandbox’s verified-function registry whenever it receives a serialized JavaScript module without a live function object.

This is the cutover that actually removes authored string-eval. Do not leave it for a later cleanup.

## Pipeline Ordering

Implement the transformer/runtime pipeline in this order:

1. Existing validation passes
2. Existing `computed()` rewrite and closure lowering
3. **New SES module-scope canonicalization/hoisting pass**
4. Existing capability/schema passes
5. TypeScript emit to AMD bundle
6. Bundle preflight
7. AMD factory verification
8. SES Compartment evaluation + function/data hardening
9. Runner execution using verified function refs

The new SES transformer must run after closure lowering, because the hoisting criterion is based on what references remain **after** existing closure extraction, not on the authored callback text.

## File Map

Create or modify the following files. Keep responsibilities tight; do not hide the verifier, Compartment lifecycle, and runner cutover inside one giant file.

### Compiler / transformer

- Modify: `packages/ts-transformers/src/ct-pipeline.ts`
  Insert the SES module-scope pass after closure lowering and before later schema/capability passes.
- Create: `packages/ts-transformers/src/transformers/ses-module-scope.ts`
  Canonicalize top-level wrappers, emit sentinels, and perform post-closure-lowering hoist decisions.
- Create: `packages/ts-transformers/src/transformers/ses-wrapper-helpers.ts`
  Shared helper builders for wrapper calls, item IDs, sentinel comments, and metadata emission.
- Modify: `packages/ts-transformers/src/closures/strategies/derive-strategy.ts`
  Preserve/annotate enough post-transform structure for SES hoist decisions and source-map fidelity.
- Modify: `packages/ts-transformers/src/closures/strategies/action-strategy.ts`
  Same as above for action-to-handler lowering.
- Modify: `packages/ts-transformers/src/transformers/pattern-context-validation.ts`
  Align diagnostics with the stricter SES placement/direct-callback rules.
- Create: `packages/ts-transformers/test/ses-module-scope.test.ts`
  Focused assertions for wrappers, sentinels, hoist criteria, and direct-callback normalization.
- Modify: `packages/ts-transformers/test/validation.test.ts`
  Cover rejected placements and direct-callback violations.
- Modify or create fixture files under `packages/ts-transformers/test/fixtures/`
  Add stable golden coverage for canonical wrapper output and hoisting.

### JS compiler / bundling

- Modify: `packages/js-compiler/typescript/bundler/bundle.ts`
  Emit explicit trusted source-region markers and pass internal AMD hooks into the loader without changing the external bundle ABI.
- Modify: `packages/js-compiler/typescript/bundler/amd-loader.ts`
  Accept internal hooks for `define()` / `require()` verification boundaries.
- Modify: `packages/js-compiler/typescript/compiler.ts`
  Preserve transformed source output/goldens and keep source-map chaining correct after wrapper insertion and hoisting.
- Modify: `packages/js-compiler/test/source-map.test.ts`
  Add wrapper/hoist-aware mapping assertions.

### Runner sandbox subsystem

- Create: `packages/runner/src/sandbox/types.ts`
  Public sandbox interfaces and branded metadata types.
- Create: `packages/runner/src/sandbox/token-scanner.ts`
  Minimal delimiter-aware scanner used by preflight and module verification.
- Create: `packages/runner/src/sandbox/bundle-preflight.ts`
  Trusted outer-wrapper validation before any SES evaluation.
- Create: `packages/runner/src/sandbox/module-verifier.ts`
  Canonical wrapper recognizer for AMD factory bodies, import policy, dynamic-import rejection, and capture-manifest enforcement.
- Create: `packages/runner/src/sandbox/plain-data.ts`
  Descriptor-safe `assertPlainData()` / `freezeVerifiedPlainData()` against the v1 `StorableValue` subset.
- Create: `packages/runner/src/sandbox/runtime-helpers.ts`
  Runtime implementations of `__ct_builder`, `__ct_fn`, `__ct_pure_fn`, `__ct_data`, metadata tagging, and immediate hardening.
- Create: `packages/runner/src/sandbox/compartment-globals.ts`
  Minimal ambient global surface for Compartments.
- Create: `packages/runner/src/sandbox/runtime-modules.ts`
  Trusted `runtimeDeps` provider migrated from the current harness surface.
- Create: `packages/runner/src/sandbox/ses-runtime.ts`
  Lockdown singleton, per-pattern Compartment lifecycle, verified bundle evaluation, verified-function registry, and source-map registration.
- Create: `packages/runner/src/sandbox/error-mapping.ts`
  Source-map loading, stack parsing, and mapped-error objects around `SourceMapParser`.
- Create: `packages/runner/src/sandbox/execution-wrapper.ts`
  Sync/async wrappers that preserve security errors and wrap authored failures consistently.
- Create: `packages/runner/src/sandbox/frame-classifier.ts`
  Pattern/runtime/external/SES frame classification and filtering.
- Create: `packages/runner/src/sandbox/error-display.ts`
  User-facing formatting and structured reports.
- Create: `packages/runner/src/sandbox/mod.ts`
  Stable exports for the new subsystem.

### Harness / runner / builder cutover

- Modify: `packages/runner/src/harness/engine.ts`
  Compile as today, evaluate through `ses-runtime`, and expose source-map/error hooks without `UnsafeEvalRuntime`.
- Modify: `packages/runner/src/harness/types.ts`
  Remove authored `getInvocation()` dependency from the harness contract.
- Modify: `packages/runner/src/harness/runtime-modules.ts`
  Re-export or delegate to the sandbox runtime-module provider for compatibility.
- Modify: `packages/runner/src/harness/index.ts`
  Export the updated engine surface.
- Modify: `packages/runner/src/runner.ts`
  Resolve verified implementation refs instead of evaluating module strings.
- Modify: `packages/runner/src/pattern-manager.ts`
  Ensure compile/evaluate/load paths keep verified refs and reuse per-pattern sandbox state correctly.
- Modify: `packages/runner/src/runtime.ts`
  Initialize and dispose the sandbox runtime cleanly.
- Modify: `packages/runner/src/scheduler.ts`
  Route surfaced authored errors through sandbox error mapping/formatting.
- Modify: `packages/runner/src/builder/types.ts`
  Add `implementationRef` metadata on `Module` and any branded function metadata types needed by the runner.
- Modify: `packages/runner/src/builder/module.ts`
  Preserve live function objects, copy verified IDs onto modules, and stop depending on runtime string rehydration.
- Modify: `packages/runner/src/builder/pattern.ts`
  Keep live nodes/modules for runtime execution while preserving explicit serialization behavior.
- Modify: `packages/runner/src/builder/json-utils.ts`
  Serialize authored JavaScript modules by verified ref/preview metadata, not raw executable source.

### Tests

- Create: `packages/runner/test/sandbox/bundle-preflight.test.ts`
- Create: `packages/runner/test/sandbox/plain-data.test.ts`
- Create: `packages/runner/test/sandbox/security.test.ts`
- Create: `packages/runner/test/sandbox/compartment.test.ts`
- Modify: `packages/runner/test/pattern-manager.test.ts`
- Modify: `packages/runner/test/stack-trace.test.ts`
- Modify: `packages/runner/test/stack-trace-patterns.test.ts`
- Create: `packages/generated-patterns/integration/patterns/ses-sandbox-smoke.test.ts`
- Modify: `packages/shell/test/error-ipc.test.ts` if the formatted error payload changes

## Task Breakdown

### Task 1: Add SES Module-Scope Canonicalization And Hoisting

**Files:**
- Create: `packages/ts-transformers/src/transformers/ses-module-scope.ts`
- Create: `packages/ts-transformers/src/transformers/ses-wrapper-helpers.ts`
- Modify: `packages/ts-transformers/src/ct-pipeline.ts`
- Modify: `packages/ts-transformers/src/closures/strategies/derive-strategy.ts`
- Modify: `packages/ts-transformers/src/closures/strategies/action-strategy.ts`
- Modify: `packages/ts-transformers/src/transformers/pattern-context-validation.ts`
- Test: `packages/ts-transformers/test/ses-module-scope.test.ts`
- Test: `packages/ts-transformers/test/validation.test.ts`
- Test: fixture files under `packages/ts-transformers/test/fixtures/`

- [ ] **Step 1: Write the failing transformer tests for canonical wrappers and hoisting**

Add focused tests that cover:
- top-level builder wrappers emitted as `__ct_builder(...)`
- top-level helpers emitted as `__ct_fn(...)`
- data-safe helpers emitted as `__ct_pure_fn(...)`
- data initializers emitted as `__ct_data(...)`
- `derive(...)`/`computed(...)` hoisting to `lift(...)` only when post-closure-lowering external references remain
- `action(...)` hoisting to `handler(...)` only when post-closure-lowering external references remain
- `patternTool(...)` / `*WithPattern(...)` staying inline

- [ ] **Step 2: Run the transformer tests to verify they fail**

Run:

```bash
deno test --allow-read --allow-write --allow-env \
  packages/ts-transformers/test/ses-module-scope.test.ts \
  packages/ts-transformers/test/validation.test.ts
```

Expected: FAIL because the canonical wrapper pass and hoist logic do not exist yet.

- [ ] **Step 3: Implement the new SES module-scope transformer**

Implement:
- stable top-level item IDs
- sentinel comments
- exact wrapper call emission
- hoist criteria based on remaining free vars/import/module refs after closure lowering
- normalization of top-level functions into wrapped `const` assignments
- normalization of exports to local bindings plus simple export wiring

Do **not** make the verifier responsible for understanding arbitrary author syntax. The transformer’s job is to collapse the authored surface into the tiny emitted grammar.

- [ ] **Step 4: Insert the pass at the correct pipeline point**

Wire the new pass into `CommonToolsTransformerPipeline` after closure lowering and before later capability/schema passes so:
- closure extraction has already happened
- hoisted builders still receive later schema/capability annotations
- source maps still chain through one normal emit path

- [ ] **Step 5: Tighten diagnostics around placement/direct-callback rules**

Extend validation so authored code gets clear compile-time diagnostics for:
- inline `lift()` / `handler()` placement
- non-direct builder callbacks
- disallowed top-level forms that cannot be canonicalized

- [ ] **Step 6: Re-run the targeted tests and then the full transformer suite**

Run:

```bash
deno test --allow-read --allow-write --allow-env \
  packages/ts-transformers/test/ses-module-scope.test.ts \
  packages/ts-transformers/test/validation.test.ts
deno task --cwd packages/ts-transformers test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/ts-transformers/src/ct-pipeline.ts \
  packages/ts-transformers/src/closures/strategies/derive-strategy.ts \
  packages/ts-transformers/src/closures/strategies/action-strategy.ts \
  packages/ts-transformers/src/transformers/pattern-context-validation.ts \
  packages/ts-transformers/src/transformers/ses-module-scope.ts \
  packages/ts-transformers/src/transformers/ses-wrapper-helpers.ts \
  packages/ts-transformers/test/ses-module-scope.test.ts \
  packages/ts-transformers/test/validation.test.ts \
  packages/ts-transformers/test/fixtures
git commit -m "feat: canonicalize SES module scope output"
```

### Task 2: Add Trusted Bundle Preflight And AMD Verification Hooks

**Files:**
- Modify: `packages/js-compiler/typescript/bundler/bundle.ts`
- Modify: `packages/js-compiler/typescript/bundler/amd-loader.ts`
- Modify: `packages/js-compiler/typescript/compiler.ts`
- Create: `packages/runner/src/sandbox/token-scanner.ts`
- Create: `packages/runner/src/sandbox/bundle-preflight.ts`
- Create: `packages/runner/src/sandbox/module-verifier.ts`
- Test: `packages/runner/test/sandbox/bundle-preflight.test.ts`
- Test: `packages/js-compiler/test/source-map.test.ts`

- [ ] **Step 1: Write failing bundle-preflight and module-verifier tests**

Cover:
- rejection of statements outside top-level `define(...)` calls
- rejection of malformed bundle pre/post scaffolding
- rejection of dynamic `import()`
- rejection of non-trusted static imports
- rejection of malformed wrapper forms
- acceptance of valid canonicalized module factories

- [ ] **Step 2: Run the new tests to verify they fail**

Run:

```bash
ENV=test deno test --allow-ffi --allow-env --allow-read \
  --allow-write=/tmp,/var/folders --allow-run=git \
  packages/runner/test/sandbox/bundle-preflight.test.ts
```

Expected: FAIL because no bundle preflight or module verifier exists.

- [ ] **Step 3: Update the bundler to expose stable verification boundaries**

Change `bundle.ts` and `amd-loader.ts` so the trusted runtime can:
- identify the exact untrusted source region
- compare the trusted outer wrapper shape against expected boilerplate
- pass internal AMD hooks (`__ctAmdHooks`) into the loader without changing the external `runtimeDeps` ABI

Keep the public bundle contract the same:

```ts
(runtimeDeps?: Record<string, unknown>) => { main, exportMap }
```

- [ ] **Step 4: Implement the trusted scanner and verifier**

`token-scanner.ts` should do only balanced-delimiter and literal/comment skipping.

`bundle-preflight.ts` should:
- verify exact trusted prefix/suffix structure
- isolate the untrusted source region
- ensure it contains only top-level `define(...)` registrations

`module-verifier.ts` should:
- verify AMD dependency policy
- verify canonical wrappers and sentinels
- enforce direct callback / direct function / data-safe helper / plain-data forms
- reject `import()`
- maintain a top-level approved-binding table as it walks the module body

- [ ] **Step 5: Keep source maps intact through the bundler change**

Update js-compiler tests so wrapper markers and AMD hook injection do not break line/column mapping back to authored code.

- [ ] **Step 6: Re-run targeted tests and the js-compiler suite**

Run:

```bash
ENV=test deno test --allow-ffi --allow-env --allow-read \
  --allow-write=/tmp,/var/folders --allow-run=git \
  packages/runner/test/sandbox/bundle-preflight.test.ts
deno test --allow-read --allow-write --allow-run \
  --allow-env=UPDATE_GOLDENS,API_URL,TSC_*,NODE_INSPECTOR_IPC,VSCODE_INSPECTOR_OPTIONS,NODE_ENV \
  packages/js-compiler/test/source-map.test.ts
deno task --cwd packages/js-compiler test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/js-compiler/typescript/bundler/bundle.ts \
  packages/js-compiler/typescript/bundler/amd-loader.ts \
  packages/js-compiler/typescript/compiler.ts \
  packages/js-compiler/test/source-map.test.ts \
  packages/runner/src/sandbox/token-scanner.ts \
  packages/runner/src/sandbox/bundle-preflight.ts \
  packages/runner/src/sandbox/module-verifier.ts \
  packages/runner/test/sandbox/bundle-preflight.test.ts
git commit -m "feat: verify SES bundles before execution"
```

### Task 3: Implement Plain-Data Validation And Runtime Wrapper Helpers

**Files:**
- Create: `packages/runner/src/sandbox/plain-data.ts`
- Create: `packages/runner/src/sandbox/runtime-helpers.ts`
- Create: `packages/runner/src/sandbox/types.ts`
- Create: `packages/runner/src/sandbox/mod.ts`
- Modify: `packages/runner/src/builder/types.ts`
- Test: `packages/runner/test/sandbox/plain-data.test.ts`
- Test: `packages/runner/test/sandbox/security.test.ts`

- [ ] **Step 1: Write failing plain-data and helper tests**

Cover:
- allowed v1 values, including `bigint`
- rejection of accessors without invoking getters
- rejection of symbol keys, custom prototypes, sparse arrays, cycles, reserved keys
- rejection of `Map`, `Set`, `Date`, `Promise`, `Error`, functions, proxies
- helper tagging/hardening behavior for `__ct_builder`, `__ct_fn`, `__ct_pure_fn`, `__ct_data`

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
ENV=test deno test --allow-ffi --allow-env --allow-read \
  --allow-write=/tmp,/var/folders --allow-run=git \
  packages/runner/test/sandbox/plain-data.test.ts \
  packages/runner/test/sandbox/security.test.ts
```

Expected: FAIL because the plain-data validator and wrapper helpers do not exist yet.

- [ ] **Step 3: Implement descriptor-safe plain-data validation**

`plain-data.ts` must:
- walk arrays/objects without triggering getters
- track visited objects and reject cycles in v1
- enforce exact prototype/key rules
- explicitly pin the allowed subset instead of delegating to all of `StorableValue`

Keep the validator versioned in code so future widening is explicit.

- [ ] **Step 4: Implement runtime wrapper helpers**

`runtime-helpers.ts` should:
- tag returned functions/data with stable metadata
- immediately `harden()` approved functions/data
- copy `implementationRef` metadata onto returned builder/module functions
- reject misuse eagerly in helper code where cheap and reliable

Keep the true security decision in the verifier, not in the helper runtime behavior.

- [ ] **Step 5: Plumb metadata types into builder/module definitions**

Extend `Module` typing with `implementationRef` and any branded helper metadata needed by:
- `createNodeFactory()`
- `handlerInternal()`
- runner lookup

- [ ] **Step 6: Re-run targeted sandbox tests**

Run:

```bash
ENV=test deno test --allow-ffi --allow-env --allow-read \
  --allow-write=/tmp,/var/folders --allow-run=git \
  packages/runner/test/sandbox/plain-data.test.ts \
  packages/runner/test/sandbox/security.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/runner/src/sandbox/types.ts \
  packages/runner/src/sandbox/plain-data.ts \
  packages/runner/src/sandbox/runtime-helpers.ts \
  packages/runner/src/sandbox/mod.ts \
  packages/runner/src/builder/types.ts \
  packages/runner/test/sandbox/plain-data.test.ts \
  packages/runner/test/sandbox/security.test.ts
git commit -m "feat: add SES plain-data validation helpers"
```

### Task 4: Build The SES Runtime, Compartment Lifecycle, And Trusted Runtime Modules

**Files:**
- Create: `packages/runner/src/sandbox/compartment-globals.ts`
- Create: `packages/runner/src/sandbox/runtime-modules.ts`
- Create: `packages/runner/src/sandbox/ses-runtime.ts`
- Modify: `packages/runner/src/harness/runtime-modules.ts`
- Modify: `packages/runner/src/runtime.ts`
- Test: `packages/runner/test/sandbox/compartment.test.ts`
- Test: `packages/runner/test/sandbox/security.test.ts`

- [ ] **Step 1: Write failing runtime/compartment tests**

Cover:
- lockdown applied once
- one Compartment reused per loaded pattern
- different patterns get different Compartments
- minimal globals only
- trusted runtime modules available through `runtimeDeps`
- no ambient `fetch`, `Temporal`, randomness, or host objects at module load

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
ENV=test deno test --allow-ffi --allow-env --allow-read \
  --allow-write=/tmp,/var/folders --allow-run=git \
  packages/runner/test/sandbox/compartment.test.ts \
  packages/runner/test/sandbox/security.test.ts
```

Expected: FAIL because the SES runtime path does not exist yet.

- [ ] **Step 3: Implement the SES runtime subsystem**

`ses-runtime.ts` should:
- own lockdown initialization
- construct pattern-scoped Compartments
- call bundle preflight before `compartment.evaluate(...)`
- feed `__ctAmdHooks`, runtime helper bindings, and trusted runtime modules into the execution path
- maintain a verified-function registry and export registry keyed by pattern ID and `implementationRef`
- register source maps for later stack mapping

- [ ] **Step 4: Migrate runtime modules to the sandbox subsystem**

Move the trusted runtime-module surface out of `harness/runtime-modules.ts` into `sandbox/runtime-modules.ts`, then keep the harness file as a compatibility shim or re-export.

Do not broaden the capability surface during the move.

- [ ] **Step 5: Wire the runtime lifecycle into `Runtime`**

Initialize the SES runtime once per `Runtime` instance and dispose it cleanly so source maps, Compartments, and registries do not leak across tests or long-lived processes.

- [ ] **Step 6: Re-run targeted tests**

Run:

```bash
ENV=test deno test --allow-ffi --allow-env --allow-read \
  --allow-write=/tmp,/var/folders --allow-run=git \
  packages/runner/test/sandbox/compartment.test.ts \
  packages/runner/test/sandbox/security.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/runner/src/sandbox/compartment-globals.ts \
  packages/runner/src/sandbox/runtime-modules.ts \
  packages/runner/src/sandbox/ses-runtime.ts \
  packages/runner/src/harness/runtime-modules.ts \
  packages/runner/src/runtime.ts \
  packages/runner/test/sandbox/compartment.test.ts \
  packages/runner/test/sandbox/security.test.ts
git commit -m "feat: add SES runtime and pattern compartments"
```

### Task 5: Cut The Harness, Pattern Manager, Builder, And Runner Over To Verified Function Refs

**Files:**
- Modify: `packages/runner/src/harness/types.ts`
- Modify: `packages/runner/src/harness/engine.ts`
- Modify: `packages/runner/src/harness/index.ts`
- Modify: `packages/runner/src/runner.ts`
- Modify: `packages/runner/src/pattern-manager.ts`
- Modify: `packages/runner/src/builder/module.ts`
- Modify: `packages/runner/src/builder/pattern.ts`
- Modify: `packages/runner/src/builder/json-utils.ts`
- Test: `packages/runner/test/pattern-manager.test.ts`
- Test: `packages/runner/test/runtime.test.ts`
- Test: `packages/runner/test/sandbox/security.test.ts`

- [ ] **Step 1: Write failing cutover tests**

Cover:
- compiled patterns execute without calling `getInvocation()`
- live pattern nodes retain function objects plus `implementationRef`
- serialized JavaScript modules carry `implementationRef` metadata instead of authored source strings
- saved/reloaded patterns still execute after recompilation + verified ref rebinding
- nested/passed-through patterns keep working

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
ENV=test deno test --allow-ffi --allow-env --allow-read \
  --allow-write=/tmp,/var/folders --allow-run=git \
  packages/runner/test/pattern-manager.test.ts \
  packages/runner/test/runtime.test.ts \
  packages/runner/test/sandbox/security.test.ts
```

Expected: FAIL because the runtime still depends on `module.implementation` strings and `getInvocation()`.

- [ ] **Step 3: Remove authored `getInvocation()` from the main runtime contract**

Update `Harness` and `Engine` so authored pattern execution flows only through:
- compile
- verified SES evaluate/load
- direct invocation of frozen function objects

If a trusted internal eval helper still needs to exist, move it behind the sandbox subsystem and keep it out of authored code paths.

- [ ] **Step 4: Keep live functions in module/pattern objects**

Change builder/pattern construction so:
- live runtime objects retain function implementations
- `implementationRef` metadata is copied onto modules
- `toJSON()` remains explicit and separate from the live execution representation

Do **not** eagerly stringify authored functions into `pattern.nodes`.

- [ ] **Step 5: Switch runner execution to verified function resolution**

In `instantiateJavaScriptNode()`:
- if `module.implementation` is a function, assert/accept it
- otherwise resolve `module.implementationRef` through the sandbox registry
- reject authored strings outright when sandboxing is enabled

This is the actual removal of the eval escape hatch. Treat it as a release-blocking change.

- [ ] **Step 6: Re-run targeted runner tests**

Run:

```bash
ENV=test deno test --allow-ffi --allow-env --allow-read \
  --allow-write=/tmp,/var/folders --allow-run=git \
  packages/runner/test/pattern-manager.test.ts \
  packages/runner/test/runtime.test.ts \
  packages/runner/test/sandbox/security.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/runner/src/harness/types.ts \
  packages/runner/src/harness/engine.ts \
  packages/runner/src/harness/index.ts \
  packages/runner/src/runner.ts \
  packages/runner/src/pattern-manager.ts \
  packages/runner/src/builder/module.ts \
  packages/runner/src/builder/pattern.ts \
  packages/runner/src/builder/json-utils.ts \
  packages/runner/test/pattern-manager.test.ts \
  packages/runner/test/runtime.test.ts \
  packages/runner/test/sandbox/security.test.ts
git commit -m "feat: replace authored eval with verified function refs"
```

### Task 6: Restore Error Mapping, Stack Filtering, And User-Facing Error Surfaces On The SES Path

**Files:**
- Create: `packages/runner/src/sandbox/error-mapping.ts`
- Create: `packages/runner/src/sandbox/execution-wrapper.ts`
- Create: `packages/runner/src/sandbox/frame-classifier.ts`
- Create: `packages/runner/src/sandbox/error-display.ts`
- Modify: `packages/runner/src/scheduler.ts`
- Modify: `packages/runner/test/stack-trace.test.ts`
- Modify: `packages/runner/test/stack-trace-patterns.test.ts`
- Modify: `packages/shell/test/error-ipc.test.ts`

- [ ] **Step 1: Write or update failing stack/error tests**

Cover:
- top-level errors still map to authored files/lines
- lift/handler runtime errors still map correctly after SES cutover
- filtered stacks hide SES/internal noise by default
- debug mode can still show runtime frames
- shell IPC receives the updated structured error payload if formatting changes

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
ENV=test deno test --allow-ffi --allow-env --allow-read \
  --allow-write=/tmp,/var/folders --allow-run=git \
  packages/runner/test/stack-trace.test.ts \
  packages/runner/test/stack-trace-patterns.test.ts
deno test packages/shell/test/error-ipc.test.ts
```

Expected: FAIL because the current stack/error path is tied to `UnsafeEvalRuntime`.

- [ ] **Step 3: Implement sandbox error mapping and execution wrappers**

Build synchronous source-map loading/parsing around `SourceMapParser`, then wrap sync/async authored callbacks so:
- security errors pass through unchanged
- authored failures carry `patternId`, function name, mapped location, and filtered stack

- [ ] **Step 4: Wire scheduler/runtime surfaces to the new mapper**

Replace the old parse-stack dependency with the sandbox error path in the places where authored errors become user-visible.

- [ ] **Step 5: Re-run targeted stack/error tests**

Run:

```bash
ENV=test deno test --allow-ffi --allow-env --allow-read \
  --allow-write=/tmp,/var/folders --allow-run=git \
  packages/runner/test/stack-trace.test.ts \
  packages/runner/test/stack-trace-patterns.test.ts
deno test packages/shell/test/error-ipc.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/runner/src/sandbox/error-mapping.ts \
  packages/runner/src/sandbox/execution-wrapper.ts \
  packages/runner/src/sandbox/frame-classifier.ts \
  packages/runner/src/sandbox/error-display.ts \
  packages/runner/src/scheduler.ts \
  packages/runner/test/stack-trace.test.ts \
  packages/runner/test/stack-trace-patterns.test.ts \
  packages/shell/test/error-ipc.test.ts
git commit -m "feat: restore mapped stack traces for SES runtime"
```

### Task 7: Add End-To-End Security Coverage And Final Regression Pass

**Files:**
- Create: `packages/generated-patterns/integration/patterns/ses-sandbox-smoke.test.ts`
- Modify: `packages/generated-patterns/integration/pattern-harness.ts` only if additional assertion helpers are truly needed
- Test: existing generated-pattern scenarios

- [ ] **Step 1: Add the missing high-value integration scenario**

Create one generated-pattern integration scenario that exercises:
- module-scope hoisted lift
- handler hoist/binding
- local inline derive that stays inline
- preserved author-visible behavior across event updates

Keep it about observable behavior, not sandbox internals.

- [ ] **Step 2: Run the curated regression checks**

Run:

```bash
LOG_LEVEL=warn deno test --trace-leaks -A \
  packages/generated-patterns/integration/patterns/counter-handler-spawn.test.ts \
  packages/generated-patterns/integration/patterns/ses-sandbox-smoke.test.ts
ENV=test deno test --allow-ffi --allow-env --allow-read \
  --allow-write=/tmp,/var/folders --allow-run=git \
  packages/runner/test/sandbox/*.test.ts \
  packages/runner/test/pattern-manager.test.ts \
  packages/runner/test/stack-trace.test.ts \
  packages/runner/test/stack-trace-patterns.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the package-level suites that must stay green**

Run:

```bash
deno task --cwd packages/ts-transformers test
deno task --cwd packages/js-compiler test
deno task --cwd packages/runner test
deno task --cwd packages/generated-patterns integration
deno task --cwd packages/shell test
```

Expected: PASS.

- [ ] **Step 4: Remove dead legacy eval usage if any remains**

Search for and eliminate authored-path references to:
- `UnsafeEvalRuntime`
- `UnsafeEvalIsolate`
- `getInvocation()`
- `module.implementation` string execution

If a trusted internal helper still exists for tooling/tests, rename it so it is clearly non-author-path.

- [ ] **Step 5: Commit**

```bash
git add packages/generated-patterns/integration/patterns/ses-sandbox-smoke.test.ts \
  packages/generated-patterns/integration/pattern-harness.ts \
  packages/runner/src \
  packages/runner/test \
  packages/ts-transformers \
  packages/js-compiler \
  packages/shell/test/error-ipc.test.ts
git commit -m "feat: land verified SES sandbox runtime"
```

## Final Verification Checklist

Before declaring the implementation done, verify all of the following:

- [ ] No authored bundle reaches `compartment.evaluate(...)` before bundle preflight.
- [ ] No authored module factory reaches execution before verifier approval.
- [ ] `import()` is rejected in v1.
- [ ] Ambient authored globals do not include `fetch`, `Temporal`, randomness helpers, or other host-effectful objects.
- [ ] `__ct_data(...)` rejects getters, symbol keys, custom prototypes, sparse arrays, cycles, reserved keys, and non-v1 `StorableValue` members.
- [ ] `pattern()` / `recipe()` still run at module load with only the allowed authority surface.
- [ ] Runner execution never evaluates authored function source strings.
- [ ] One Compartment is reused per loaded pattern, and different patterns do not share one.
- [ ] Mapped stack traces still point to authored files/lines for top-level, lift, and handler failures.
- [ ] Existing generated-pattern behavior remains unchanged for valid patterns.

## Notes For The Implementer

- Prefer adding the new sandbox subsystem cleanly rather than entangling it with `harness/eval-runtime.ts`. The legacy eval runtime is exactly the boundary being removed.
- Do not let the verifier grow into a real JS parser. If the emitted grammar becomes hard to recognize with a delimiter scanner, simplify the emitted grammar instead.
- Keep the canonical wrapper ABI and `implementationRef` contract consistent across transformer output, runtime helper behavior, and runner lookup. Drift here is the easiest way to reintroduce unsoundness.
- When in doubt, choose explicit rejection over permissive fallback. The user wants the security model tightened, not papered over.
