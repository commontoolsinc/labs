---
status: historical
created: 2026-05-31
archived: 2026-07-30
reason: "Snapshot of the removed AMD bundle pipeline and the bundle-grained identity problem that motivated content-addressed module loading."
superseded-by: docs/specs/module-loading.md
---

# The AMD Bundle Pipeline and Bundle-Grained Module Identity

This is the record of the pipeline that
[module-loading.md](../../specs/module-loading.md) replaced, and of the identity
defect that motivated the replacement. It was written as that spec's "Current
System Overview" and "Problem Statement" sections and is preserved here because
the defect — not the pipeline — is what the shipped design is shaped around.

None of the code described below exists any more. The AMD bundle pipeline
(bundler, whole-bundle verifier, `Engine.compile`/`Engine.evaluate`) and the AMD
compilation cache (`CachedCompiler`) were removed once the ESM module-record
loader became the only loader. Companion records: the rollout is
[module-loading-implementation-plan.md](module-loading-implementation-plan.md),
the verifier port and engine integration are
[module-loading-verifier-and-engine-design.md](module-loading-verifier-and-engine-design.md),
and the removed cache's own design is
[compilation-cache.md](compilation-cache.md).

## Compilation

`Engine.compile(program)` (`packages/runner/src/harness/engine.ts`) received a
`RuntimeProgram` = `{ main, files[] }`, where `files` was the entry file plus its
resolved import closure, then:

1. Computed a single id over the whole program:

   ```ts
   const id = options.identifier ?? computeId(program);
   // computeId(program) = hashOf([program.main, ...files.filter(non .d.ts)])
   ```

2. Rewrote **every** file path to `/${id}${originalPath}` and synthesized a new
   `/index.ts` entry that re-exported `main` (`transformProgramWithPrefix`,
   `packages/runner/src/harness/pretransform.ts`). The inline comment was
   explicit that the prefix existed only to stop TypeScript from "flatten[ing]
   the output, eliding the common prefix" — i.e. it was a collision-avoidance
   namespace for bundling.

3. Compiled the closure with `ModuleKind.AMD` and `outFile`
   (`packages/js-compiler/typescript/options.ts`) through the
   `CommonFabricTransformerPipeline`, producing one IIFE that contained
   `define("<id>/path", [deps], factory)` calls. The AMD `define`/`require` shim
   was inlined from `packages/js-compiler/typescript/bundler/amd-loader.ts` by
   `packages/js-compiler/typescript/bundler/bundle.ts`.

4. Re-parsed those `define()` calls in the bundle verifier
   (`packages/runner/src/sandbox/compiled-js-parser.ts`) for verifiable
   execution.

## Loading

`lockdown()` ran once (`packages/runner/src/sandbox/ses-runtime.ts`). A fresh
`Compartment` was created per `execute()` and the entire bundle was run with
`compartment.evaluate(js)` — string evaluation under `evalTaming: "safe-eval"`.
Runtime modules (`commonfabric`, `commonfabric/schema`, aliases) were `define`d
into the bundle via `runtimeDeps`. SES resolved through Runner's `deno.jsonc`
import map.

## Identity flow into `action.src`

- The `/${id}/…` prefix became each function's source-map filename.
- `annotateFunctionDebugMetadata` read the source location via
  `getExternalSourceLocation()` and assigned
  `fn.src = "/<id>/pattern.tsx:line:col"`
  (`packages/runner/src/builder/module.ts`).
- The scheduler turned that into the durable fingerprint:
  `schedulerImplementationFingerprint` returned `src:${action.src}`
  (`packages/runner/src/scheduler/run.ts`), which keyed persistent scheduler
  observations.

## The problem: identity was bundle-grained, not module-grained

`computeId` hashed the entire `[main, ...files]` set and that hash was stamped
into every function's `src`. The identity of one unchanged function therefore
depended on:

- which entry point was compiled (different `main`),
- which subset and ordering of the import closure was included,
- any unrelated sibling file present in the bundle.

Reloading a pattern from a different entry point yielded a different `program`,
hence a different `id`, hence a different `fn.src` for every function, hence a
fingerprint mismatch against the persisted observation — for code that had not
changed at all. This was the direct cause of persistent-scheduler-state
rehydration misses.

The naive inverse — hashing each module's bytes in isolation — would have been
stable across entry points but **incorrect**, because a module's runtime
behavior depends on what it imports. If module `A` imports `compute` from `B`
and `B`'s implementation changes, `A`'s behavior changes even though `A`'s own
bytes did not — and likewise if `A` imports a *type* from `B` that `B`
redefines, because that type is lowered into `A`'s generated schema. A correct
fingerprint had to be both stable across entry points and sensitive to
transitive changes in any imported module, value or type. That requirement is
what the Merkle-over-the-import-graph identity in
[module-loading.md](../../specs/module-loading.md) satisfies.
