# Schema-Generator Test Harness Plan

This plan describes how we will recover the validation strength of the old
fixture-based tests (which compared entire emitted files) while keeping the new
schema-generator tests maintainable and fast.

## Goals

- Strong guarantees that schema outputs remain stable and correct.
- Fast, readable semantic tests for common patterns.
- Golden deep-equality (“snapshot”) tests for complex structures to catch
  regressions the old string comparisons would have caught.
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

2) Golden snapshot harness
- Add `test/golden/cases.ts`: registry of golden cases with fields:
  - `name`: unique id
  - `code`: TypeScript string under test
  - `typeName`: the root symbol to generate
  - `expectedPath`: JSON file path under `test/golden/expected/`
- Add `test/golden/runner.test.ts`:
  - For each case, generate a schema with `createSchemaTransformerV2()`.
  - Canonicalize via `normalizeSchemaExtended`.
  - If `Deno.env.get("UPDATE_GOLDENS") === "1"`, write the expected JSON.
  - Else, read the expected JSON and deep-equal.
  - Determinism: generate twice and deep-equal (canonicalized) to catch ordering
    regressions.

3) Golden coverage (initial set)
Seed a representative set (expand over time):
- Recursion & cycles:
  - `recursion_basic` (Node { value, next?: Node })
  - `recursion_children_array` (children?: Node[])
- Wrappers & defaults:
  - `wrappers_nested` (Cell<Default<string,'d'>>, Default<string[], ['a','b']>)
  - `defaults_complex_array_object` (array-of-objects defaults; nested object
    defaults)

We will add additional goldens incrementally:
- multi-hop circular (A→B→C→A), mutually-recursive (A↔B)
- Cell<T[]>, array of Cell<T>, Stream<Cell<T>>, Default<T|null, null>, aliases
  (CellArray<T> = Cell<T[]>) and nested aliasing
- Intersection object merging, index signatures/additionalProperties, union
  literal policy (enum vs array-of-items) once decided

4) Semantic tests remain
- Keep focused tests (properties, required, items, flags) for clarity and fast
  iteration.

5) Type-checking
- After `@commontools/api` generics align with our runtime schema shape
  (`$ref?`, `properties?`, and `ExtendedJSONSchema` for markers), flip the
  default `deno task test` to type-checked or ensure `test:check` runs in CI.

## Execution Steps

- Extend `test/utils.ts` with canonicalization helpers.
- Add `test/golden/cases.ts` and `test/golden/runner.test.ts`.
- Seed `test/golden/expected/*.json` for the initial set.
- Run via `deno task test`. Update goldens with
  `UPDATE_GOLDENS=1 deno task test` (writes expected JSONs).
- Expand goldens and semantic tests iteratively to match legacy coverage.

## Notes

- Code-generation-specific literal checks (emitted TS, import ordering, etc.)
  will live in the dedicated AST transformers package tests, not here.
- Golden tests will compare canonical JSON objects, not file strings, to avoid
  brittleness from harmless key ordering changes.

