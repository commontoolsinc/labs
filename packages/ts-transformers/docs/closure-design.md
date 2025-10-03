# Closure Transformation Design

_Created: 2025-09-24_ _Updated: 2025-10-02_ _Status: Fully Implemented for
OpaqueRef/Cell Map Callbacks with Selective Capture_

## Overview

This document captures the design and implementation strategy for adding closure
support to the CommonTools TypeScript transformer. The goal is to transform map
callbacks on **OpaqueRef arrays** that capture variables from outer scopes into
CommonTools-compatible patterns using the `recipe` + params pattern.

## Problem Statement

Map callbacks on OpaqueRef arrays that capture variables from outer scope need
to be transformed to pass those values as parameters:

```typescript
// Problem: state.discount is captured but needs to be parameterized
// where state.items has type OpaqueRef<Item[]>
state.items.map((item) => item.price * state.discount);

// Solution: Pass captured values as params
state.items.map(
  recipe(({ elem, params: { discount } }) => elem.price * discount),
  { discount: state.discount },
);
```

## Design Principles

1. **Standalone Transformer**: Closure transformation is orthogonal to
   reactivity
2. **Run First**: Operates on clean, untransformed AST before other
   transformations
3. **Simple Scope Detection**: Leverage TypeScript's symbol table + node
   identity
4. **Reactive Arrays Only**: Transform map calls on `OpaqueRef<T[]>` and
   `Cell<T[]>`, not plain `T[]`
5. **Selective Variable Capture**: Capture variables from outer scope, but NOT:
   - Module-scoped declarations (top-level constants/functions)
   - Function declarations (including handlers, lift(), etc.)
   - Global built-ins (Promise, Math, etc.)
6. **Parent Scope Capture**: DO capture from parent callback scope (nested maps)
7. **Clear Separation**: Closure transformer is independent of opaque-ref
   transformer
8. **Robust Type Checking**: Use `isOpaqueRefType()` from
   `opaque-ref/types.ts` - handles type aliases, unions, intersections, and
   verifies import source

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

**Key Insight**: Each transformer operates on the output of the previous one,
creating a new AST. However, TypeChecker always references the original source
AST.

### Component Architecture

1. **Closure Transformer** (`src/closures/transformer.ts`)
   - Standalone transformer independent of opaque-ref
   - Transforms map callbacks on `OpaqueRef<T[]>` and `Cell<T[]>` that have
     captures
   - Does NOT transform plain `T[].map()`
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

Because the closure transformer runs FIRST on the untransformed AST, we can use
**simple node identity checks** to detect captures:

```typescript
function isDeclaredWithinCallback(
  decl: ts.Declaration,
  func: ts.FunctionLikeDeclaration,
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
- Must use other techniques (e.g., TypeRegistry for passing Type information
  forward)

### Capture Collection Algorithm

1. Walk the callback body visiting all nodes
2. For each identifier or property access:
   - Get symbol from TypeChecker
   - Get declarations for that symbol
   - Check if ANY declaration is outside the callback (using node identity)
   - **Filter out module-scoped declarations** (walk up to SourceFile parent)
   - **Filter out function declarations** (including handlers, CallExpressions)
   - If still a valid capture, add it
3. Special cases handled:
   - JSX element tag names (skip)
   - JSX attribute names (skip)
   - Property names in property access (skip - we capture the whole expression)
   - Callback's own parameters (inside callback, not captured)
   - Module-level constants and functions (not captured)
   - Handlers and function calls (not captured - can't serialize)

**Important**: We capture variables from outer scopes (reactive and
non-reactive, OpaqueRef and plain) but specifically exclude:

- **Module-scoped**: `const TAX_RATE = 0.08` at top level
- **Functions**: `function formatPrice()` or `const handler = handler(...)`
- **Globals**: Built-in JavaScript globals

This ensures we only capture serializable values that represent actual closure
state, not module-level utilities or function references.

## Transformation Pattern

### Input

```typescript
// state.items has type OpaqueRef<Item[]>
state.items.map((item, index) => item.price * state.discount + state.tax);
```

### Output

```typescript
state.items.map(
  recipe(({ elem, index, params: { discount, tax } }) =>
    elem.price * discount + tax
  ),
  { discount: state.discount, tax: state.tax },
);
```

**Note**: Plain arrays are NOT transformed:

```typescript
// [1, 2, 3] is a plain number[] - NOT transformed
[1, 2, 3].map((n) => n * multiplier); // Left as-is
```

### Transformation Steps

1. **Detect**: Find map calls on `OpaqueRef<T[]>` with callbacks that have
   captures
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
state.items.map((item) => item.id + state.user.name);

// Transforms to
state.items.map(
  recipe(({ elem, params: { name } }) => elem.id + name),
  { name: state.user.name },
);
```

