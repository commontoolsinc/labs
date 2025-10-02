# Closure Transformation Design

_Created: 2025-09-24_ _Updated: 2025-10-02_ _Status: Fully Implemented for OpaqueRef/Cell Map Callbacks_

## Overview

This document captures the design and implementation strategy for adding closure
support to the CommonTools TypeScript transformer. The goal is to transform
map callbacks on **OpaqueRef arrays** that capture variables from outer scopes
into CommonTools-compatible patterns using the `recipe` + params pattern.

## Problem Statement

Map callbacks on OpaqueRef arrays that capture variables from outer scope need to be transformed to pass those values as parameters:

```typescript
// Problem: state.discount is captured but needs to be parameterized
// where state.items has type OpaqueRef<Item[]>
state.items.map((item) => item.price * state.discount)

// Solution: Pass captured values as params
state.items.map(
  recipe(({ elem, params: { discount } }) => elem.price * discount),
  { discount: state.discount }
)
```

## Design Principles

1. **Standalone Transformer**: Closure transformation is orthogonal to reactivity
2. **Run First**: Operates on clean, untransformed AST before other transformations
3. **Simple Scope Detection**: Leverage TypeScript's symbol table + node identity
4. **Reactive Arrays Only**: Transform map calls on `OpaqueRef<T[]>` and `Cell<T[]>`, not plain `T[]`
5. **Capture All Variables**: Detect and parameterize ALL captured variables (not just OpaqueRef/Cell ones)
6. **Clear Separation**: Closure transformer is independent of opaque-ref transformer
7. **Robust Type Checking**: Use `isOpaqueRefType()` from `opaque-ref/types.ts` - handles type aliases, unions, intersections, and verifies import source

## Architecture (FULLY IMPLEMENTED)

### Transformer Pipeline

```
Original Source
     ↓
[Closure Transformer] ← Transforms OpaqueRef<T[]>.map() callbacks with captures
     ↓
[OpaqueRef Transformer] ← Wraps reactive expressions in derive()
     ↓
[Schema Transformer] ← Generates JSON schemas
     ↓
Final Output
```

**Key Insight**: Each transformer operates on the output of the previous one, creating a new AST. However, TypeChecker always references the original source AST.

### Component Architecture

1. **Closure Transformer** (`src/closures/transformer.ts`)
   - Standalone transformer independent of opaque-ref
   - Transforms map callbacks on `OpaqueRef<T[]>` that have captures
   - Does NOT transform `Cell<T[]>.map()` or plain `T[].map()`
   - Runs FIRST in the pipeline
   - Self-contained: manages own import injection

2. **Test Infrastructure** (`test/utils.ts`)
   - Uses unified `commonTypeScriptTransformer`
   - All transformers run in correct order automatically
   - No need for per-test transformer configuration

3. **Pipeline Configuration** (`src/transform.ts`)
   ```typescript
   export function commonTypeScriptTransformer(program: ts.Program) {
     return [
       createClosureTransformer(program),      // FIRST: handle closures
       createModularOpaqueRefTransformer(...), // THEN: handle reactivity
       createSchemaTransformer(...),           // FINALLY: schemas
     ];
   }
   ```

## Capture Detection (FULLY IMPLEMENTED)

### The Node Identity Approach

Because the closure transformer runs FIRST on the untransformed AST, we can use **simple node identity checks** to detect captures:

```typescript
function isDeclaredWithinCallback(
  decl: ts.Declaration,
  func: ts.FunctionLikeDeclaration
): boolean {
  let current: ts.Node | undefined = decl;

  while (current) {
    // Direct node identity comparison works!
    if (current === func) return true;

    // Stop at function boundaries
    if (current !== decl && ts.isFunctionLike(current)) return false;

    current = current.parent;
  }

  return false;
}
```

**Why This Works**:
- Closure transformer runs on original AST
- TypeChecker built from original program
- Both reference the same AST nodes
- Node identity (`===`) reliably works

**Contrast with Later Transformers**:
- OpaqueRef transformer sees closure-transformed AST
- TypeChecker still references original AST
- Node identity would fail
- Must use other techniques (e.g., TypeRegistry for passing Type information forward)

### Capture Collection Algorithm

1. Walk the callback body visiting all nodes
2. For each identifier or property access:
   - Get symbol from TypeChecker
   - Get declarations for that symbol
   - Check if ANY declaration is outside the callback (using node identity)
   - If yes, capture it
3. Special cases handled:
   - JSX element tag names (skip)
   - JSX attribute names (skip)
   - Property names in property access (skip - we capture the whole expression)
   - Callback's own parameters (inside callback, not captured)

