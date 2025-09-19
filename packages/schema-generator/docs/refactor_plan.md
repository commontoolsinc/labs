# Schema Transformer Refactor Plan

This document defines the implementation plan to complete the schema transformer
rewrite and to migrate tests out of `packages/js-runtime` into dedicated
packages with clear ownership. The plan keeps `@commontools/schema-generator`
focused on the JSON Schema engine and introduces a new package for TypeScript
AST transformers.

## Goals

- Single source of truth for JSON Schema generation logic.
- Clear separation between compile‑time AST transforms and schema generation.
- Migrate schema‑related tests from `js-runtime` into
  `@commontools/schema-generator` for parity and focus.
- Introduce a dedicated package for AST transformers and move transformer tests
  there.
- Keep `js-runtime` focused on runtime/integration tests.

## Current State (observations)

- New schema engine exists in `packages/schema-generator` with modular
  formatters (primitive, object, array, union, intersection, common‑tools).
- `createSchemaTransformerV2()` wraps the engine with the same signature as the
  legacy `typeToJsonSchema`.
- `packages/js-runtime/typescript/transformer/schema.ts` delegates to the new
  engine, but other AST transformers still live under `js-runtime`.
- Many js-runtime tests are integration/E2E; several are purely about schema
  shape and should move.
- We added alias‑aware array detection to support nested aliases like
  `Cell<DataArray>` in minimal compiler hosts.
- Running `deno task test` in `schema-generator` is configured. For now, tests
  run with `--no-check` due to `@commontools/api` generic constraints; a
  `test:check` task exists to re‑enable strict type‑checking once the API
  generics align with the generator’s output.
  - Wrapper semantics are centralized in `CommonToolsFormatter`; arrays are
    handled by `ArrayFormatter` and a small helper in the Common Tools
    formatter. `ObjectFormatter` is intentionally thin and delegates.

## Target Architecture

- `@commontools/schema-generator` remains a pure JSON Schema generator.
  - Public surface: generator, plugin factory, formatter interfaces/utilities.
  - Tests: only schema output assertions.

- New package: `@commontools/ts-transformers` (TypeScript AST transformers).
  - Contains the transformer implementations now in
    `packages/js-runtime/typescript/transformer`:
    - `schema.ts` (compile‑time `toSchema<T>()` replacement using the new
      generator)
    - `opaque-ref.ts`
    - `imports.ts`, `transforms.ts`, `logging.ts`, `types.ts`, `utils.ts`,
      `debug.ts`
  - Tests: input/expected fixture pairs for AST changes (Schema Transformer, JSX
    Expression Transformer, Handler Schema Transformation, Compiler directive
    enablement).

- `@commontools/js-runtime` consumes transformers from
  `@commontools/ts-transformers` and retains only end‑to‑end runtime tests
  (build/execute flows, bundling, recipe integration).

## Test Migration Strategy

Move tests based on what they validate:

- Move to `schema-generator` (pure schema output):
  - arrays‑optional
  - cell‑array‑types
  - cell‑type
  - default‑type
  - complex‑defaults (value extraction, nullability)
  - nested‑wrappers
  - type‑aliases
  - shared‑type
  - recursive‑type
  - recursive‑type‑nested
  - multi‑hop‑circular
  - mutually‑recursive
  - type‑to‑schema (assert schema shape, not AST code transformation)

Testing model in schema‑generator:

- Prefer fixture‑based tests with canonicalization for determinism and semantic
  deep‑equality for expected vs actual:
  - `test/fixtures/schema/*.input.ts` (root type `SchemaRoot`) →
    `*.expected.json`.
  - Determinism is checked by generating twice and comparing canonicalized
    strings; expected vs actual uses parsed JSON with order‑insensitive
    comparison where appropriate (for readability and robustness).
- Keep focused unit tests for formatter behavior where useful.
- We removed the temporary “golden snapshot” tests; fixtures now serve as the
  primary stability checks.

- Keep as transformer/E2E (stay with js‑runtime until moved to the new
  transformers package):
  - with‑options (compile‑time merge of object literal into schema)
  - no‑directive (skips without `/// <cts-enable />`)
  - recipe‑with‑types (.tsx end‑to‑end recipe/transformer integration)
  - with‑opaque‑ref (.tsx; spans OpaqueRef + Schema transformers)

## Phase 1 — Schema‑Generator Parity

Scope: Implement focused schema tests in `packages/schema-generator` that cover
the topics listed above. These tests should not rely on AST rewriting or I/O.

Deliverables:

1. Test utilities
   - File: `packages/schema-generator/test/utils.ts`
   - Helpers:
     - `createTestProgram(code: string)` → `{ program, checker, sourceFile }`
     - `getTypeFromCode(code: string, name: string)` →
       `{ type, checker,
       typeNode? }`
     - `normalizeSchema(schema: unknown)` → stable object for equality
       comparisons (strip `$schema`, order `definitions`, optional `$ref`
       normalization if needed).

