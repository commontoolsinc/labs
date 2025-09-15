# Schema Transformer Refactor Plan

This document defines the implementation plan to complete the schema transformer
rewrite and to migrate tests out of `packages/js-runtime` into dedicated
packages with clear ownership. The plan keeps `@commontools/schema-generator`
focused on the JSON Schema engine and introduces a new package for TypeScript
AST transformers.

## Goals

- Single source of truth for JSON Schema generation logic.
- Clear separation between compile-time AST transforms and schema generation.
- Migrate schema-related tests from `js-runtime` into
  `@commontools/schema-generator` for parity and focus.
- Introduce a dedicated package for AST transformers and move transformer tests
  there.
- Rebuild the OpaqueRef transformer on a modular architecture that reaches
  parity first and unlocks closures support next.
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
- We added alias-aware array detection to support nested aliases like
  `Cell<DataArray>` in minimal compiler hosts.
- `deno task test` in `schema-generator` now type-checks the suite; the
  optional `test:check` task remains for symmetry with automation scripts.
  Wrapper semantics are centralized in `CommonToolsFormatter`; arrays are
  handled by `ArrayFormatter` and a helper inside the Common Tools formatter.
  `ObjectFormatter` is intentionally thin and delegates.
- The OpaqueRef transformer still lives in `js-runtime`, uses a monolithic
  visitor, and misses cases like unary `!` and `map` callbacks with manually
  typed parameters—highlighted by `ct-891`.

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
  - arrays-optional
  - array-special-types
  - boolean-literals
  - cell-type
  - circular-alias-error
  - complex-defaults (value extraction, nullability)
  - default-type
  - defaults-no-def-mutation
  - nested-wrappers
  - recursion-variants (covers multi-hop and mutual recursion cases)
  - type-aliases-and-shared
  - type-to-schema (assert schema shape, not AST code transformation)

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

2. Focused test suites (landed structure)
   - `test/schema/cell-type.test.ts`
     - `Cell<T>`, nested cells, streams, defaults-as-cell wrappers
   - `test/schema/array-special-types.test.ts` and `arrays-optional.test.ts`
     - `any[]`/`never[]` handling, optional arrays, alias coverage
   - `test/schema/recursion-variants.test.ts`
     - recursive, mutually-recursive, and multi-hop `$ref` scenarios
   - `test/schema/type-aliases-and-shared.test.ts`
     - alias reuse across properties and shared definitions
   - `test/schema/complex-defaults.test.ts`
     - `Default<T,V>` extraction, tuple/object defaults, nullability
   - `test/schema/default-type.test.ts`, `boolean-literals.test.ts`,
     `defaults-no-def-mutation.test.ts`
     - primitive wrappers, literal unions, and mutation guards
   - `test/schema/type-to-schema.test.ts`
     - generator output equivalence vs expected JSON Schema structure

3. Assertions
   - Prefer structural equality on normalized objects.
   - Allow flexible property order; strip `$schema` where not relevant.
   - For cycle heavy outputs, assert: root `$ref` points to a definition,
     existence of expected definition names, and core sub‑shapes.

4. Tasks
   - `deno task test` already type-checks; keep the optional `test:check` task
     wired for tooling parity until CI scripts converge on a single entrypoint.

5. De‑duplicate
   - After parity is achieved in `schema-generator`, remove redundant generator
     tests from `js-runtime` (keep only integration/E2E there until Phase 3 is
     complete).

## Phase 2 — Transformer Package & OpaqueRef Parity

Scope: stand up a dedicated transformers package, port existing utilities, and
land a modular rewrite of the OpaqueRef transformer that reaches functional
parity (including fixes for gaps such as unary `!` and `map` callback
parameters typed as `any`/`number`).

Deliverables:

1. Package scaffolding
   - Create `packages/ts-transformers` with `deno.json`, exports, lint/test
     tasks, and a README documenting the public surface.
   - Mirror the dependency footprint currently required by the transformer
     files (`typescript`, `@commontools/utils`, etc.).

