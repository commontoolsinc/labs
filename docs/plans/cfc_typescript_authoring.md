# CFC TypeScript Authoring Spec

This document proposes a TypeScript authoring surface for CFC annotations that
lowers into JSON Schema `ifc` metadata through the existing
`ts-transformers`/`schema-generator` pipeline.

It complements [runner_cfc_implementation.md](./runner_cfc_implementation.md)
by specifying how authors should express CFC policy in types rather than
hand-written schema literals.

## April 6 2026 Status Snapshot

A working prototype landed on `exp/cfc-impl-2`, primarily in commits
`66fe257f2ba2861a6f0058cfe78c6a166c9e3b6b` and
`dd7e1d3c01cee65681939c4735a3b27b43bdff96`. It is useful as a reference
implementation, but it should be replayed onto current `main` in slices rather
than merged wholesale.

The important lesson is that "CFC authoring" is not one package change. It is a
cross-package contract spanning:

- `packages/api`
- `packages/ts-transformers`
- `packages/schema-generator`
- `packages/runner` builder/runtime UI helpers

For the replay, treat this document as restart guidance plus authoring intent.
Use the more concrete transformer specs alongside it:

- [CFC Authoring Contract](../specs/ts-transformer/cfc_authoring_contract.md)
- [CFC UI Helper Contract](../specs/ts-transformer/cfc_ui_helper_contract.md)

## Status

Prototype implemented on `exp/cfc-impl-2`; replay on top of current `main`
still pending.

## Branch Learnings

- Keep the canonical surface very small. `Cfc<T, Meta>` plus path-bearing
  reference helpers (`Ref`, `ProjectionOf`, `Projection`) were enough to drive
  the real lowering work; everything else should remain thin sugar.
- Path identity matters more than value type identity. Projection helpers that
  only preserve the value type are not sufficient because lowering needs the
  originating path.
- `WriteAuthorizedBy` is a compiler contract, not plain JSON metadata. The
  prototype had to preserve AST/entity identity across the transformer and
  schema-generator boundary, then rehydrate it back into source-level
  expressions during schema emission.
- UI helper support is a vertical slice. JSX rewriting, schema hints, schema
  synthesis, builder helpers, and runner UI trust all move together.
- The test surface is the best replay asset. The prototype already captured the
  tricky cases in `packages/ts-transformers/test/cfc-authoring.test.ts` and
  `packages/schema-generator/test/schema/cfc-type.test.ts`.

## Late Surprises

- Explicit pattern output schemas lost UI helper integrity hints until
  `SchemaInjectionTransformer` learned to synthesize standalone `[UI]` schema
  hints from the returned JSX tree. Without that, inferred schemas and explicit
  schemas behaved differently.
- `WriteAuthorizedBy<T, typeof binding>` could not be expressed by formatter
  logic alone. It required a narrow diagnostic contract in the transformer and
  a marker/rehydration path in `schema-generator`.
- UI helper contracts are partly static and partly dynamic:
  - the rewritten JSX always emits `data-ui-*` attributes when the props are
    present
  - schema-side `addIntegrity` can only be synthesized when the relevant props
    are literal strings at compile time
- The pipeline order matters. `CfcJsxTransformer` must run before schema
  injection so the `[UI]` schema synthesizer sees rewritten nodes and attached
  schema hints.

## Recommended Replay Order

1. Lock the authoring contract docs first.
   - Alias set, lowering rules, diagnostics, and UI helper semantics should be
     explicit before touching implementation again.
2. Replay the API surface and pure schema-generator pieces.
   - `Cfc`, path helpers, author-facing aliases, and `CfcFormatter` are easier
     to port than the transformer pipeline.
3. Replay transformer diagnostics and identity plumbing next.
   - `WriteAuthorizedBy` validation, schema-generator AST rehydration, and
     schema-hint threading are prerequisites for reliable end-to-end behavior.
4. Replay `CfcJsxTransformer` and `[UI]` schema synthesis as one slice.
   - Do not separate JSX helper rewriting from schema hint seeding; that split
     created one of the late branch regressions.
5. Only then port examples and runner-facing UI helpers.
   - The examples are valuable acceptance tests, but they should consume a
     stable authoring contract rather than define it implicitly.

## Goals

- Keep ordinary pattern code close to normal TypeScript.
- Make CFC annotations live in the type system by default.
- Preserve enough provenance information to lower transition annotations such as
  `projection`, `exactCopyOf`, and collection relationships.
- Allow higher-level sugar on top of a small canonical core.
- Keep raw `JSONSchema` literals available as an escape hatch.

## Non-Goals

- Replace all manual schema authoring immediately.
- Express every CFC concern directly as a plain value type without path or
  source information.
- Force JSX/UI authors to write raw JSON Pointer strings or raw VDOM path
  schemas.

## Design Principles

### 1. `Cfc<T, Meta>` Is The Canonical Base Type

The core type-level carrier is:

