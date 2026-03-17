# SES Sandboxing Test Plan

The approved testing strategy still holds against the finalized implementation plan. Two plan-specific refinements are folded in here without changing scope or cost:

- The plan makes `packages/runner/deno.json` task wiring part of the acceptance contract, so this plan adds an explicit package-task coverage gate.
- The plan makes compile/evaluation-scoped `implementationRef` rebinding a core runtime contract, so this plan adds explicit save/load and serialization coverage for verified function references.

## Harness requirements

1. `packages/runner/test/support/runtime-compare.ts`
- What it does: Compiles a program once, executes it through the legacy eval helper and the new SES runtime, and compares user-visible exports, result-cell behavior, and mapped errors.
- What it exposes: Programmatic helpers for `compareExports(...)`, `comparePatternResult(...)`, and `compareMappedError(...)` using the real compiler and runner surfaces.
- Estimated complexity: Medium.
- Tests that depend on it: Tests 13 and 14.

Existing harnesses reused as-is:

- Direct API Harness: compiler, bundler, verifier, and runner APIs.
- Programmatic State Harness: `Runtime` plus `PatternManager` and result-cell assertions.
- Interaction Harness: generated-pattern integration scenarios through `pattern-harness.ts`.
- Output Capture Harness: mapped stack traces and shell IPC payload assertions.
- Reference Comparison Harness: the new `runtime-compare.ts` helper layered over the real compiler and both runtime paths.

## Test plan

1. **Name**: CTS canonicalizes surviving top-level forms into the wrapper grammar without breaking existing transform passes
- **Type**: integration
- **Disposition**: new
- **Harness**: Direct API Harness
- **Preconditions**: CTS-enabled source fixtures covering module-scope `lift`, `handler`, helper functions, data initializers, inline `derive`/`computed`, `action`, and `patternTool` / `*WithPattern`.
- **Actions**: Run the `CommonToolsTransformerPipeline` on the fixtures and inspect the transformed program and fixture goldens.
- **Expected outcome**: The emitted program contains the canonical wrapper ABI from `SES_SANDBOXING_SPEC.md` and `docs/plans/2026-03-17-ses-sandboxing-implementation.md`: `__ct_builder(...)`, `__ct_fn(...)`, `__ct_pure_fn(...)`, `__ct_data(...)`, and stable `/*__CT_TOPLEVEL__...*/` sentinels on surviving top-level items only. `derive(...)`/`computed(...)` hoists become `lift(...)` factories with call-site parameter application preserved; `action(...)` hoists become `handler(...)` factories with call-site application preserved; `patternTool(...)` and `*WithPattern(...)` remain inner-scope `pattern(...)` forms. This is justified by the spec’s canonical wrapper ABI and the plan’s Task 1 pipeline ordering and hoist rules.
- **Interactions**: Closure lowering, capability lowering, schema injection/generation, TypeScript emit.

2. **Name**: CTS rejects disallowed authored forms before AMD emit
- **Type**: boundary
- **Disposition**: extend
- **Harness**: Direct API Harness
- **Preconditions**: CTS-enabled sources containing inline `lift()` / `handler()`, non-direct builder callbacks, authored `import()`, and non-trusted external static imports.
- **Actions**: Run validation/compile on each source through the existing transformer test utilities.
- **Expected outcome**: Compilation fails with explicit diagnostics for placement violations, non-direct callbacks, v1 dynamic-import rejection, and non-trusted external imports, as required by `SES_SANDBOXING_SPEC.md` and Task 1 Step 5 of the implementation plan. The user-visible proof is the diagnostic stream, not internal AST state.
- **Interactions**: Pattern-context validation, module resolution, transform diagnostics.

3. **Name**: Bundle preflight rejects authored code outside top-level `define(...)` before any side effect can run
- **Type**: boundary
- **Disposition**: new
- **Harness**: Direct API Harness
- **Preconditions**: A malicious compiled bundle string containing a sentinel side effect before or after the AMD `define(...)` region.
- **Actions**: Feed the bundle through bundle preflight and the SES evaluation entrypoint.
- **Expected outcome**: The runtime rejects the bundle before any `compartment.evaluate(...)` executes untrusted code, and the side-effect sentinel remains untouched. This is required by Critical Contract 1 in the implementation plan and the spec’s “Verified Module Load” rule.
- **Interactions**: Bundler wrapper shape, token scanner, SES runtime entrypoint.

