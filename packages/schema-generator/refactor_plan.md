# Schema Transformer Refactor Plan

This document defines the implementation plan to complete the schema
transformer rewrite and to migrate tests out of `packages/js-runtime` into
dedicated packages with clear ownership. The plan keeps
`@commontools/schema-generator` focused on the JSON Schema engine and
introduces a new package for TypeScript AST transformers.

## Goals

- Single source of truth for JSON Schema generation logic.
- Clear separation between compile‑time AST transforms and schema generation.
- Migrate schema‑related tests from `js-runtime` into
  `@commontools/schema-generator` for parity and focus.
- Introduce a dedicated package for AST transformers and move transformer
  tests there.
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
- Running `deno task test` in `schema-generator` is configured; we currently
  use `--no-check` until API generics are aligned.

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
  - Tests: input/expected fixture pairs for AST changes (Schema Transformer,
    JSX Expression Transformer, Handler Schema Transformation, Compiler
    directive enablement).

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
     - `getTypeFromCode(code: string, name: string)` → `{ type, checker,
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
   - Provide `deno task test:check` to run with type checking.

5. De‑duplicate
   - After parity is achieved in `schema-generator`, remove redundant generator
     tests from `js-runtime` (keep only integration/E2E there until Phase 3 is
     complete).

## Phase 2 — New Transformers Package

Create `packages/ts-transformers` with:

- `deno.json` with a `test` task, exports, and minimal imports.
- `src/` contents migrated from
  `packages/js-runtime/typescript/transformer/`:
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
- Keep only end‑to‑end runtime tests in `js-runtime` (compiles/executes,
  bundler wiring, recipe integration).
- Remove redundant transformer tests in `js-runtime` after migration.

## Phase 4 — CI and Cleanups

- Ensure the root `deno task test` runs both new packages’ tests.
- When API generics are aligned, remove `--no-check` from
  `schema-generator`’s default test task.
- Optionally add a minimal compatibility/sanity test in `js-runtime` that
  exercises both transformers to reduce regression risk.

## API Types (to revisit later)

- Align `@commontools/api` `JSONSchema` generics with the JSON Schema spec and
  generator output:
  - Make `$ref?: string` optional and ensure `properties?:
    Readonly<Record<string, JSONSchema>>`.
  - Introduce `ExtendedJSONSchema = JSONSchema & { asCell?: boolean;
    asStream?: boolean }` for compile‑time utilities.
  - Update generic helpers to accept `T extends ExtendedJSONSchema` while
    manipulating markers; constrain to base `JSONSchema` after stripping.
- Once updated, flip `schema-generator` tests back to strict type checking.

## Risks and Considerations

- Fixture parity: exact textual expectations from legacy tests may require
  normalization and looser assertions around ordering/formatting.
- Union semantics: literal unions currently map to arrays for fixture
  compatibility; if we decide to pivot to `enum`/`oneOf`, update both engine
  and tests together.
- Package boundaries: avoid cross‑package test dependencies; tests in
  `schema-generator` should not import js-runtime utilities.

## Checklist

Phase 1 (schema-generator):
- [ ] Add `test/utils.ts` helpers.
- [ ] Add `schema/cell-types.test.ts`.
- [ ] Add `schema/arrays-and-aliases.test.ts`.
- [ ] Add `schema/recursion-and-cycles.test.ts`.
- [ ] Add `schema/type-aliases-and-shared.test.ts`.
- [ ] Add `schema/complex-defaults.test.ts`.
- [ ] Add `schema/type-to-schema.test.ts`.
- [ ] Remove redundant schema tests from `js-runtime`.

Phase 2 (new package):
- [ ] Scaffold `packages/ts-transformers` with tasks/exports.
- [ ] Move transformer sources from `js-runtime`.
- [ ] Port fixture tests and utilities.

Phase 3 (integration):
- [ ] Update `js-runtime` to use new package.
- [ ] Keep only E2E runtime tests in `js-runtime`.

Phase 4 (stabilize):
- [ ] Root CI runs all packages via `deno task test`.
- [ ] Align API types; drop `--no-check` in `schema-generator`.

