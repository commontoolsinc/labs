# Type Parameter Schema Generation Issue

## The Problem

When users write generic helper functions that use `derive`, our transformer
can't generate schemas because the type parameters are uninstantiated at the
function definition site.

**Example from `note.tsx`:**

```typescript
function schemaifyWish<T>(path: string, def: T) {
  return derive(wish<T>(path), (i) => i ?? def);
}

// Called with concrete type
const mentionable = schemaifyWish<MentionableCharm[]>("#mentionable", []);
```

## Current Behavior

**Inside the generic function**, our ClosureTransformer tries to infer the
return type of the callback `(i) => i ?? def`:

- `signature.getReturnType()` returns `T` (TypeParameter, not a concrete type)
- We can't call `checker.typeToTypeNode()` on a TypeParameter - it crashes
- The type `T` is only instantiated to `MentionableCharm[]` at the call site

**Our current fix (two parts):**

1. **ClosureTransformer**: Detect TypeParameter, skip creating type arguments
   entirely:

```typescript
if (isTypeParam) {
  hasTypeParameter = true; // Omit all type args
}
```

2. **Type Inference**: Filter out TypeParameters like we filter Any/Unknown:

```typescript
export function isAnyOrUnknownType(type: ts.Type | undefined): boolean {
  return (type.flags &
    (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) !==
    0;
}
```

**Result:**

```typescript
// No schemas - runtime-only type handling
function schemaifyWish<T>(path: string, def: T) {
  return __ctHelpers.derive({
    input: wish<T>(path),
    def: def,
  }, ({ input: i, def }) => i ?? def);
}
```

## The Question

**Should we accept this limitation, or invest in call-site transformation?**

### Option 1: Accept Current Behavior (Graceful Degradation)

- ✅ No crashes
- ✅ Patterns compile successfully
- ✅ Works for non-generic code (99% of cases)
- ❌ Generic helper functions lose compile-time schemas
- ❌ Runtime `derive` must handle untyped form

### Option 2: Implement Call-Site Transformation

Transform at the **call site** where `T` is instantiated:

```typescript
// At call site, we know T = MentionableCharm[]
const mentionable = schemaifyWish<MentionableCharm[]>("#mentionable", []);
//                  ^^^^^^^^^^^^^ Could inline or transform here
```

**Approaches:**

- **Function inlining**: Expand the function body at call sites (complex,
  changes semantics)
- **Deferred transformation**: Mark generic functions, transform their calls in
  a later pass
- **Runtime schema generation**: Generate schemas at runtime using reflection

**Tradeoffs:**

- ✅ Full schema support for generic functions
- ❌ Significantly more complex transformer architecture
- ❌ Potential performance impact
- ❌ May require architectural changes to transformer pipeline

## Recommendation Needed

**Question for review:** Is the current graceful degradation acceptable, or is
schema support for generic helper functions critical enough to warrant the
additional complexity?

**Impact assessment:**

- Current usage of generic helpers with `derive` in codebase: [Unknown - would
  need to audit]
- Risk: Users may not realize schemas aren't being generated in these cases
- Workaround: Users can avoid generic helpers, or add explicit type annotations

## Code Locations

- Fix Part 1: `packages/ts-transformers/src/closures/transformer.ts:2001-2038`
- Fix Part 2: `packages/ts-transformers/src/ast/type-inference.ts:16-18`
- Test case: `packages/patterns/note.tsx:102-112` (schemaifyWish function)