```ts
type Cfc<T, Meta> = T & {
  readonly __ct_cfc__?: Meta;
};
```

`Cfc<T, Meta>` is the canonical compiler-facing IR. All other author-facing
types are aliases layered on top of it.

### 2. Type Sugar Must Preserve Lowering Information

Wrappers that need provenance, such as projections, must carry source-path
identity, not only source value types.

This is valid but insufficient:

```ts
type Bad = Projection<Input["source"]["email"], Input["from"]>;
```

Both sides may be `string`, which loses the path information needed for schema
lowering.

Instead, the canonical sugar must preserve source-path information:

```ts
type Good = ProjectionOf<Input, ["source", "email"]>;
```

or:

```ts
type SourceEmail = Ref<Input, ["source", "email"]>;
type Good = Projection<SourceEmail>;
```

### 3. Semantic Helpers Sit Above The Core

User-friendly concepts such as `Sensitive<T>`, `UiAction<...>`, or
`WriteAuthorizedBy<..., typeof submitHandler>` should be aliases or helper
constructs over `Cfc<T, Meta>`, not parallel systems.

## Core Vocabulary

### Atom-Carrying Metadata

The metadata payload attached through `Cfc<T, Meta>` maps directly to schema
`ifc` fields.

Representative shape:

```ts
type CfcMeta = {
  classification?: readonly unknown[] | readonly (readonly unknown[])[];
  integrity?: readonly unknown[];
  addIntegrity?: readonly unknown[];
  requiredIntegrity?: readonly unknown[];
  maxConfidentiality?: readonly string[];
  writeAuthorizedBy?: readonly unknown[];
  exactCopyOf?: `/${string}`;
  projection?: {
    from: `/${string}`;
    path: `/${string}`;
  };
  collection?: {
    sourceCollection?: `/${string}`;
    subsetOf?: `/${string}`;
    permutationOf?: `/${string}`;
    filteredFrom?: `/${string}`;
    lengthPreserved?: true;
  };
  recomposeProjections?: {
    from: `/${string}`;
    baseIntegrityType: string;
    parts: readonly {
      outputPath: `/${string}`;
      projectionPath: `/${string}`;
    }[];
  };
};
```

The runtime may accept additional fields beyond this subset.

## Path And Reference Model

### `Ref<Root, Path>`

The core path-bearing type is:

```ts
type Ref<Root, Path extends readonly string[]> = {
  readonly __ct_ref_root__?: Root;
  readonly __ct_ref_path__?: Path;
};
```

`Ref<Root, Path>` is a type-level reference to a path inside a root input or
object type. It exists so that lowering can recover both:

- the value type at that path
- the path itself

### `PathValue<Root, Path>`

The compiler should define a utility to recover the value type at a path:

```ts
type PathValue<Root, Path extends readonly string[]> = unknown;
```

This is a compile-time utility only. Its exact implementation can vary.

### `CanonicalPointer<Path>`

The compiler should also define a utility that maps a tuple path to a canonical
JSON Pointer string:

```ts
type CanonicalPointer<Path extends readonly string[]> = `/${string}`;
```

### `ProjectionOf<Root, Path>`

For the common case, authors should not need to write `Ref<...>` explicitly.

```ts
type ProjectionOf<
  Root,
  Path extends readonly string[],
> = Cfc<
  PathValue<Root, Path>,
  {
    projection: {
      from: "/";
      path: CanonicalPointer<Path>;
    };
  }
>;
```

Conceptually, `ProjectionOf<Input, ["source", "email"]>` means:

- the field value type is `Input["source"]["email"]`
- the field is a projection of `/source/email` from the root input

### `Projection<Ref>`

For reuse across multiple fields, authors may define a reusable source ref.

The compiler should provide a helper to recover the pointed-to value type:

```ts
type RefValue<SourceRef> = unknown;
```

Then the reusable projection wrapper is:

```ts
type Projection<SourceRef> = Cfc<
  RefValue<SourceRef>,
  {
    projection: {
      from: "/";
      path: CanonicalPointer<SourceRef extends Ref<any, infer P> ? P : never>;
    };
  }
>;
```

Example:

```ts
type SourceEmail = Ref<Input, ["source", "email"]>;

interface Output {
  from: Projection<SourceEmail>;
}
```

Both forms are first-class and should lower identically.

## Canonical Type Aliases

These aliases should be provided by the core API or by a single shared CFC
types module.

### Label-Carrying Types

```ts
type Classified<T, Clauses> = Cfc<T, { classification: Clauses }>;

type RequiresIntegrity<T, Atoms> = Cfc<T, {
  requiredIntegrity: Atoms;
}>;

type AddIntegrity<T, Atoms> = Cfc<T, {
  addIntegrity: Atoms;
}>;

type WriteAuthorizedBy<T, Impl> = Cfc<T, {
  writeAuthorizedBy: [{ __implOf: Impl }];
}>;
```

### Transition Types