**Important**: We capture ALL variables (reactive and non-reactive, OpaqueRef and plain) because they all need to be accessible in the transformed callback. The closure transformer is only invoked for `OpaqueRef<T[]>.map()` calls, but once we're transforming such a call, we capture ALL closed-over variables, not just reactive ones.

## Transformation Pattern

### Input
```typescript
// state.items has type OpaqueRef<Item[]>
state.items.map((item, index) => item.price * state.discount + state.tax)
```

### Output
```typescript
state.items.map(
  recipe(({ elem, index, params: { discount, tax } }) =>
    elem.price * discount + tax
  ),
  { discount: state.discount, tax: state.tax }
)
```

**Note**: Plain arrays are NOT transformed:
```typescript
// [1, 2, 3] is a plain number[] - NOT transformed
[1, 2, 3].map(n => n * multiplier)  // Left as-is
```

### Transformation Steps

1. **Detect**: Find map calls on `OpaqueRef<T[]>` with callbacks that have captures
2. **Collect**: Gather all captured expressions (both reactive and non-reactive)
3. **Build params**: Create `{ discount: state.discount, tax: state.tax }`
4. **Transform callback**:
   - Original param `item` → `elem`
   - Keep `index` if present
   - Add `params: { discount, tax }` destructuring
5. **Replace captures**: Replace `state.discount` → `discount` in body
6. **Wrap**: Wrap callback in `recipe(...)`
7. **Rewrite call**: `map(recipe(...), params)`
8. **Add import**: Ensure `recipe` is imported from `commontools`

## Edge Cases Handled

### Nested Property Access
```typescript
// state.items has type OpaqueRef<Item[]>
// Captures state.user.name as a whole
state.items.map(item => item.id + state.user.name)

// Transforms to
state.items.map(
  recipe(({ elem, params: { name } }) => elem.id + name),
  { name: state.user.name }
)
```

### Multiple Captures (All Types)
```typescript
// state.items has type OpaqueRef<Item[]>
// Captures both OpaqueRef values (state.discount) and plain values (multiplier)
const multiplier = 2;
state.items.map(item => item.price * state.discount * multiplier)

// Transforms to
state.items.map(
  recipe(({ elem, params: { discount, multiplier } }) =>
    elem.price * discount * multiplier
  ),
  { discount: state.discount, multiplier }
)
```

### JSX in Callbacks
```typescript
// state.items has type OpaqueRef<Item[]>
// JSX elements and attributes NOT captured
state.items.map(item => <li key={item.id}>{item.name}</li>)
```

### Variables Declared Inside Callback
```typescript
// state.items has type OpaqueRef<Item[]>
// Local variables NOT captured
state.items.map(item => {
  const local = item.price * 2;
  return local + state.tax;  // Only state.tax is captured
})
```

### Plain Arrays Not Transformed
```typescript
// Plain array - NOT transformed, even with captures
const items = [1, 2, 3];
const multiplier = 10;
items.map(n => n * multiplier)  // Left as-is, no transformation
```

## Testing Strategy

### Fixture-Based Tests

Following existing patterns, we use fixture pairs:

```
test/fixtures/closures/
├── map-single-capture.input.tsx
├── map-single-capture.expected.tsx
└── ...
```

Configuration in `test/fixture-based.test.ts`:
```typescript
{
  directory: "closures",
  describe: "Closure Transformation",
  formatTestName: (name) => `transforms ${name.replace(/-/g, " ")}`,
  groups: [
    { pattern: /^map-/, name: "Map callbacks" },
  ],
}
```

### Test Coverage

- ✅ Single captured variable
- ✅ Multiple captured variables
- ✅ Nested property access (state.discount)
- ✅ Mixed with reactive expressions
- ✅ JSX in callbacks
- ✅ Variables declared inside callback

## Architectural Insights

### TypeChecker vs. Transformed AST

**Critical Understanding**:

1. **TypeChecker is built once** from the original source program
2. **Transformers create new ASTs** sequentially
3. **TypeChecker always references the original AST**

**Implications**:

- **First transformer** (Closure): Can use TypeChecker + node identity ✓
- **Later transformers** (OpaqueRef, Schema): TypeChecker gives original nodes, but transformer works with transformed nodes - node identity fails ✗

**Solution for Later Transformers**: Use TypeRegistry pattern to pass Type information forward through side-channel.

### Why Closure Runs First

1. **Needs clean AST**: Capture detection requires untransformed, original AST
2. **Node identity works**: Can directly compare TypeChecker nodes with current nodes
3. **Semantic priority**: Closure transformation changes the callback structure; reactivity wrapping happens within that structure
4. **Simplicity**: Operating on original AST is simpler and more reliable