2. Shared infrastructure
   - Extract transformer-wide utilities (`imports.ts`, logging helpers, shared
     `types.ts`, debugging toggles) into `src/core/**` with explicit exports.
   - Introduce a shared `TransformationContext` to centralize checker access,
     scope state, and import management. Keep the first version lean enough to
     serve the parity rewrite; closures support can extend it later.

3. Schema transformer port
   - Move `schema.ts` into the new package with the minimal adjustments needed
     to compile. Confirm fixture parity by running the existing
     schema-transform tests from `packages/js-runtime/test/fixtures` inside the
     new package.

4. OpaqueRef parity rewrite
   - Break the monolithic visitor into focused rule modules (`jsx-expression`,
     `conditional`, `call-expression`, `property-access`, `schema-injection`).
   - Ensure map callbacks that annotate parameters as `any`/`number` still
     derive correctly by tracking reactive provenance from call sites rather
     than trusting checker annotations.
   - Add unary `!` handling and keep existing binary/call/template derivations.
   - Preserve import management by routing through the shared context.
   - Provide an opt-in `mode: "error"` path that surfaces actionable
     diagnostics for recipe authors.

5. Test migration
   - Copy fixture suites (`ast-transform`, `jsx-expressions`,
     `schema-transform`, `handler-schema`) under
     `packages/ts-transformers/test/fixtures`. Keep `.tsx` fixtures intact.
   - Port the existing test runners, adding focused unit coverage for new rule
     classes (especially unary `!` and map callbacks) and ensuring golden
     updates remain ergonomic via `UPDATE_GOLDENS`.

Exit criteria:

- New package builds and tests independently.
- Fixture comparisons match current `js-runtime` output for both schema and
  opaque-ref transforms.
- Known regressions called out in `ct-891-cts-not-converting-to-derive.txt` are
  addressed by the rewritten parity implementation.

## Phase 3 — Integrate Consumers & Add Closures Support

- Update `@commontools/js-runtime` and any other callers to consume transformers
  from `@commontools/ts-transformers`, leaving only runtime/E2E coverage in
  `js-runtime`.
- Provide a compatibility flag or environment toggle so we can fall back to the
  legacy transformer during the rollout.
- Design and implement closures support on top of the new architecture:
  - Extend the shared context with scope analysis that can track captured
    reactive values.
  - Add rule modules for closure lifting (`OpaqueRef.map` callbacks, inline
    handler factories, etc.).
  - Cover destructuring of captured values and interop with mutable cells.
- Expand the fixture suite with representative closures scenarios and ensure
  runtime integration tests exercise the new behavior.

## Phase 4 — CI and Operational Cleanups

- Ensure the root `deno task test` runs the schema generator and transformer
  packages in addition to runtime checks.
- Align CI pipelines, including golden update flows, with the new package
  layout.
- Add a lightweight compatibility smoke test in `js-runtime` that imports the
  new package to guard against packaging regressions.

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

Phase 2 (`ts-transformers` & parity):

- [ ] Scaffold `packages/ts-transformers` with tasks/exports/README.
- [ ] Extract shared context/import utilities into the new package.
- [ ] Port the schema transformer and verify fixture parity.
- [ ] Land the modular OpaqueRef parity rewrite (map callbacks, unary `!`).
- [ ] Migrate fixture runners and add parity-focused unit coverage.

Phase 3 (integration & closures):

- [ ] Switch `js-runtime` (and other consumers) to the new package with a
      fallback flag.
- [ ] Implement scope analysis and closures support on top of the new engine.
- [ ] Add fixture + integration coverage for closure scenarios.

Phase 4 (CI & ops):

- [ ] Root `deno task test` exercises schema + transformer packages.
- [ ] Update CI/golden pipelines for the new package layout.
- [ ] Add a packaging/compatibility smoke test in `js-runtime`.
