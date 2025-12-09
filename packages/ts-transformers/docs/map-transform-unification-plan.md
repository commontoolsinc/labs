# Plan: Unifying mapWithPattern Transformation Logic

## Problem Statement

Two parallel fixes address related issues with `.map()` → `.mapWithPattern()`
transformation:

1. **CT-1102 (Gideon's PR)**: `.filter().map()` inside explicit `derive()` fails
   at runtime
2. **fix/frame-mismatch-error-in-map (Berni's PR)**: Nested `.map()` inside
   `mapWithPattern` incorrectly skipped when synthetic `derive` (from
   ternary→ifElse) wraps it

Both stem from the same root cause: **`isInsideDeriveWithOpaqueRef()` uses
imprecise heuristics** to determine if a `.map()` target is a plain JS array at
runtime.

## Current Approaches

### Gideon's Fix (CT-1102)

- **Strategy**: Walk method chains (`.filter()`, `.slice()`, etc.) to find
  origin
- **Logic**: If origin is a derive callback parameter AND there's a method chain
  → skip transformation
- **Limitation**: Doesn't account for mapWithPattern boundaries above the derive

### Berni's Fix (frame-mismatch)

- **Strategy**: Check if we're inside a mapWithPattern callback
- **Logic**: If inside mapWithPattern → always transform (don't let derive check
  skip)
- **Limitation**: Too broad - explicit derives inside mapWithPattern DO unwrap
  their parameters

### The Conflict

```tsx
// Edge case: explicit derive INSIDE mapWithPattern
items.mapWithPattern((item) =>
  derive(
    item.subItems,
    (subs) => subs.filter((s) => s.active).map((s) => s.name),
  )
);
```

- Berni's fix alone: Would transform (mapWithPattern above) → **WRONG** (subs IS
  unwrapped)
- Gideon's fix alone: Would skip (method chain on derive param) → **CORRECT**
- Combined naively: Berni's check runs first, overrides Gideon's → **WRONG**

## Unified Approach: Value-Origin Tracking

### Core Insight

The question isn't "what context am I in?" but "where did this specific value
originate?"

- If the value's root came from `mapWithPattern` params → still opaque →
  **TRANSFORM**
- If the value's root came from `derive` params → unwrapped → **DON'T
  TRANSFORM** (with nuances)

### Algorithm

```
1. Get .map() target expression (e.g., `subs.filter(...)`)
2. Walk method chains to find origin expression (`subs`)
3. Find root identifier of origin
4. Trace root identifier to its defining callback parameter
5. Determine what kind of call that callback belongs to:

   CASE "array-map" (mapWithPattern):
     → Value is still opaque at runtime
     → TRANSFORM to mapWithPattern

   CASE "derive" or "computed":
     → Value is unwrapped at runtime
     → Check for method chain:
       - HAS method chain (.filter/.slice/etc):
         → Result is plain JS array
         → DON'T TRANSFORM
       - NO method chain (direct .map on param):
         → Check Cell vs OpaqueRef:
           - Cell<T[]>: TRANSFORM (Cells need pattern mapping)
           - OpaqueRef<T[]>: DON'T TRANSFORM (unwrapped to plain array)
```

### Why This Works

The key insight is that **the innermost call boundary that defined the value
determines its runtime nature**:

```tsx
// Scenario A: nested map inside mapWithPattern inside synthetic derive
ifElse(cond, derive({items}, ({items}) =>
  items.mapWithPattern((item) =>    // items from derive - but we're mapping ON items
    item.tags.map((tag) => ...)     // item from mapWithPattern → TRANSFORM
  )
))
```

- `item.tags.map()` - root is `item`
- `item` is parameter of mapWithPattern callback
- → mapWithPattern boundary → TRANSFORM ✓

```tsx
// Scenario B: filter-map inside explicit derive
derive(preferences, (prefs) => prefs.filter((p) => p.liked).map((p) => p.name));
```

- `.map()` target is `prefs.filter(...)`
- Origin after walking chain is `prefs`
- `prefs` is parameter of derive callback
- → derive boundary + method chain → DON'T TRANSFORM ✓

```tsx
// Scenario C: explicit derive inside mapWithPattern
items.mapWithPattern((item) =>
  derive(
    item.subItems,
    (subs) => subs.filter((s) => s.active).map((s) => s.name),
  )
);
```

- `.map()` target is `subs.filter(...)`
- Origin after walking chain is `subs`
- `subs` is parameter of derive callback (innermost boundary for this value)
- → derive boundary + method chain → DON'T TRANSFORM ✓

## Implementation Plan

### Phase 1: Refactor `isInsideDeriveWithOpaqueRef`

Replace the current implementation with value-origin tracking:

```typescript
function isInsideDeriveWithOpaqueRef(
  mapCall: ts.CallExpression,
  context: TransformationContext,
): boolean {
  const { checker } = context;

  if (!ts.isPropertyAccessExpression(mapCall.expression)) return false;
  const mapTarget = mapCall.expression.expression;

  // 1. Walk method chains to find origin
  const origin = getMethodChainOrigin(mapTarget);
  const hasMethodChain = origin !== mapTarget;

  // 2. Find root identifier
  const rootId = findRootIdentifier(origin);
  if (!rootId) return false;

  const rootSymbol = checker.getSymbolAtLocation(rootId);
  if (!rootSymbol) return false;

  // 3. Find which callback defined this identifier as a parameter
  const callbackInfo = getDefiningCallbackInfo(rootSymbol, checker);
  if (!callbackInfo) return false;

  // 4. Determine transformation based on callback type
  const { callKind } = callbackInfo;

  if (callKind === "array-map") {
    // Value from mapWithPattern - still opaque
    return false; // Don't skip transformation
  }

  if (callKind === "derive" || callKind === "computed") {
    // Value from derive - unwrapped
    if (hasMethodChain) {
      // Method chain on unwrapped array → plain JS array
      return true; // Skip transformation
    }

    // Direct map on derive param - check Cell vs OpaqueRef
    const targetType = getTypeAtLocationWithFallback(mapTarget, checker, ...);
    if (targetType && isOpaqueRefType(targetType, checker)) {
      const kind = getCellKind(targetType, checker);
      return kind !== "cell"; // Skip for OpaqueRef, transform for Cell
    }
  }

  return false;
}
```

### Phase 2: Helper Functions

#### `getMethodChainOrigin` (already implemented in Gideon's PR)

```typescript
function getMethodChainOrigin(expr: ts.Expression): ts.Expression {
  const arrayMethods = [
    "filter",
    "slice",
    "concat",
    "reverse",
    "sort",
    "flat",
    "flatMap",
  ];
  let current = expr;
  while (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    arrayMethods.includes(current.expression.name.text)
  ) {
    current = current.expression.expression;
  }
  return current;
}
```

#### `findRootIdentifier` (exists in dataflow.ts, may need extraction)

```typescript
function findRootIdentifier(expr: ts.Expression): ts.Identifier | undefined {
  let current = expr;
  while (true) {
    if (ts.isIdentifier(current)) return current;
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isElementAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    // ... handle parenthesized, as expressions, etc.
    return undefined;
  }
}
```

#### `getDefiningCallbackInfo` (new, based on dataflow.ts pattern)

```typescript
interface CallbackInfo {
  callback: ts.FunctionLikeDeclaration;
  callKind: "builder" | "array-map" | "derive" | "computed" | undefined;
}

function getDefiningCallbackInfo(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): CallbackInfo | undefined {
  const declarations = symbol.getDeclarations();
  if (!declarations) return undefined;

  for (const decl of declarations) {
    if (!ts.isParameter(decl)) continue;

    // Find the containing function
    let func: ts.Node | undefined = decl.parent;
    while (func && !ts.isFunctionLike(func)) {
      func = func.parent;
    }
    if (!func) continue;

    // Find the call expression this function is part of
    let callExpr: ts.Node | undefined = func.parent;
    while (callExpr && !ts.isCallExpression(callExpr)) {
      callExpr = callExpr.parent;
    }
    if (!callExpr || !ts.isCallExpression(callExpr)) continue;

    const callKind = detectCallKind(callExpr, checker);
    if (callKind?.kind === "array-map") {
      return {
        callback: func as ts.FunctionLikeDeclaration,
        callKind: "array-map",
      };
    }
    if (callKind?.kind === "derive") {
      return {
        callback: func as ts.FunctionLikeDeclaration,
        callKind: "derive",
      };
    }
    if (callKind?.kind === "builder" && callKind.builderName === "computed") {
      return {
        callback: func as ts.FunctionLikeDeclaration,
        callKind: "computed",
      };
    }
  }

  return undefined;
}
```

### Phase 3: Remove Redundant Code

- Remove `isInsideMapWithPatternCallback` from Berni's PR (subsumed by
  value-origin tracking)