### TypeRegistry Pattern

The TypeRegistry (used by Schema transformer) is a **side-channel** for passing Type information:

```typescript
// When creating synthetic nodes:
typeRegistry.set(syntheticNode, originalType);

// Later transformers can look up:
const type = typeRegistry.get(node) || checker.getTypeFromTypeNode(node);
```

**Note for Future Work**: Consider whether the opaque-ref transformer should adopt a similar pattern for other information that needs to flow through the pipeline. This would allow later transformers to access information about transformed nodes that TypeChecker can't provide.

## Future Extensions

### Phase 2: Event Handler Support
Transform event handlers with captures:
```typescript
<button onClick={() => state.count++}>
// →
<button onClick={handler((_, {count}) => count.set(count.get() + 1), {count: state.count})}>
```

### Phase 3: Generic Closure Support
Transform arbitrary closures:
```typescript
const compute = () => state.a + state.b;
// →
const compute = lift(({a, b}) => a + b).curry({a: state.a, b: state.b});
```

## Success Metrics

✅ **Phase 1 (Map Callbacks) - COMPLETE**:
- Map callbacks with captures transform correctly
- All fixture tests pass
- No regression in existing transformations
- Clean architectural separation

## Open Questions

1. **Performance**: Should we cache capture analysis results?
2. **Type Safety**: How do we ensure transformed code maintains type correctness?
3. **Runtime Support**: Verify runtime supports curry pattern for generic closures
4. **Source Maps**: How to preserve debugging experience through transformations?

## Type Checking Implementation

### OpaqueRef Structure

`OpaqueRef<T>` has a complex structure that affects type checking:

```typescript
export type OpaqueRef<T> = OpaqueRefMethods<T> & 
  (T extends Array<infer U> ? Array<OpaqueRef<U>> : ...);
```

This means `OpaqueRef<number[]>` is **BOTH**:
1. `OpaqueRefMethods<number[]>` (with `.map()` method returning `Opaque<S[]>`)
2. `Array<OpaqueRef<number>>` (array-like with bracket access and Array.prototype methods)

### Type Checking Strategy

**isOpaqueRefArrayMapCall()** must check:
1. Is target an OpaqueRef or Cell? → Use `isOpaqueRefType(targetType, checker)`
2. Is the type argument an array? → Use `hasArrayTypeArgument(targetType, checker)`

Both functions handle **unions and intersections** recursively, mirroring the structure of `isOpaqueRefType()`.

**Why not string matching?**
- ❌ Doesn't handle type aliases: `type MyArray = OpaqueRef<T[]>` → might show as `"MyArray"`
- ❌ Fragile to formatting changes
- ❌ Doesn't verify import source
- ✅ Use proper TypeScript symbol resolution instead

### Method Chain Challenge

**Problem:** `state.items.filter(...).map(...)`

```typescript
state.items                            // OpaqueRef<number[]>
state.items.filter(x => x > threshold) // OpaqueRef<number>[] (Array.prototype.filter)
```

When closure transformer runs (BEFORE JSX transformer), it sees `OpaqueRef<number>[]` and skips.
Then JSX transformer wraps filter in derive:

```typescript
derive(...).map(...)  // derive returns OpaqueRef<number[]> ✅
```

But closure transformer already ran! ❌

**Solution (HACK):**
In `isOpaqueRefArrayMapCall()`, detect any array method chain before `.map()`:
- Walk back through the property access chain from the map call
- Look for any array-returning method: `filter`, `slice`, `concat`, `reverse`, `sort`, `flat`, `flatMap`
- Check if the ultimate origin is `OpaqueRef<T[]>` or `Cell<T[]>` with array type argument
- If yes, transform the map callback (even though immediate type might be `OpaqueRef<U>[]`)

This works because we know JSX transformer will wrap intermediate calls in derive, producing correct types.

**Array methods to check for:**
- `filter(fn)` → returns filtered array
- `slice(start, end?)` → returns subarray
- `concat(...arrays)` → returns combined array
- `reverse()` → returns reversed array
- `sort(fn?)` → returns sorted array
- `flat(depth?)` → returns flattened array
- `flatMap(fn)` → returns mapped+flattened array

**Implementation (COMPLETE):**
The pattern detection walker is implemented in `isOpaqueRefArrayMapCall()` in `src/closures/transformer.ts`. It walks back through the call chain, detecting any array methods before `.map()`, and checks if the ultimate origin is `OpaqueRef<T[]>` or `Cell<T[]>`.

