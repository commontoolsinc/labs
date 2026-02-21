# Traversal and Schema Query

This document specifies the current behavior of the traversal subsystem implemented
in `packages/runner/src/traverse.ts`.

## Status

Draft — normative for current runner behavior.

---

## Scope

This spec covers:

- Value/path traversal (`getAtPath`, `followPointer`)
- Schema-aware traversal (`SchemaObjectTraverser`)
- Link and write-redirect handling during reads
- Missing value/default handling
- Dependency tracking side effects (`schemaTracker`)

It does not specify write-time mutation behavior.

---

## Core Model

Traversal operates on attestations of the form:

- `address`: `{ space, id, type, path }`
- `value`: current datum at that address (or `undefined` if missing)

Path conventions:

- Address paths are rooted under `"value"`
- Link paths are relative and do not include `"value"`
- Array indices must be canonical decimal index strings (`"0"`, `"1"`, ...); non-index properties (for example `"01"`) are not treated as array indices

---

## Path Traversal

`getAtPath(tx, doc, path, ..., lastNode)` resolves a `doc` + relative `path` by:

1. Following links when required by `lastNode`:
   - `"value"`: follow all links
   - `"writeRedirect"`: follow only write-redirect links at terminal positions
   - `"top"`: do not follow terminal link
2. Descending object/array/string-native properties (`length` support for arrays and strings)
3. Returning `{ value: undefined }` when descent fails

When links are followed, schema context is re-rooted and combined with any schema on the link.

---

## Link Resolution and Missing Data

`followPointer(...)`:

- Resolves one pointer step, then delegates further descent back to `getAtPath`
- Detects pointer cycles using `(pointer value, schema-context)` tracking
- Records traversed linked docs in `schemaTracker`
- Returns `undefined` for missing/retracted targets instead of throwing

If `includeSource` is set, traversal also loads linked `source` and linked pattern docs recursively for dependency tracking.

---

## Schema Traversal Semantics

`SchemaObjectTraverser.traverse` evaluates a doc against a selector `{ path, schema }`.

### Boolean/true-ish schemas

- True-ish schema (`true` or object containing only internal/default metadata) traverses as DAG and returns all reachable content (subject to cycle protection)
- False schema rejects

### Logical schema operators

- `anyOf`: all matching branches are evaluated; matches are merged via `objectCreator.mergeMatches`
- `oneOf`: exactly one branch must validate; zero or multiple matches reject
- `allOf`: every branch must validate; successful branch results are merged via `objectCreator.mergeMatches`

### `$ref`

Top-level `$ref` is resolved before traversal decisions. Defaults are applied from the resolved schema.

### Type and structure rules

- Primitive values validate against schema type
- Arrays validate per item schema
- Objects validate per property schema
- Required properties must be present in the filtered result

`additionalProperties` handling is intentionally specialized:

- If `properties` exists and `additionalProperties` is omitted, unspecified properties are not traversed; inclusion is delegated to `objectCreator.addOptionalProperty`

---

## Missing Values and Defaults

Behavior is intentionally asymmetrical:

- Missing object property reached through traversal:
  - included as `undefined` only when schema permits it
  - otherwise omitted/rejected depending on context
- Missing array entry reached through traversal:
  - may become `null` when schema allows `null`
  - otherwise causes array validation failure

Defaults:

- Property defaults are applied from schema during object traversal
- Top-level defaults are applied when current value is `undefined`
- Defaults behind resolved `$ref` are honored

---

## asCell/asStream Boundaries

`SchemaObjectTraverser.asCellOrStream(schema)` controls boundary behavior.

- With `traverseCells = false` (runtime transforms), `asCell`/`asStream` boundaries produce cell/stream objects without deep traversal of nested content
- With `traverseCells = true` (query traversal), linked content is traversed to register dependencies

### Detection Rules

`asCellOrStream(schema)` is true when:

