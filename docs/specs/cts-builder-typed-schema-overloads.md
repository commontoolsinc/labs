# CTS Builder Typed+Schema Overloads

## Problem

After the two-pass emit refactor, we reparse and type-check the transformed
program. Our schema injector rewrites calls like `lift`/`handler`/`recipe` to
use the overloads that accept `JSONSchema` objects. Those overloads infer
argument/result types from the schema via `SchemaWithoutCell`, which yields
readonly collections. Developers who originally wrote generics such as
`lift<{ … }, MentionableCharm[]>` now see type errors: the transformed code no
longer preserves their mutable array types, and `readonly` values can’t be
assigned back to mutables. A similar issue appears for `handler` and
`recipe`, plus we lose overloads like `handler(..., { proxy: true })` because
we swap out the original signature.

Our goal is to preserve the developer-specified type parameters *and* emit
concrete schemas so the runtime keeps working. We need the pipeline to static-
check the same surface types the original code authored, while still providing
fully reified JSON schema literals at runtime.

## Proposal

Introduce “typed + schema” overloads for each builder that currently accepts
schema literals. These overloads accept the same generics the developer may
already have written, reuse those type parameters verbatim in the resulting
`ModuleFactory`/`RecipeFactory`, and **only** use `SchemaWithoutCell` (and
friends) to validate schema compatibility. We do not rewrite the developer’s
types into the SchemaWithoutCell form—inputs stay as `Cell<T>`/`Stream<T>` if
that’s what they authored; outputs are still surfaced with the developer’s
declared result type.

### 1. Extend builder overloads

For each builder we schema-inject (`recipe`, `handler`, `lift` at minimum), add
a new overload to the runtime factories (`packages/runner/src/builder/*.ts`) and
mirror it in the public API (`packages/api/index.ts`, generated `.d.ts`). The
pattern:

```ts
export function lift<
  TParams,
  TResult,
  TSchema extends JSONSchema = JSONSchema,
  RSchema extends JSONSchema = JSONSchema,
>(
  argumentSchema: TSchema,
  resultSchema: RSchema,
  implementation: (input: TParams) => TResult,
): ModuleFactory<TParams, TResult>;
```

Likewise for `handler` (two schemas) and `recipe`. This overload keeps the same
runtime data (the schema objects) but returns `ModuleFactory<TParams, TResult>`.
During implementation we’ll statically assert the schemas by requiring
`SchemaWithoutCell<TSchema>` to be assignable to `TParams` *and*
`SchemaWithoutCell<RSchema>` to be assignable to `TResult`, without changing the
surface types the developer sees.

### 2. Update schema injection

Teach `schema-injection.ts` to prefer the typed+schema overload:

- If the call already has type arguments, keep them; inject schema literals as
  additional arguments and re-emit the call with the same `<TParams, TResult>`
  ordering.
- If the call lacked generics but the arguments we’re adding are
  `toSchema<T>()`, extract `T` and synthesise the first two type arguments so
  the new overload sees the developer’s original surface types.
- Detect when a call has already been rewritten (e.g. `toSchema<T>` is already
  present so we only need to reapply the generics).

The same logic applies for `recipe`, `handler`, and `lift`.

### 3. Preserve mutability as needed

Because we keep the user’s generics untouched, we let `Cell#get()` continue to
return `Readonly<T>` and surface that reality. If a recipe expects to mutate a
value coming out of a `Cell`, it must either call `.set` or clone the data. The
transform should never silently replace the user-authored type with the
`SchemaWithoutCell` variant (which erases mutability *and* drops wrapper types).

### 4. Validation & migration

- Run the CLI on the previously failing patterns (`chatbot-note.tsx`,
  `default-app.tsx`, etc.) and verify the transformed output compiles.
- Old code that already removed generics is unaffected; the new overload still
  works via inference.
- Document the new overload in API docs so recipe authors know they can keep
  explicit `<TParams, TResult>` signatures even after schema injection.

## Alternatives Considered

- Wrapping schema-derived types in `Mutable<>` without extending the overloads.
  This fixes the readonly warnings but doesn’t help with proxy overloads or
  other typed signatures. Extending the builders gives us stronger typing and
  backwards compatibility.
- Skipping the second-pass type check. That would hide the errors but defeats
  the purpose of generating real schemas.

With these overloads in place, the pipeline preserves developer intent, keeps
runtime schema emission, and makes the second-pass checker happy.

## Open Questions / Next Steps

- Only the builders we currently schema-inject (`recipe`, `handler`, `lift`) are covered.
  If we start injecting schemas into `compute` or `render`, add equivalent typed+schema
  overloads there.
- We explicitly avoid wrapping schema-derived types in `Mutable<>`; that would mask
  schema/type mismatches rather than preserve the developer-authored signatures.
