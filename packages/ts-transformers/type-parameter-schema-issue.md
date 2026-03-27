# Generic Helper Type-Parameter Schema Fallbacks

This note is historical context for the generic-helper schema seam. The behavior
described below is the current intended fallback, not an open crash bug.

## Current rule

When CTS encounters an uninstantiated type parameter at a generic helper
**definition site**, it does not try to invent structure that only exists at a
later call site.

Instead it degrades schema-bearing helper calls to `unknown`:

- `wish<T>(...)` -> inject `{ type: "unknown" }`
- `generateObject<T>(...)` -> inject `{ type: "unknown" }`
- `cell(...)` / `Cell.of<T>(...)` / related cell-factory calls -> inject
  `{ type: "unknown" }`
- explicit-generic `lift<T, U>(...)` / `handler<E, S>(...)` schema injection ->
  inject `{ type: "unknown" }` for unresolved type-parameter positions

This is the principled fallback because:

- `T` is unresolved at the helper definition site
- emitting `{}` is misleadingly specific
- omitting the schema changes the runtime call shape and weakens consistency
- `unknown` preserves safety without pretending we know more than we do

## Derive-specific nuance

`derive(...)` has a separate but related behavior:

- when a transformed derive callback result is an uninstantiated type parameter,
  CTS skips explicit type arguments rather than serializing the type parameter
  directly
- standalone `derive(...)` inside generic helpers is still usually rejected
  earlier by validation, so the old “generic helper derive schema issue” shape
  overstated the live problem

## What is not supported today

CTS does **not** perform call-site specialization for generic helpers. For
example, it does not rewrite:

```ts
function schemaifyWish<T>(path: string, def: T) {
  return derive(wish<T>(path), (i) => i ?? def);
}

const mentionable = schemaifyWish<string[]>("#mentionable", []);
```

using the concrete `string[]` information from the call site.

Doing that would require a much larger design, such as:

- call-site inlining
- deferred second-pass generic instantiation
- or runtime schema generation

## Current recommendation

Treat this as acceptable graceful degradation for now:

- concrete call sites and non-generic helpers should still emit precise schemas
- generic helper definition sites should degrade to `unknown`
- if precise generic-helper schemas become product-critical later, that should
  be a deliberate architecture project rather than ad hoc local inference