- schema object has `asCell: true` or `asStream: true`
- or schema has `anyOf` and every option is `asCellOrStream`
- or schema has `oneOf` and every option is `asCellOrStream`

Notes:

- This check is shallow for `anyOf`/`oneOf` options; refs inside options are not fully resolved before this check.
- This check determines traversal boundary behavior, not whether final output is a JS Cell object. Output shape still depends on the active `objectCreator`.

### Behavior by Value Shape

| Value shape | `traverseCells = false` (runtime transform path) | `traverseCells = true` (query path) |
| --- | --- | --- |
| Primitive value with `asCell/asStream` | Boundary at current node. Traverser calls `createObject(link, value)` and does not descend. In runtime object creator this yields a cell-like wrapper. | No boundary shortcut from `traverseCells`; traversal still resolves value normally and query object creator returns plain traversed data. |
| Object property, inline non-link value, schema has `asCell/asStream` | Boundary at property. Property value is replaced by `createObject(propertyLink, undefined)` and nested fields are not traversed. | No boundary shortcut; traverses/validates nested object content. |
| Object property, link value, schema has `asCell/asStream` | Follows write redirects to stable target, then creates boundary object from resolved link (`getNextCellLink` path). | Follows redirects and continues traversal into resolved target content. |
| Array element, link value, schema has `asCell/asStream` | Resolves write redirects first, then follows one additional link step for array semantics, then emits boundary object for the resolved target link. | Performs same link resolution, then continues schema traversal into the resolved element value. |
| Array element, inline non-link object, schema has `asCell/asStream` | Boundary at element index. Emits `createObject(indexLink, undefined)`; no nested traversal for element fields. | No boundary shortcut; element object is traversed against element schema. |
| Array element, inline non-link object, schema is not `asCell/asStream` | Element is wrapped via data-cell URI identity (`createDataCellURI`) for stable link identity during nested traversal. | Same behavior. |

### Pointer and Redirect Details at Boundaries

For pointer values, boundary behavior is based on the write-redirect-resolved document:

1. Resolve only write-redirect links (`lastNode = "writeRedirect"`).
2. If runtime boundary mode (`traverseCells = false`) and schema is `asCell/asStream`, compute cell link from that resolved location:
   - if resolved value is still a link, follow one more link (`getNextCellLink`)
   - else use normalized link to current resolved address
3. Return `createObject(cellLink, undefined)`.

Broken redirect case:

- If redirect target is `undefined` and schema is `asCell/asStream`, traversal returns an error/invalid result (no boundary object is emitted).

### Missing Values and Defaults at `asCell/asStream` Paths

- Missing linked value + `asCell/asStream`: treated as invalid for boundary creation.
- Property defaults with `asCell/asStream`:
  - when a property schema default exists, traversal enters `traverseWithSchema({ value: undefined }, propSchema)`
  - default application uses the resolved schema, including defaults behind top-level `$ref`
  - emitted value is produced by `objectCreator.applyDefault` / `createObject`, so runtime and query outputs differ by object creator behavior

---

## Cycle and DAG Rules

Traversal uses cycle trackers to avoid infinite recursion across:

- Pointer/link cycles
- Object graph cycles/aliases

For `CompoundCycleTracker`, disposal removes empty per-key entries.

---

## Known Non-Standard JSON Schema Behavior

Traversal is intentionally not a full JSON-Schema validator. Notable differences:

- Branch result merging (`anyOf`/`allOf`) is runtime-specific
- `combineSchema` is a best-effort pseudo-intersection for parent/link schema composition
- Narrowing across path boundaries may be more permissive than strict JSON-Schema semantics

---

## Conformance Tests

Behavior in this spec is verified by:

- `packages/runner/test/traverse.test.ts`
- `packages/runner/test/query.test.ts`

These include regression tests for:

- oneOf exact-match semantics
- allOf branch-result merging
- defaults via resolved `$ref`
- cycle-tracker cleanup

---

**Previous:** [Schemas](./7-schemas.md)