4. **Name**: AMD factory verification accepts only canonical wrappers and trusted imports
- **Type**: boundary
- **Disposition**: new
- **Harness**: Direct API Harness
- **Preconditions**: Factory-body fixtures covering a valid transformed module, malformed wrapper forms, non-trusted static imports, and TypeScript AMD output corresponding to authored `import()`.
- **Actions**: Register factories through the loader boundary and attempt `require()` on them under the verifier.
- **Expected outcome**: Canonicalized modules importing only trusted `runtimeDeps` identifiers or same-bundle modules are accepted; malformed wrappers, external imports, and AMD async-require shapes are rejected before factory execution. This is required by Critical Contracts 2 through 4 and the plan’s Task 2 verifier contract.
- **Interactions**: AMD loader, verifier binding table, runtime module identifier policy.

5. **Name**: Plain-data validation accepts only the v1 module-safe subset and never invokes getters while rejecting unsafe data
- **Type**: boundary
- **Disposition**: new
- **Harness**: Direct API Harness
- **Preconditions**: Values spanning the allowed v1 subset (`null`, `undefined`, booleans, numbers, strings, bigint, arrays, plain records) plus invalid values using getters, symbol keys, custom prototypes, sparse arrays, cycles, reserved keys, `Map`, `Set`, `Date`, `Promise`, `Error`, and functions.
- **Actions**: Call `assertPlainData()` / `freezeVerifiedPlainData()` on each value and track whether getter bodies executed.
- **Expected outcome**: Allowed values are accepted and hardened; every disallowed shape is rejected; getter counters remain at zero for accessor-based rejection cases. This is justified by the spec’s versioned `StorableValue` subset and Task 3’s descriptor-safe validation contract.
- **Interactions**: Memory-layer `StorableValue` contract, runtime helper tagging/hardening.

6. **Name**: SES module-load globals are minimal while trusted runtime modules still work
- **Type**: integration
- **Disposition**: new
- **Harness**: Direct API Harness
- **Preconditions**: CTS-enabled programs that read ambient globals (`fetch`, `Temporal`, randomness helpers, `Proxy`, host globals) and import trusted runtime modules through `runtimeDeps`; one program uses `console.log` at module load.
- **Actions**: Compile and evaluate the programs through `Engine.evaluate()` on the SES path.
- **Expected outcome**: Programs cannot access the disallowed ambient authorities at module load, `Proxy` is shadowed out in v1, trusted runtime modules still resolve through `runtimeDeps`, and sandboxed `console` remains usable. This follows the locked decisions in the implementation plan and Task 4’s compartment-global contract.
- **Interactions**: Compartment globals, trusted runtime modules, bundler injected-script removal, evaluation path.

7. **Name**: Same loaded pattern reuses one Compartment, different patterns do not, and repeated invocations do not grow compartments
- **Type**: invariant
- **Disposition**: new
- **Harness**: Programmatic State Harness
- **Preconditions**: A runtime instance with SES enabled, one representative pattern loaded twice, and a second distinct pattern; repeated invocation loop defined for the first pattern.
- **Actions**: Load and execute the first pattern, execute it repeatedly, then load and execute the second pattern while observing compartment/registry identity through the sandbox’s public test surface.
- **Expected outcome**: The first pattern reuses one Compartment across repeated invocation, the second pattern gets a different Compartment, and the “load + repeated invocation” path stays within a generous catastrophic-regression threshold documented in the test. This is required by the spec’s per-pattern compartment decision, Task 4’s lifecycle contract, and the approved testing strategy’s performance guard.
- **Interactions**: SES runtime registry, PatternManager cache, Runtime lifecycle/disposal.

8. **Name**: A real generated pattern keeps correct hoisted-lift, hoisted-handler, and inline-derive behavior under SES
- **Type**: scenario
- **Disposition**: new
- **Harness**: Interaction Harness
- **Preconditions**: A new generated-pattern scenario in `ses-sandbox-smoke.pattern.ts` that exercises module-scope hoisted `lift`, hoisted `handler`, an inline `derive`/`computed` that stays inline, and event-driven updates.
- **Actions**: Run the scenario through `runPatternScenario()`, send the declared events, and assert the result-cell values at each step.
- **Expected outcome**: The observable result-cell values match the scenario’s authored expectations after each event. This is the primary user-visible proof required by the spec’s “Valid existing patterns keep their observable behavior” invariant and Task 8 Step 1.
- **Interactions**: CTS transforms, js-compiler, SES runtime, runner, scheduler, storage.

