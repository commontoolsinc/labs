# `.map()` after fallback expression not transformed to `mapWithPattern`

## Summary

When `.map()` is called on an expression that includes a fallback (`|| []` or `?? []`), the `.map()` is not transformed to `mapWithPattern`. This causes runtime errors when the callback accesses variables from outer scopes.

## Repro

```typescript
messages.map((msg) => {
  // Any of these patterns fail:
  const x = computed(() => (msg.reactions) || []);
  {x.map((r) => <button data-id={msg.id}>{r.emoji}</button>)}

  // Or inline:
  {(msg.reactions || []).map((r) => <button data-id={msg.id}>{r.emoji}</button>)}
  {(msg.reactions ?? []).map((r) => <button data-id={msg.id}>{r.emoji}</button>)}
})
```

**Minimal repro file**: `packages/ts-transformers/test/fixtures/pending/computed-var-then-map.input.tsx`

```bash
# See untransformed .map() in output
deno task ct check packages/ts-transformers/test/fixtures/pending/computed-var-then-map.input.tsx --no-run

# Runtime error
deno task ct piece new packages/ts-transformers/test/fixtures/pending/computed-var-then-map.input.tsx \
  -a http://localhost:8000 -s test -i claude.key
```

## Expected

- `.map()` after fallback should be transformed to `.mapWithPattern()`
- Outer scope variables (`msg.id`) should be captured in params

## Actual

- Fallback becomes: `derive({ msg }, ({ msg }) => msg.reactions || [])`
- But `.map()` on that result stays as plain `.map()`
- Runtime error: `"Cell with parent cell not found in current frame. Likely a closure that should have been transformed."`

## Root Cause

In `map-strategy.ts`, the checks for whether `.map()` needs transformation both fail:

1. **`isDeriveCall(target)`** — Only detects *direct* `derive()` call expressions, not identifiers or complex expressions that evaluate to derive results

2. **`isOpaqueRefType(targetType)`** — The type registry stores the *unwrapped* callback return type (`Reaction[] | never[]`), not `OpaqueRef<T>`. So the type check fails.

The `|| []` fallback expression gets wrapped in a derive by the transformer, but the resulting `.map()` call doesn't recognize its target as needing transformation.

## Current Status

**Compile-time error added**: The `PatternContextValidationTransformer` now detects this pattern and reports an error:
```
'.map()' on fallback expression with mixed reactive/non-reactive types is not supported.
Use direct property access: 'x.map(...)' rather than '(x ?? fallback).map(...)'
```

This prevents the silent runtime failure and guides users to the workaround.

## Workaround

Use direct property access without fallback:

```typescript
// Works - msg.reactions is recognized as OpaqueRef<Reaction[]>
{msg.reactions.map((r) => <button data-id={msg.id}>{r.emoji}</button>)}
```

This requires making the property non-optional and ensuring it's always an array.

## Potential Future Fixes

To actually support this pattern (rather than just erroring), these approaches could work:

1. **Track derive result identifiers**: When a variable is assigned from a derive call, mark it so `isDeriveCall()` can recognize the identifier

2. **Store OpaqueRef type in registry**: Instead of storing the unwrapped callback return type, store `OpaqueRef<T>` so `isOpaqueRefType()` works

3. **Check parent expression**: When `.map()` target is a complex expression involving `||` or `??`, check if either operand is an opaque type
