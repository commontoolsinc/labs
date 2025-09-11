# @commontools/schema-generator

Short notes on the JSON Schema generator and ref/definitions behavior.

## All‑Named Hoisting (default)

- Hoists every named type into `definitions` and emits `$ref` for non‑root
  occurrences.
- Excludes wrapper/container names from hoisting: `Array`, `ReadonlyArray`,
  `Cell`, `Stream`, `Default`, `Date`.
- Root types remain inline; `definitions` are included only if at least one
  `$ref` is emitted.
- Anonymous/type‑literal shapes (including aliases that resolve to anonymous
  types) are inlined.
- `$ref` may appear with Common Tools extensions as siblings (e.g.
  `{ "$ref": "#/definitions/Foo", asStream: true }`).

Rationale: Improves human readability and re‑use of complex shared shapes while
keeping wrapper semantics explicit and simple.

Implementation: see `src/schema-generator.ts` (`formatType`) and
`src/type-utils.ts` (`getNamedTypeKey` filtering).

## Running

- Check typings: `deno task check`
- Run tests: `deno task test`