9. **Name**: Existing nested handler/pattern behavior stays green under SES
- **Type**: scenario
- **Disposition**: existing
- **Harness**: Interaction Harness
- **Preconditions**: The existing `counter-handler-spawn` generated-pattern scenario.
- **Actions**: Run the scenario unchanged through the generated-pattern integration harness.
- **Expected outcome**: Child patterns still spawn, nested handlers still update the right child result cells, and all declared values match the current authored scenario. The source of truth is the existing scenario itself plus the spec’s invariant that valid patterns preserve observable behavior.
- **Interactions**: Nested patterns, handler binding, scheduler, PatternManager, storage.

10. **Name**: Engine compile/evaluate still returns `main` and `exportMap` through the SES path
- **Type**: integration
- **Disposition**: extend
- **Harness**: Direct API Harness
- **Preconditions**: Single-file and multi-file programs, including one that imports a trusted runtime module.
- **Actions**: Call `engine.compile()`, then `engine.evaluate()` with the compiled script and original sources.
- **Expected outcome**: `engine.evaluate()` still returns the same user-visible `{ main, exportMap }` shape used by the current harness contract, and exported functions are callable without rehydrating source strings. This is justified by the current `Harness` API surface and Task 6 Step 1 of the implementation plan.
- **Interactions**: Compiler, bundle preflight, SES runtime, trusted runtime modules.

11. **Name**: Saved and reloaded patterns execute through verified implementation references instead of authored source strings
- **Type**: integration
- **Disposition**: extend
- **Harness**: Programmatic State Harness
- **Preconditions**: A compiled multi-file pattern saved through `PatternManager`, synchronized to storage, and reloaded in a fresh runtime path.
- **Actions**: Register the pattern, save and sync it, reload it by `patternId`, run it, and inspect the serialized module JSON associated with the saved pattern.
- **Expected outcome**: The reloaded pattern still produces the same result-cell values, authored JavaScript modules serialize `implementationRef` plus preview/location metadata instead of executable source strings, and rebinding succeeds across the compile/evaluation-scoped registry boundary. This is required by the “Verified Implementation Reference Contract” in the spec and Task 6’s save/load cutover.
- **Interactions**: Builder serialization, PatternManager persistence, storage, SES verified-function registry.

12. **Name**: Runner executes live function objects or verified refs and rejects authored string implementations
- **Type**: invariant
- **Disposition**: extend
- **Harness**: Programmatic State Harness
- **Preconditions**: One runtime pattern/module path using a live function or verified `implementationRef`, and one authored-string-backed JavaScript module that would previously have gone through `getInvocation()`.
- **Actions**: Run both paths through the real `Runner` node-instantiation surface.
- **Expected outcome**: The live/ref-backed module executes correctly; the authored-string-backed module is rejected with an explicit error and no fallback string evaluation occurs. This is mandated by Critical Contracts 5 and 6 and Task 6 Step 5.
- **Interactions**: Runner node instantiation, function cache or replacement, harness/runtime registry lookup.

13. **Name**: Valid authored programs produce the same exports and pattern outputs under legacy eval and SES
- **Type**: differential
- **Disposition**: new
- **Harness**: Reference Comparison Harness
- **Preconditions**: Curated authored programs stressing hoisted `lift`, hoisted `handler`, inline `derive`/`computed`, and a local-module import.
- **Actions**: Compile each program once, execute it through the legacy eval helper and the SES runtime via `runtime-compare.ts`, and compare exports/result-cell snapshots.
- **Expected outcome**: The user-visible exports and result-cell values match across both runtimes for valid programs. The source of truth is the approved testing strategy’s differential requirement plus the spec’s observable-behavior invariant.
- **Interactions**: Compiler, both runtime implementations, runner, result-cell observation.

14. **Name**: Mapped authored error locations stay the same under legacy eval and SES
- **Type**: differential
- **Disposition**: new
- **Harness**: Reference Comparison Harness
- **Preconditions**: Representative authored programs that fail in a hoisted `lift` callback and a hoisted `handler` callback with stable line numbers.
- **Actions**: Execute the programs through both runtimes using `runtime-compare.ts` and capture the mapped error payloads/stacks.
- **Expected outcome**: Error messages and authored file/line locations match at the user-visible boundary even if internal runtime frames differ. This is justified by the spec’s release-blocking stack-trace requirement and Task 5’s comparison goal.
- **Interactions**: Source maps, error mapping, execution wrappers, scheduler error surfacing.

