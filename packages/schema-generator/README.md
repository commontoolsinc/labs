# @commonfabric/schema-generator

Converts TypeScript types and transformer-created TypeNodes into Common Fabric's
JSON Schema 2020-12 dialect. The complete current-behavior reference is
`docs/specs/schema-generator/ts_to_json_schema_mapping.md`; the extension
vocabulary is summarized in `docs/specs/json_schema.md` and defined by
`packages/api/index.ts`.

## Public API

The root export provides:

- `SchemaGenerator` and `createSchemaTransformerV2`
- `containsFactoryType` / `detectTrustedFactoryType` and their public factory
  types
- Common Fabric declaration/provenance helpers
- `ISchemaGenerator` and `JSONSchemaObjMutable`

Seven focused subpaths expose the interface and TypeScript helper modules; the
factory work adds `./common-fabric-symbols` alongside the existing wrapper and
property helpers.

Both the class and plugin expose:

```ts
generateSchema(
  type,
  checker,
  typeNode?,
  { widenLiterals? }?,
  schemaHints?,
  sourceFile?,
  typeRegistry?,
)

generateSchemaFromSyntheticTypeNode(
  typeNode,
  checker,
  typeRegistry?,
  schemaHints?,
  sourceFile?,
)
```

`typeRegistry` preserves semantic types for synthetic nodes. `schemaHints`
carries array-item overrides, exact factory contracts/provenance, and CFC UI
metadata from `@commonfabric/ts-transformers`.

## Formatter Order

First match wins:

1. Factory
2. Common Fabric wrappers/defaults/scopes/CFC aliases
3. Native types
4. Union
5. Intersection
6. Array
7. Primitive
8. Object

This order is behavior. In particular, trusted factory values must route before
ordinary callable properties are filtered.

## First-Class Factory Values

Trusted `PatternFactory`, `ModuleFactory`, and `HandlerFactory` values emit:

```json
{
  "asFactory": {
    "kind": "pattern",
    "argumentSchema": { "type": "object" },
    "resultSchema": { "type": "object" }
  }
}
```

Module factories use the same fields with `kind: "module"`. Handlers use
`contextSchema` and `eventSchema` with `kind: "handler"`.

Each nested input/output schema is an independent schema document and owns the
`$defs` required by its own `$ref`s. Exact compiler hints take precedence over
checker reconstruction and preserve union arms. Recursive factory-inside-
factory contracts that cannot form a finite series of self-contained documents
throw instead of degrading.

Recognition requires Common Fabric alias/private-brand provenance or an exact
compiler hint. A user type with a matching name is not enough. FrameworkProvided
paths remain compiler/runtime authority metadata and are not emitted inside
`asFactory`.

## Named-Type Hoisting

- Named non-wrapper types are hoisted into `$defs`; non-root occurrences use
  `#/$defs/...`.
- Root types remain inline unless recursion forces a `$ref`; `$defs` is omitted
  when unused.
- Native leaves and wrapper spellings are excluded. Generic alias instantiations
  and unaliased type literals inline; non-generic named aliases hoist.
- `$ref` may have Common Fabric extension siblings such as
  `{ "$ref": "#/$defs/Foo", "asCell": ["stream"] }`.

The precise exclusion policy lives in `getNamedTypeKey` and
`src/typescript/wrapper-names.ts`.

## Callable Properties

Ordinary callable/constructable properties are skipped before `required`
membership and metadata emission because JSON Schema cannot describe functions.
Trusted first-class factories are the explicit exception and use
`FactoryFormatter`. A legacy narrow exception retains callable properties whose
return signature is `Stream`, `Cell`, or `SqliteDb` as an `asCell` schema.

## Native Leaves

`Date` emits a date-time string, `URL` emits a URI string, and typed-array /
ArrayBuffer-family values emit permissive `true` schemas. These stay inline and
do not collide with array detection or named-type hoisting.

## Running

- Check typings: `deno task check`
- Run tests: `deno task test`
- Format/lint: `deno task fmt` / `deno task lint`

Factory behavior is pinned in `test/schema/factory-types.test.ts`; changes also
affect the ts-transformers schema fixtures, so run both packages for cross-
package contract changes.
