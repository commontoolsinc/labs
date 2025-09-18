# @commontools/schema-generator

Short notes on the JSON Schema generator and ref/definitions behavior.

## All‑Named Hoisting (default)

- Hoists every named type into `definitions` and emits `$ref` for non‑root
  occurrences.
- Excludes wrapper/container names and native leaf types from hoisting: `Array`,
  `ReadonlyArray`, `Cell`, `Stream`, `Default`, `Date`, `URL`, `Uint8Array`,
  `ArrayBuffer`.
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

## Native Type Schemas

- Maps ECMAScript built-ins directly when they appear as properties:
  - `Date` → `{ type: "string", format: "date-time" }`
  - `URL` → `{ type: "string", format: "uri" }`
  - Typed array family (`Uint8Array`, `Uint8ClampedArray`, `Int8Array`,
    `Uint16Array`, `Int16Array`, `Uint32Array`, `Int32Array`, `Float32Array`,
    `Float64Array`, `BigInt64Array`, `BigUint64Array`) plus `ArrayBuffer`,
    `ArrayBufferLike`, `SharedArrayBuffer`, and `ArrayBufferView` → `true`
    (permissive JSON Schema leaf)
- These shortcuts keep schemas inline without emitting `$ref` definitions, while
  avoiding conflicts with array detection or hoisting, even when the compiler
  widens them via intersections or aliases.

## Function Properties

- Properties whose resolved type is callable or constructable are skipped
  entirely so we do not emit function shapes in JSON Schema output.
- Method signatures, declared methods, and properties whose type exposes call
  signatures are all filtered before we decide on `required` membership or emit
  attribute metadata (docs, default wrappers, etc.).
- This keeps schemas focused on serialisable data: JSON Schema cannot describe
  runtime function values, and downstream tooling expects objects, arrays, and
  primitives only.

Implementation: see `src/formatters/object-formatter.ts` and
`src/type-utils.ts:isFunctionLike`.

## Running

- Check typings: `deno task check`
- Run tests: `deno task test`