15. **Name**: Authored runtime failures still map to authored files and filter internal SES noise by default
- **Type**: regression
- **Disposition**: extend
- **Harness**: Output Capture Harness
- **Preconditions**: A top-level throwing program plus CTS-enabled lift/handler programs with known authored throw lines.
- **Actions**: Run the programs through the runtime, capture thrown or scheduled errors, and inspect the surfaced stack traces.
- **Expected outcome**: First relevant frames point at the authored `.ts/.tsx` files and lines, internal SES/runtime frames are filtered from the default display, and any debug-mode path intentionally exposing runtime frames behaves as specified if implemented. This is required by the spec’s mapped-stack requirement and Task 7.
- **Interactions**: Source-map loading, frame classification, scheduler error propagation, error display.

16. **Name**: Shell IPC forwards the SES-mapped error payload the user should see
- **Type**: integration
- **Disposition**: extend
- **Harness**: Output Capture Harness
- **Preconditions**: A worker-side formatted error payload representing a mapped authored failure from the SES path.
- **Actions**: Send the payload through the existing runtime-client transport mock and observe what the shell connection receives.
- **Expected outcome**: The shell receives the error message, stack trace, and available piece/pattern metadata exactly as sent by the worker, and mapped stacks reference authored file/line locations rather than hashed bundle filenames. This follows the existing shell IPC contract and Task 7 Step 1.
- **Interactions**: Runtime-client transport, shell notification wiring, error formatting.

17. **Name**: The runner package test task includes the sandbox suite and passes
- **Type**: regression
- **Disposition**: extend
- **Harness**: Interaction Harness
- **Preconditions**: The new `packages/runner/test/sandbox/*.test.ts` suite exists and `packages/runner/deno.json` has been updated.
- **Actions**: Run `deno task --cwd packages/runner test`.
- **Expected outcome**: The command executes both the existing runner tests and the sandbox tests and exits successfully. This is required by the implementation plan’s Task 2 Step 5 and the repo guideline that each package test task must cover its relevant suite.
- **Interactions**: Deno task wiring, runner package test discovery, sandbox test files.

18. **Name**: Final package and generated-pattern regression suites stay green after the SES cutover
- **Type**: regression
- **Disposition**: existing
- **Harness**: Interaction Harness
- **Preconditions**: Implementation complete and all targeted suites in place.
- **Actions**: Run `deno task --cwd packages/ts-transformers test`, `deno task --cwd packages/js-compiler test`, `deno task --cwd packages/runner test`, and `deno task --cwd packages/generated-patterns integration`.
- **Expected outcome**: All commands exit successfully, confirming the compiler, bundler, runner, sandbox, and generated-pattern integration surfaces remain green together. This is the final acceptance gate from Task 8 of the implementation plan and the approved testing strategy’s regression requirement.
- **Interactions**: All affected packages, workspace task wiring, generated-pattern scenario coverage.

## Coverage summary

Covered action space:

- Compiler-side canonicalization, hoisting, diagnostics, and import-policy enforcement.
- Bundle preflight and AMD factory verification before any untrusted execution.
- Plain-data validation and runtime helper hardening rules at the TCB boundary.
- SES runtime authority narrowing, trusted runtime-module injection, and compartment lifecycle.
- Real generated-pattern behavior through the actual compile/run/event/result flow.
- Engine, PatternManager, Runner, serialization, and verified-function-ref persistence/rebinding.
- Differential semantic comparison against the current eval runtime for valid behavior and mapped errors.
- User-visible error mapping and shell IPC propagation.
- Package/task-level regression gates, including explicit sandbox-suite wiring.
- Low-risk performance coverage through non-growth compartment assertions plus a generous catastrophic-regression timing check.

Explicitly excluded per the agreed strategy and finalized spec:

- Dynamic `import()` support beyond verifier rejection in v1.
- Call-site restrictions such as handler-only randomness or `Temporal` access; those were explicitly deferred in the design discussion.
- Browser/manual QA; all checks are artifact-based or programmatic.
- Deep benchmark work; only a cheap catastrophic-regression performance guard is planned.

Residual risks from those exclusions:

- V2 dynamic-import design can still introduce new authority and verification edges later.
- Deferred call-site restrictions leave a future policy surface that this plan does not try to validate yet.
- The verifier/compiler alignment risk remains fundamentally about fail-closed behavior; that is why this plan emphasizes bundle/factory rejection tests and differential runtime checks instead of adding many isolated unit tests.
