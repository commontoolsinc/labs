# CFC Authoring Contract

**Status:** Draft contract
**Scope:** `packages/api`, `packages/ts-transformers`,
`packages/schema-generator`

This document specifies the compile-time contract for CFC-aware TypeScript
authoring. It is intentionally narrower than the runner CFC specs: the concern
here is how authored types and JSX lower into schema metadata and helper calls.

## Source Of Truth

This document is normative for the CFC-specific TypeScript authoring surface.

Related contracts:

- `docs/specs/ts-transformer/cfc_ui_helper_contract.md`
- `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`

## Goals

- Give authors a type-level way to express CFC metadata without hand-writing
  raw `ifc` JSON for common cases.
- Keep lowering deterministic across `toSchema<T>()`, inferred `pattern()`
  schemas, and explicit `pattern(..., outputSchema)` paths.
- Preserve implementation identity where the schema must refer back to a local
  binding, especially for `WriteAuthorizedBy`.

## Non-Goals

- Model every possible CFC construct as TypeScript sugar.
- Infer arbitrary runtime expressions into schema metadata.
- Treat the transformer as a trust boundary.

## Canonical Surface

### Base Carrier

The canonical compiler-facing carrier is:

```ts
type Cfc<T, Meta> = T & {
  readonly __ct_cfc__?: Meta;
};
```

`Cfc<T, Meta>` must preserve the runtime/schema shape of `T` and only add to
the emitted `ifc` metadata.

### Path-Bearing Helpers

Projection-like constructs must preserve path identity, not only the projected
value type.

Canonical helpers:

```ts
type Ref<Root, Path extends readonly string[]> = {
  readonly __ct_ref_root__?: Root;
  readonly __ct_ref_path__?: Path;
};

type PathValue<Root, Path extends readonly string[]> = unknown;
type RefValue<SourceRef> = unknown;
type CanonicalPointer<Path extends readonly string[]> = `/${string}`;
```

### Supported Alias Set

The implementation must keep the supported alias list synchronized across the
public API, transformer diagnostics, and schema-generator formatter support.

Canonical alias set:

- `Cfc`
- `Classified`
- `Integrity`
- `AddIntegrity`
- `RequiresIntegrity`
- `MaxConfidentiality`
- `WriteAuthorizedBy`
- `ExactCopy`
- `ProjectionPath`
- `ProjectionOf`
- `Projection`

Friendly aliases may expand to those forms, but the formatter contract is keyed
to this canonical set.

The former `OpaqueInput`, `LengthPreservedFrom`, `FilteredFrom`, `SubsetOf`,
and `PermutationOf` aliases were removed: they lowered to `ifc.opaque` /
`ifc.collection`, which the runner rejects fail-closed as unsupported
trust-sensitive claims, so the authoring surface advertised capabilities that
could only ever fail at commit. Reintroduce them together with the runner
enforcement for the spec's §8.5 collection and §8.13 opaque-input transitions.
A raw `Cfc<T, { opaque: ... }>` / `Cfc<T, { collection: ... }>` payload still
lowers verbatim through the base-carrier rule below (and still fails closed at
commit) — the carrier copies any payload; only the canonical promises are
gone.

## Lowering Rules

### `Cfc<T, Meta>`

- Lower the base schema exactly as if `T` had been authored directly.
- Evaluate `Meta` as a type-level object/tuple/literal payload.
- Merge the evaluated metadata into `schema.ifc`.
- If the base schema already contains `ifc`, the merge is additive/overwriting
  by key, not replacement of the entire schema object.

### Simple Wrapper Aliases

These aliases lower to direct `ifc` keys:

- `Confidential<T, X>` -> `ifc.confidentiality = X`
- `Integrity<T, X>` -> `ifc.integrity = X`
- `AddIntegrity<T, X>` -> `ifc.addIntegrity = X`
- `RequiresIntegrity<T, X>` -> `ifc.requiredIntegrity = X`
- `MaxConfidentiality<T, X>` -> `ifc.maxConfidentiality = X`
- `ExactCopy<T, P>` -> `ifc.exactCopyOf = P`