- Remove `isCallbackParameter` from Gideon's PR (replaced by
  `getDefiningCallbackInfo`)
- Keep `getMethodChainOrigin` (still needed)

## Test Cases

### Must Pass (existing)

1. `derive-with-closed-over-opaque-ref-map` - Direct map on OpaqueRef inside
   derive → skip
2. `derive-nested-callback` - Direct map on Cell inside derive → transform
3. `filter-map-chain` - JSX filter-map chain → transform (via synthetic derive
   wrapping)
4. `pattern-nested-jsx-map` (Berni's) - Nested map inside mapWithPattern inside
   ternary → transform
5. `map-ternary-inside-nested-map` (Berni's) - Ternary inside nested map →
   transform

### Must Pass (new)

6. `derive-filter-map-chain` (Gideon's) - filter-map inside explicit derive →
   skip
7. **New edge case**: filter-map inside explicit derive inside mapWithPattern →
   skip

```tsx
// Test case 7: explicit derive inside mapWithPattern with method chain
items.mapWithPattern((item) =>
  derive(
    item.subItems,
    (subs) => subs.filter((s) => s.active).map((s) => s.name), // Should NOT transform
  )
);
```

## Merge Strategy

### Option A: Gideon rebases onto Berni's branch

1. Berni merges his PR first
2. Gideon rebases, resolving conflicts
3. Gideon refactors to unified approach
4. New PR with unified solution

### Option B: Fresh PR with unified approach

1. Create new branch from main
2. Implement unified solution from scratch
3. Add all test cases from both PRs
4. Both original PRs can be closed

### Option C: Collaborative rewrite

1. One person takes lead on implementation
2. Other reviews closely
3. Single PR with co-authors

**Recommendation**: Option B or C - the unified approach is different enough
from both PRs that a fresh implementation may be cleaner than trying to
merge/rebase.

## Key Discovery: Type-Based Approach May Be Simpler

### The Type Checker Can Resolve Synthetic Call Types

During investigation, we discovered that the TypeScript type checker CAN resolve
types for synthetic derive calls created by the transformer. This is because our
synthetic derives have **explicit return type annotations** on the callback:

```typescript
// Synthetic derive created by OpaqueRefJSXTransformer
(__ctHelpers.derive({...}, (): __ctHelpers.OpaqueCell<Assignment[]> & ... => ...))
```

Debug output confirmed:

```
[DEBUG] .map() on "(__ctHelpers.derive({...}...)" (ParenthesizedExpression)
[DEBUG]   checker type: OpaqueCell<Assignment[]> & ...
[DEBUG]   registry type: undefined
```

The checker returns `OpaqueCell<Assignment[]>` even for synthetic nodes!

### The Principled Type-Based Approach

**Core insight**: The type system already encodes the runtime semantics:

1. **Derive callback params**: The derive signature is
   `derive<T>(input: OpaqueRef<T>, fn: (unwrapped: T) => R)`. Inside the
   callback, params have type `T`, NOT `OpaqueRef<T>`.

2. **Method chains preserve types**: `prefs.filter(...)` where `prefs: T[]`
   returns `T[]` (plain array).

3. **Derive results**: `derive(...)` returns `OpaqueRef<R>`.

4. **mapWithPattern callback params**: Params stay opaque (`OpaqueRef<T>`).

**Therefore**: We can simplify to a single type check:

```typescript
function shouldTransformMap(mapCall, context): boolean {
  const mapTarget = mapCall.expression.expression;
  const targetType = getTypeAtLocationWithFallback(mapTarget, ...);

  if (!targetType) return false;

  // Transform iff the target is a cell-like type (has CELL_BRAND)
  return isOpaqueRefType(targetType, context.checker);
}
```

**Why this works for all scenarios:**

| Scenario                                             | Target Type          | isOpaqueRefType | Transform? |
| ---------------------------------------------------- | -------------------- | --------------- | ---------- |
| `state.items.map(...)`                               | `OpaqueCell<Item[]>` | true            | YES        |
| `derive(items, (arr) => arr.map(...))`               | `Item[]` (unwrapped) | false           | NO         |
| `derive(items, (arr) => arr.filter(...).map(...))`   | `Item[]`             | false           | NO         |
| `derive(...).map(...)`                               | `OpaqueCell<R>`      | true            | YES        |
| `items.mapWithPattern((item) => item.tags.map(...))` | `OpaqueCell<Tag[]>`  | true            | YES        |

### Implications

1. **No need for origin tracking**: The type checker already knows whether a
   value is wrapped or unwrapped.

2. **No need for call-kind detection**: We don't need to hard-code "derive",
   "array-map", etc. Just check the type.

3. **No need for `isInsideDeriveCallback`**: The type tells us everything.

4. **Simpler code**: Replace ~200 lines of origin tracking with ~10 lines of
   type checking.

### Remaining Investigation

Need to verify:

1. Does `isOpaqueRefType` correctly return `false` for `(OpaqueCell<T>)[]`
   (array of cells) vs `true` for `OpaqueCell<T[]>` (cell of array)?
2. Are there edge cases where the type checker fails to resolve the type?
3. Does the typeRegistry workaround interfere with this approach?

## Open Questions

1. **Should `findRootIdentifier` be extracted to a shared utility?** It exists
   in dataflow.ts but would be useful in map-strategy.ts.

2. **Are there other call kinds we need to handle?** Currently tracking:
   `array-map`, `derive`, `computed`, `builder`. What about `ifElse`, `action`,
   etc.?

3. **Performance considerations**: The value-origin tracking walks the AST
   multiple times. Is this a concern for large files?

4. **What about non-identifier roots?** E.g.,
   `getItems().filter(...).map(...)` - the origin is a call expression, not an
   identifier. Current approach would return `undefined` and not skip
   transformation. Is this correct?

5. **Can we fully replace origin tracking with type checking?** See "Key
   Discovery" section above.

## References

- Linear issue: CT-1102
- Berni's branch: `fix/frame-mismatch-error-in-map`
- Gideon's branch: `gideon/action-builder` (current)
- Key files:
  - `packages/ts-transformers/src/closures/strategies/map-strategy.ts`
  - `packages/ts-transformers/src/ast/dataflow.ts`
  - `packages/ts-transformers/src/ast/call-kind.ts`