### Multiple Captures (Filtered)

```typescript
// state.items has type OpaqueRef<Item[]>
// Captures state.discount but NOT multiplier (module-scoped)
const multiplier = 2; // Module-scoped constant - NOT captured
state.items.map((item) => item.price * state.discount * multiplier);

// Transforms to
state.items.map(
  recipe(({ elem, params: { discount } }) => elem.price * discount * multiplier // multiplier used directly
  ),
  { discount: state.discount },
);
```

### Module-Scoped Not Captured

```typescript
// Module-level constant and function - NOT captured
const TAX_RATE = 0.08;
function formatPrice(price: number): string {
  return `$${price.toFixed(2)}`;
}

state.items.map((item) => formatPrice(item.price * (1 + TAX_RATE)));

// No transformation - no captures!
// formatPrice and TAX_RATE are available in module scope
```

### Handlers Not Captured

```typescript
// Handler function - NOT captured
const handleClick = handler((_, { count }) => count.set(count.get() + 1));

state.items.map((item) => (
  <ct-button onClick={handleClick({ count: state.count })}>
    {item.name}
  </ct-button>
));

// Transforms to capture state.count but NOT handleClick
state.items.map(
  recipe(({ elem, params: { count } }) => (
    <ct-button onClick={handleClick({ count })}>
      {elem.name}
    </ct-button>
  )),
  { count: state.count },
);
```

### Nested Callbacks (Parent Scope Capture)

```typescript
// Inner callback DOES capture from outer callback
state.items.map((item) => (
  <div>
    {item.tags.map((tag) => (
      <li>{item.name} - {tag.name}</li>  // item.name is captured!
    ))}
  </div>
));

// Transforms to nested recipe with parent scope capture
state.items.map(recipe(({ elem, params: { prefix } }) => (
  <div>
    {prefix}: {elem.name}
    <ul>
      {elem.tags.map(recipe(({ elem, params: { name } }) => (
        <li>{name} - {elem.name}</li>
      )), { name: elem.name })}  // Captures item.name from parent callback
    </ul>
  </div>
)), { prefix: state.prefix }));
```

### JSX in Callbacks

```typescript
// state.items has type OpaqueRef<Item[]>
// JSX elements and attributes NOT captured
state.items.map((item) => <li key={item.id}>{item.name}</li>);
```

### Variables Declared Inside Callback

```typescript
// state.items has type OpaqueRef<Item[]>
// Local variables NOT captured
state.items.map((item) => {
  const local = item.price * 2;
  return local + state.tax; // Only state.tax is captured
});
```

### Plain Arrays Not Transformed

```typescript
// Plain array - NOT transformed, even with captures
const items = [1, 2, 3];
const multiplier = 10;
items.map((n) => n * multiplier); // Left as-is, no transformation
```

## Capture Filtering Implementation

### Module-Scoped Detection

Module-scoped declarations (top-level constants and functions) should NOT be
captured because they're globally available within the module:

```typescript
function isModuleScopedDeclaration(decl: ts.Declaration): boolean {
  let parent = decl.parent;

  // For variable declarations, walk up through VariableDeclarationList
  if (ts.isVariableDeclaration(decl)) {
    // VariableDeclaration → VariableDeclarationList → VariableStatement → SourceFile
    parent = parent?.parent?.parent;
  } else if (ts.isFunctionDeclaration(decl)) {
    // FunctionDeclaration → SourceFile
    parent = parent;
  }

  return parent ? ts.isSourceFile(parent) : false;
}
```

### Function Declaration Detection

Functions (including handlers) cannot be serialized and should NOT be captured:

```typescript
function isFunctionDeclaration(decl: ts.Declaration): boolean {
  // Direct function declarations
  if (ts.isFunctionDeclaration(decl)) {
    return true;
  }

  // Arrow functions or function expressions assigned to variables
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = decl.initializer;
    if (
      ts.isArrowFunction(init) ||
      ts.isFunctionExpression(init) ||
      ts.isCallExpression(init) // Includes handler(), lift(), etc.
    ) {
      return true;
    }
  }

  return false;
}
```

### Nested Callback Transformation Order

Critical insight: Nested callbacks must be transformed BEFORE parameter
replacement in the outer callback:

```typescript
// WRONG ORDER: Transform params first, then nested callbacks
// Problem: Inner callback can't detect captures from outer callback
//          because "item" is already renamed to "elem"

// CORRECT ORDER: Transform nested callbacks FIRST
function transformMapCallback(...) {
  // 1. First, transform any nested map callbacks (before touching params!)
  const nestedVisitor: ts.Visitor = (node) => {
    if (isNestedMapCall(node)) {
      return transformMapCallback(node, ...); // Recursive!
    }
    return ts.visitEachChild(node, nestedVisitor, context);
  };
  transformedBody = ts.visitNode(transformedBody, nestedVisitor);

  // 2. NOW transform this callback's parameters
  //    Nested callbacks are already transformed, so they won't be affected
  const paramReplacer: ts.Visitor = (node) => {
    // Replace "item" with "elem" throughout
  };
  transformedBody = ts.visitNode(transformedBody, paramReplacer);
}
```

This ensures nested callbacks can detect captures from parent callback scope
before those identifiers are renamed.

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

All 70 fixture tests passing, including:

**Map Callback Tests (14 tests)**:

- ✅ Single captured variable
- ✅ Multiple captured variables (selective)
- ✅ Module-scoped constants (NOT captured)
- ✅ Module-scoped functions (NOT captured)
- ✅ Handler references (NOT captured)
- ✅ Nested callbacks (parent scope captured)
- ✅ Nested property access (state.discount)
- ✅ Mixed with reactive expressions
- ✅ JSX in callbacks
- ✅ Variables declared inside callback (not captured)
- ✅ Block body with local variables
- ✅ Index parameter preservation
- ✅ Destructured parameters
- ✅ Template literals, conditional expressions, type assertions

## Architectural Insights

### TypeChecker vs. Transformed AST

**Critical Understanding**:

1. **TypeChecker is built once** from the original source program
2. **Transformers create new ASTs** sequentially
3. **TypeChecker always references the original AST**

**Implications**:

- **First transformer** (Closure): Can use TypeChecker + node identity ✓
- **Later transformers** (OpaqueRef, Schema): TypeChecker gives original nodes,
  but transformer works with transformed nodes - node identity fails ✗

**Solution for Later Transformers**: Use TypeRegistry pattern to pass Type
information forward through side-channel.

### Why Closure Runs First

1. **Needs clean AST**: Capture detection requires untransformed, original AST
2. **Node identity works**: Can directly compare TypeChecker nodes with current
   nodes
3. **Semantic priority**: Closure transformation changes the callback structure;
   reactivity wrapping happens within that structure
4. **Simplicity**: Operating on original AST is simpler and more reliable

### TypeRegistry Pattern

The TypeRegistry (used by Schema transformer) is a **side-channel** for passing
Type information:

```typescript
// When creating synthetic nodes:
typeRegistry.set(syntheticNode, originalType);

// Later transformers can look up:
const type = typeRegistry.get(node) || checker.getTypeFromTypeNode(node);
```

**Note for Future Work**: Consider whether the opaque-ref transformer should
adopt a similar pattern for other information that needs to flow through the
pipeline. This would allow later transformers to access information about
transformed nodes that TypeChecker can't provide.

## Runtime Integration: map_with_pattern

### Motivation

To provide clear compile-time errors when the transformer emits incorrect transformations, we introduce a new `map_with_pattern` method (patterns = recipes) instead of overloading the existing `map` method. This ensures:

1. **Type safety**: Wrong transformations fail at compile time, not runtime
2. **Clear distinction**: Explicit separation between regular map and closure-transformed map
3. **Debugging**: Easy to identify which map variant is being used

### Implementation

**OpaqueRef/Cell method** (`opaque-ref.ts`):
```typescript
map_with_pattern: <S>(
  op: Recipe,  // Already wrapped by transformer
  params: Record<string, any>,  // Captured variables
) => {
  mapWithPatternFactory ||= createNodeFactory({
    type: "ref",
    implementation: "map_with_pattern",
  });
  return mapWithPatternFactory({
    list: proxy,
    op: op,  // Don't wrap - already a recipe!
    params: params,
  });
}
```

**Runtime builtin** (`map_with_pattern.ts`):
- Similar to `map.ts` but accepts `params` in schema
- Schema:
  ```typescript
  {
    list: { type: "array", items: { asCell: true } },
    op: { asCell: true },
    params: { type: "object" },  // New!
  }
  ```