2. Focused test suites (proposed structure)
   - `packages/schema-generator/test/schema/cell-types.test.ts`
     - `Cell<T>`, `Cell<Array<T>>`, `Stream<T>`, `Stream<Cell<T>>`,
       `Default<T,V>`, `Cell<Default<T,V>>`
   - `packages/schema-generator/test/schema/arrays-and-aliases.test.ts`
     - `T[]`, `Array<T>`, alias types, nested generics
   - `packages/schema-generator/test/schema/recursion-and-cycles.test.ts`
     - recursive‑type, recursive‑type‑nested, multi‑hop‑circular,
       mutually‑recursive (assert `$ref` + `definitions`)
   - `packages/schema-generator/test/schema/type-aliases-and-shared.test.ts`
     - alias re‑use across properties, shared types
   - `packages/schema-generator/test/schema/complex-defaults.test.ts`
     - defaults from `Default<T,V>`, `T|null`, tuples/objects where applicable
   - `packages/schema-generator/test/schema/type-to-schema.test.ts`
     - direct generator output equivalence vs expected structure

3. Assertions
   - Prefer structural equality on normalized objects.
   - Allow flexible property order; strip `$schema` where not relevant.
   - For cycle heavy outputs, assert: root `$ref` points to a definition,
     existence of expected definition names, and core sub‑shapes.

4. Tasks
   - Keep `deno task test` running with `--no-check` until API generics align.
   - Provide and maintain `deno task test:check` to run with type checking; run
     this in CI (non‑blocking) until generics are aligned, then flip the default
     task to type‑checked.

5. De‑duplicate
   - After parity is achieved in `schema-generator`, remove redundant generator
     tests from `js-runtime` (keep only integration/E2E there until Phase 3 is
     complete).

## Phase 2 — New Transformers Package

Create `packages/ts-transformers` with:

- `deno.json` with a `test` task, exports, and minimal imports.
- `src/` contents migrated from `packages/js-runtime/typescript/transformer/`:
  - `schema.ts`
  - `opaque-ref.ts`
  - `imports.ts`, `transforms.ts`, `logging.ts`, `types.ts`, `utils.ts`,
    `debug.ts`
- Public API:
  - `createSchemaTransformer(program: ts.Program, options?: {...})`
  - `createOpaqueRefTransformer(...)`
  - Optional: a small helper to compose/apply transformers in tests.

Testing in the new package:

- Recreate fixture‑based tests under `packages/ts-transformers/test/`:
  - `fixture-based.test.ts` (AST Transformation)
  - `schema-transformer.test.ts` (Schema Transformer, compile‑time injection)
  - `jsx-expression-transformer.test.ts`
  - `handler-schema-transformer.test.ts`
  - `compiler-directive.test.ts` (cts‑enable)
- Copy fixture files from `js-runtime/test/fixtures/schema-transform/` to
  `packages/ts-transformers/test/fixtures/schema-transform/`.
- Keep `.tsx` fixtures where needed for JSX tests.

## Phase 3 — Integrate and Migrate Consumers

- Update `@commontools/js-runtime` to import transformers from
  `@commontools/ts-transformers`.
- Keep only end‑to‑end runtime tests in `js-runtime` (compiles/executes, bundler
  wiring, recipe integration).
- Remove redundant transformer tests in `js-runtime` after migration.

## Phase 4 — CI and Cleanups

- Ensure the root `deno task test` runs both new packages’ tests.
- When `@commontools/api` generics are aligned with the generator’s runtime
  schema shape (`$ref?`, `properties?`, markers via an extended schema type),
  remove `--no-check` from `schema-generator`’s default test task and make
  type‑checked tests the default locally and in CI.
- Optionally add a minimal compatibility/sanity test in `js-runtime` that
  exercises both transformers to reduce regression risk.

## Risks and Considerations

- Fixture parity: exact textual expectations from legacy tests may require
  normalization and looser assertions around ordering/formatting.
- Union semantics: literal unions currently map to arrays for fixture
  compatibility; if we decide to pivot to `enum`/`oneOf`, update both engine and
  tests together.
- Package boundaries: avoid cross‑package test dependencies; tests in
  `schema-generator` should not import js-runtime utilities.

## Checklist

Phase 1 (schema-generator):

- [x] Add test utilities (`test/utils.ts`) and canonicalization helpers.
- [x] Add focused schema tests covering Cell/Stream/Default, arrays/aliases,
      recursion/cycles, type aliases/shared types, complex defaults, and
      type‑to‑schema parity.
- [x] Add fixture runner with determinism check and golden update support.
- [x] Remove redundant schema tests from `js-runtime` (after parity is verified
      across suites).

Phase 2 (new package):

- [ ] Scaffold `packages/ts-transformers` with tasks/exports.
- [ ] Move transformer sources from `js-runtime`.
- [ ] Port fixture tests and utilities.

Phase 3 (integration):

- [ ] Update `js-runtime` to use new package.
- [ ] Keep only E2E runtime tests in `js-runtime`.

Phase 4 (stabilize):

- [ ] Root CI runs all packages via `deno task test`.
- [ ] Align API types; drop `--no-check` in `schema-generator` and make
      type‑checked tests the default.