### Projection Helpers

- `ProjectionPath<T, From, Path>` lowers to
  `ifc.projection = { from: From, path: Path }`.
- `ProjectionOf<Root, PathTuple>` lowers to
  `ifc.projection = { from: "/", path: encode(PathTuple) }`.
- `Projection<Ref<Root, PathTuple>>` lowers identically to `ProjectionOf`.

Path tuple encoding rules:

- each segment must be a string literal at compile time
- `~` escapes to `~0`
- `/` escapes to `~1`
- `[]` encodes to `/`
- otherwise encode as `/${segments.join("/")}`

### `WriteAuthorizedBy<T, typeof binding>`

`WriteAuthorizedBy` is special because the emitted schema must refer to a local
implementation binding, not a plain JSON value.

Normative behavior:

1. The second type argument must be a direct `typeof ...` query.
2. The queried root binding must be declared in the same source file.
3. Supported binding declarations are intentionally narrow:
   - a local variable initialized from `handler(...)`
   - a local variable initialized from `module(...)`
   - a local variable initialized from `requireEventIntegrity(...)`
   - a local function declaration
4. The transformer must report `cfc-write-authorized-by` if any of the above
   conditions fail.
5. The schema-generator must preserve the identity through a marker payload,
   then rehydrate it back into emitted schema AST as `<binding> as any`.

One valid marker shape is:

```ts
// Shown for illustration only.
{ __ctWriterIdentityOf: <ts.EntityName> }
```

That marker is an implementation detail, but the implementation still needs an
equivalent cross-stage identity channel.

## Pipeline Contract

The CFC authoring path is not owned by one transformer. The required stage
ordering is:

1. `CfcJsxTransformer`
2. `SchemaInjectionTransformer`
3. `SchemaGeneratorTransformer`

More precisely:

- `CfcJsxTransformer` rewrites recognized UI helpers and attaches node-local
  schema hints.
- `SchemaInjectionTransformer` seeds `[UI]` member schema hints and constructs
  `toSchema<...>()` calls that preserve type/identity information.
- `SchemaGeneratorTransformer` validates `WriteAuthorizedBy` usage, evaluates
  CFC type metadata, and emits the final schema AST.

Reordering these stages changes behavior and is not allowed without updating
this spec.

## Alias Expansion And Type Evaluation

The formatter must be able to resolve simple type-alias indirection before it
decides whether a type is CFC-aware.

Required capabilities:

- resolve nested type aliases recursively
- substitute type parameters through alias expansion
- evaluate literal, tuple, array, and type-literal payloads
- preserve the base type when stripping the `Cfc` carrier intersection
- preserve wrapper erasure rules for `Reactive<T>` so a `Cfc<Reactive<T>, ...>`
  carrier lowers to the schema shape of `T` rather than inventing a separate
  runtime value shape

If alias expansion cannot resolve back to a supported form, lowering must fall
back to ordinary schema generation rather than inventing partial metadata.
Non-canonical aliases resolve only through explicit type arguments — defaulted
type parameters are not recovered outside the canonical set.

## Diagnostics

Required diagnostic type:

- `cfc-write-authorized-by`

Required failure modes:

- second type argument is not `typeof ...`
- target is imported rather than local
- target is not a supported handler/module-style binding

## Current Limits

- `WriteAuthorizedBy` only supports in-scope local bindings.
- Projection paths must be statically known string tuples.
- Metadata payload evaluation is limited to literal-like type syntax; arbitrary
  conditional or computed type programs are out of scope.
- The supported alias set is closed by name. New sugar needs explicit formatter
  support.
- `OpaqueInput<T, Spec>` only declares schema-level opacity. The compile-time
  read restrictions on opaque values still come from the existing `Reactive`
  type/runtime contract.

## Acceptance Coverage

The contract is not fully implemented until these tests pass or equivalent
coverage exists:

- `packages/ts-transformers/test/cfc-authoring.test.ts`
- `packages/schema-generator/test/schema/cfc-type.test.ts`
- equivalent coverage for `OpaqueInput<T, Spec>` lowering to `ifc.opaque`