- Passes to recipe: `{ elem, index, params: inputsCell.key("params") }`
- No recipe wrapping (already wrapped by transformer)

**Transformer output**:
```typescript
// Before (Phase 1 - incorrect):
state.items.map(recipe(({ elem, params: { discount } }) => ...), { discount: state.discount })

// After (Phase 1.5 - correct):
state.items.map_with_pattern(
  recipe(({ elem, params: { discount } }) => ...),
  { discount: state.discount }
)
```

### Key Differences from Regular map

| Aspect | `map()` | `map_with_pattern()` |
|--------|---------|---------------------|
| Recipe wrapping | Wraps callback in recipe | Receives pre-wrapped recipe |
| Parameters | `{ element, index, array }` | `{ elem, index, params }` |
| Params argument | No params | Accepts params object |
| Use case | Normal mapping | Closure-transformed mapping |

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
const compute = lift(({ a, b }) => a + b).curry({ a: state.a, b: state.b });
```

## Success Metrics

✅ **Phase 1 (Map Callbacks) - COMPLETE**:

- Map callbacks with captures transform correctly
- All fixture tests pass
- No regression in existing transformations
- Clean architectural separation

## Open Questions

1. **Performance**: Should we cache capture analysis results?
2. **Type Safety**: How do we ensure transformed code maintains type
   correctness?
3. **Runtime Support**: Verify runtime supports curry pattern for generic
   closures
4. **Source Maps**: How to preserve debugging experience through
   transformations?

## Type Checking Implementation

### OpaqueRef Structure

`OpaqueRef<T>` has a complex structure that affects type checking:

```typescript
export type OpaqueRef<T> = OpaqueRefMethods<T> & 
  (T extends Array<infer U> ? Array<OpaqueRef<U>> : ...);
```

This means `OpaqueRef<number[]>` is **BOTH**:

1. `OpaqueRefMethods<number[]>` (with `.map()` method returning `Opaque<S[]>`)
2. `Array<OpaqueRef<number>>` (array-like with bracket access and
   Array.prototype methods)

### Type Checking Strategy

**isOpaqueRefArrayMapCall()** must check:

1. Is target an OpaqueRef or Cell? → Use `isOpaqueRefType(targetType, checker)`
2. Is the type argument an array? → Use
   `hasArrayTypeArgument(targetType, checker)`

Both functions handle **unions and intersections** recursively, mirroring the
structure of `isOpaqueRefType()`.

**Why not string matching?**

- ❌ Doesn't handle type aliases: `type MyArray = OpaqueRef<T[]>` → might show
  as `"MyArray"`
- ❌ Fragile to formatting changes
- ❌ Doesn't verify import source
- ✅ Use proper TypeScript symbol resolution instead

### Method Chain Challenge

**Problem:** `state.items.filter(...).map(...)`

```typescript
state.items; // OpaqueRef<number[]>
state.items.filter((x) => x > threshold); // OpaqueRef<number>[] (Array.prototype.filter)
```

When closure transformer runs (BEFORE JSX transformer), it sees
`OpaqueRef<number>[]` and skips. Then JSX transformer wraps filter in derive:

```typescript
derive(...).map(...)  // derive returns OpaqueRef<number[]> ✅
```

But closure transformer already ran! ❌

**Solution (HACK):** In `isOpaqueRefArrayMapCall()`, detect any array method
chain before `.map()`:

- Walk back through the property access chain from the map call
- Look for any array-returning method: `filter`, `slice`, `concat`, `reverse`,
  `sort`, `flat`, `flatMap`
- Check if the ultimate origin is `OpaqueRef<T[]>` or `Cell<T[]>` with array
  type argument
- If yes, transform the map callback (even though immediate type might be
  `OpaqueRef<U>[]`)

This works because we know JSX transformer will wrap intermediate calls in
derive, producing correct types.

**Array methods to check for:**

- `filter(fn)` → returns filtered array
- `slice(start, end?)` → returns subarray
- `concat(...arrays)` → returns combined array
- `reverse()` → returns reversed array
- `sort(fn?)` → returns sorted array
- `flat(depth?)` → returns flattened array
- `flatMap(fn)` → returns mapped+flattened array

**Implementation (COMPLETE):** The pattern detection walker is implemented in
`isOpaqueRefArrayMapCall()` in `src/closures/transformer.ts`. It walks back
through the call chain, detecting any array methods before `.map()`, and checks
if the ultimate origin is `OpaqueRef<T[]>` or `Cell<T[]>`.
