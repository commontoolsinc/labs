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