```ts
type ExactCopy<T, From extends `/${string}`> = Cfc<T, {
  exactCopyOf: From;
}>;

type ProjectionPath<
  T,
  From extends `/${string}`,
  Path extends `/${string}`,
> = Cfc<T, {
  projection: { from: From; path: Path };
}>;

type LengthPreservedFrom<T, From extends `/${string}`> = Cfc<T, {
  collection: {
    sourceCollection: From;
    lengthPreserved: true;
  };
}>;

type FilteredFrom<T, From extends `/${string}`> = Cfc<T, {
  collection: {
    filteredFrom: From;
  };
}>;
```

`ProjectionPath<...>` is the raw pointer-oriented form.

`ProjectionOf<...>` and `Projection<Ref<...>>` are the preferred author-facing
forms.

## Friendly Authoring Sugar

Friendly sugar should remain thin aliases over the canonical core.

Examples:

```ts
type Secret<T> = Classified<T, ["secret"]>;

type TrustedSecretRead<T> = Cfc<T, {
  requiredIntegrity: ["trusted-source"];
  maxConfidentiality: ["secret"];
}>;
```

For structured atoms:

```ts
type Sensitive<T, Class extends string, Subject> = Classified<T, [[{
  type: "https://commonfabric.org/cfc/atom/Resource";
  class: Class;
  subject: Subject;
}]]>;
```

## UI Semantics

Plain field annotations should use `Cfc<T, Meta>`-based types directly.

UI subtree annotations should usually be expressed through semantic helpers that
lower into node-local `addIntegrity` metadata.

Examples:

```ts
type UiActionNode<Action extends string> = AddIntegrity<VNode, [{
  type: "https://commonfabric.org/cfc/atom/UiActionContract";
  action: Action;
}]>;

type UiPromptSlotNode<
  Surface extends string,
  Role extends string,
> = AddIntegrity<VNode, [{
  type: "https://commonfabric.org/cfc/atom/UiPromptSlotContract";
  surface: Surface;
  role: Role;
}]>;
```

In practice, authors should usually consume these through JSX-level helpers such
as `UiAction`, `UiPromptSlot`, or `UiDisclosure` rather than by directly
writing `VNode` intersection types.

## Lowering Rules

### Rule 1: `Cfc<T, Meta>` Does Not Change Runtime Value Shape

`Cfc<T, Meta>` is compile-time metadata only. It must lower to the same schema
shape as `T`, plus the corresponding `ifc` metadata.

### Rule 2: Field Path Is The Target Path

When a property is annotated with `Cfc<T, Meta>`, the property's own location in
the enclosing object is the output path for schema emission.

### Rule 3: `ProjectionOf<Root, Path>` Emits `projection`

For:

```ts
interface Output {
  from: ProjectionOf<Input, ["source", "email"]>;
}
```

the compiler should emit the schema equivalent of:

```json
{
  "type": "string",
  "ifc": {
    "projection": {
      "from": "/",
      "path": "/source/email"
    }
  }
}
```

where `/` means the enclosing input root for that boundary.

### Rule 4: `WriteAuthorizedBy<T, typeof handlerFn>` Emits `writeAuthorizedBy`

When the implementation identity of `handlerFn` is derivable at compile time,
the compiler lowers `WriteAuthorizedBy<...>` into the schema form already used
by the runner. If it is not derivable, the compiler must emit a hard error or
require an explicit escape hatch.

### Rule 5: Friendly Sugar Lowers Through Canonical Aliases

`Secret<T>`, `TrustedSecretRead<T>`, `Sensitive<T, ...>`, and similar aliases
must lower exactly as their underlying `Cfc<T, Meta>` expansions.

## Example

```ts
type SubmittedAction = {
  command: string;
  submittedBy: string;
};

interface Input {
  source: {
    email: string;
    items: number[];
  };
}

type SourceEmail = Ref<Input, ["source", "email"]>;

interface Output {
  from: Projection<SourceEmail>;
  shifted: LengthPreservedFrom<number[], "/source/items">;
}
```

Equivalent direct form:

```ts
interface Output {
  from: ProjectionOf<Input, ["source", "email"]>;
  shifted: LengthPreservedFrom<number[], "/source/items">;
}
```

## Escape Hatch

Raw schema authoring remains valid:

```ts
const outputSchema = toSchema<Output>({
  ifc: {
    exchange: { ... },
  },
});
```

This is required for:

- early adoption before all wrappers exist
- advanced policy constructs without first-class type sugar
- debugging and fixture pinning

## Open Questions

- Whether pointer-oriented wrappers such as `LengthPreservedFrom<T, "/x">`
  should also gain `Ref`-based author-facing forms.
- Whether JSX/UI helpers should be implemented as components, macros, or
  dedicated compiler-recognized intrinsics.
- Whether `WriteAuthorizedBy<T, typeof handlerFn>` should lower directly from
  function identity or through an explicit `ImplementationRef<typeof handlerFn>`
  helper.
- Whether object-root projection should always use `from: "/"` or allow named
  boundary roots for multi-parameter handlers.
