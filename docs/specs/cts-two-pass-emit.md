# CTS Transform Emit Refactor

## Goal

Ensure helpers that our CTS transforms insert (e.g. `derive`, `ifElse`,
`toSchema`, future `h`) are bound as real module imports so TypeScript's AMD
emitter rewrites them to `commontools_1.*` automatically. We also want a
foundation for future auto-imports without falling back to namespace lookups or
breaking source maps.

## Current Pain Points

- CTS transforms run after the program is bound. When we add a helper import
  late, the emitter treats `derive(...)` as an unbound identifier and the AMD
  bundle crashes at runtime.
- We tried patching synthetic identifiers via `recordHelperReference`, but the
  binder still never sees a symbol for those helpers.
- We want CTS to auto-import more helpers (e.g. `h`) without requiring manual
  import statements or breaking the module graph.

## Proposed Approach

Refactor the compiler pipeline to perform a two-phase compilation:

1. **Analysis pass**
   - Build a `ts.Program` exactly as today. This provides the type checker used
     by CTS transformers.
   - Run the CTS transformers (opaque-ref, schema) manually against each source
     file and capture the printed output alongside any requested helper imports.
   - If `--show-transformed` is enabled, stream that printed output immediately
     (one file per CTS-enabled module). This replaces the existing logging
     transformer.

2. **Emit pass**
   - Create a fresh `Program` struct that substitutes the printed transform
     output for any CTS-enabled file and leaves the rest untouched.
   - Instantiate a new `TypeScriptHost`/`ts.Program` over that transformed
     program. Because the helper imports are present before binding, the binder
     records them as normal symbols.
   - Emit without re-running the CTS transformers; the second program now emits
     the canonical transformed source that the first pass produced.

## Implementation Plan

1. Extract the "apply CTS transforms" work into a helper that:
   - Detects `/// <cts-enable />`.
   - Runs the CTS transformers via `ts.transform`.
   - Returns the printed output for any CTS-enabled file along with a flag
     indicating whether the file actually changed.

2. Adjust `TypeScriptCompiler.compile`:
   - Keep the current program as the analysis program (with checks).
   - Invoke the helper above to obtain transformed sources.
   - If no sources changed, fall back to the current single-pass emit path.
   - Otherwise, create a second `Program` struct and `TypeScriptHost` backed by
     the transformed contents, build a second `ts.Program`, and call `emit`
     without CTS transformers.
   - Stream transformed sources to stdout when `showTransformed` is set.

3. Clean up CTS transformer plumbing:
   - Remove the `recordHelperReference` binding shim once the two-pass emit is
     in place (done in follow-up cleanup so helpers rely on standard imports).
   - Leave the import manager logic intact; the second pass will respect the
     new import specifiers.

4. Verify & follow-up:
   - Re-run `deno task check` and relevant tests (`packages/ts-transformers`,
     `packages/js-runtime`).
   - Smoke CTS patterns (counter, nested-counter, instantiate-recipe) with
     `deno task ct dev` to confirm the AMD bundles now emit
     `commontools_1.derive`.
   - Update documentation for `--show-transformed` to note the refined output
     behaviour.

## Alternatives Considered

- Injecting helper imports by editing file text before parsing: simpler but
  risks duplicate bindings, line-number drift, and unnecessary imports.
- Forcing namespace access (`commontools_1.derive`): fixes runtime but defeats
  the goal of having clean helper APIs.

The two-pass emit balances correctness, source-map fidelity, and future helper
support without relying on brittle hacks.
