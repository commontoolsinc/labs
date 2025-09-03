# Schema-Generator Test Harness Plan

This plan describes the final testing strategy for
`@commontools/schema-generator`: schema fixtures with string comparison and a
small set of semantic unit tests. We intentionally dropped the intermediate
"golden snapshot" approach in favor of full-string fixtures, which better match
the legacy validation strength while keeping things maintainable and fast.

## Goals

- Strong guarantees that schema outputs remain stable and correct.
- Fast, readable semantic tests for common patterns.
- Deterministic output checks: generation order does not flake.
- Type-checked tests re-enabled once `@commontools/api` generics align.

## Components

1) Canonicalization utilities (test/utils.ts)
- Add `normalizeSchemaExtended` to canonicalize output for stable comparison:
  - Strip `$schema`.
  - Sort object keys recursively.
  - Sort `required`, `enum`, and similar arrays.
  - Normalize `oneOf` patterns where one member is `{ type: "null" }` to a
    fixed order `[ {type: "null"}, other ]`.
  - Sort `definitions` keys deterministically.

2) Schema fixtures (string compare)
- Directory: `test/fixtures/schema`
  - `*.input.ts`: defines the root type as `interface SchemaRoot { ... }`
  - `*.expected.json`: pretty-printed, canonical JSON Schema for `SchemaRoot`
- Runner: `test/fixtures-runner.test.ts`
  - Parses the input, calls the generator for `SchemaRoot`, canonicalizes, and
    compares the pretty-printed JSON (byte-for-byte) to `*.expected.json`.
  - Determinism: generates twice and compares the strings to guard against
    ordering flakes.
  - `UPDATE_GOLDENS=1 deno task test` rewrites the expected JSONs.

3) Fixture coverage
Seed and expand an exhaustive set mirroring legacy
`js-runtime/test/fixtures/schema-transform` scenarios:
- Recursion & cycles: self-recursive, nested recursive, multi-hop circular,
  mutually recursive
- Wrappers: Cell<T>, Stream<T>, Default<T,V>, nested wrappers, alias chains,
  arrays (Cell<T[]>, Array<Cell<T>>)
- Defaults: primitives, arrays, nested arrays, objects, nullable
- Aliases & sharing: alias-of-alias patterns; shared object types used in
  multiple properties
- Additional coverage as needed: intersections/merges, index signatures

4) Semantic tests remain
- Keep focused tests (properties, required, items, flags) for clarity and fast
  iteration.

5) Type-checking
- After `@commontools/api` generics align with our runtime schema shape
  (`$ref?`, `properties?`, and `ExtendedJSONSchema` for markers), flip the
  default `deno task test` to type-checked or ensure `test:check` runs in CI.

## Execution Steps

- Extend `test/utils.ts` with canonicalization helpers.
- Add `test/fixtures-runner.test.ts` and seed `test/fixtures/schema` with
  `*.input.ts`/`*.expected.json` pairs.
- Run via `deno task test`. Update fixtures with
  `UPDATE_GOLDENS=1 deno task test`.
- Expand fixtures and semantic tests to match legacy coverage.

## Notes

- Code-generation-specific literal checks (emitted TS, import ordering, etc.)
  will live in the dedicated AST transformers package tests, not here.
- For schema-generator we intentionally compare strings of canonical JSON to
  ensure we verify the exact serialized output shape that downstream tools and
  developers see.
