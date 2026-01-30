# Selective OpaqueRef Transformations in Safe Wrapper Contexts

## Problem Statement

The `OpaqueRefJSXTransformer` currently skips ALL JSX transformation when inside
a "safe callback wrapper" (action, handler, computed, derive, lift, inline JSX
event handlers, standalone functions). This blanket skip was intended to mean
"opaque reading is allowed here", but it inadvertently skips transformations
that are still semantically required.

### The Bug

```tsx
// Inside a handler callback:
handler<Event, State>((event, state) => {
  return (
    <div>
      {computed(() => showPanel) && <Panel />}
    </div>
  );
});
```

Currently, this code is NOT transformed because we're inside a handler (safe
context). But the `&&` expression evaluates `computed()` which returns an
`OpaqueRef` object - and objects are always truthy in JavaScript! So `<Panel />`
always renders regardless of the actual value.

**Expected behavior:** Transform `computed() && <Panel />` to
`when(computed(), <Panel />)` which properly checks the reactive value.

### Root Cause

In `opaque-ref-jsx.ts` line 39:

```typescript
if (isInsideSafeCallbackWrapper(node, checker)) {
  return visitEachChildWithJsx(node, visit, context.tsContext);
}
```

This early return skips the entire `rewriteExpression` pipeline, including the
`when()`/`unless()` transformations that ARE still needed.

## Background: What the Emitters Do

The `rewriteExpression` function runs these emitters in order:

| Emitter                       | What it does                                | Creates `derive()`? |
| ----------------------------- | ------------------------------------------- | ------------------- |
| `emitPropertyAccess`          | Wraps `obj.prop` chains                     | Yes                 |
| `emitBinaryExpression`        | `&&` → `when()`, `                          |                     |
| `emitCallExpression`          | Handles array-map, ifElse predicates        | Yes (fallback)      |
| `emitTemplateExpression`      | Wraps template literals                     | Yes                 |
| `emitConditionalExpression`   | Wraps ternary `a ? b : c`                   | Yes                 |
| `emitElementAccessExpression` | Wraps `array[index]`                        | Yes                 |
| `emitPrefixUnaryExpression`   | Wraps `!condition`                          | Yes                 |
| `emitContainerExpression`     | Wraps arrays/objects with reactive elements | Yes                 |

## Design: Selective Transformation via Context Flag

### Approach

Pass a context flag to `rewriteExpression` indicating whether we're in a "safe
context". Emitters check this flag to decide whether to emit `derive()`
wrappers.

### What Should Transform in Safe Contexts

| Transformation                    | In Safe Context? | Reason                                         |
| --------------------------------- | ---------------- | ---------------------------------------------- |
| `&&` → `when()`                   | **YES**          | OpaqueRef is truthy; need proper short-circuit |
| `                                 |                  | `→`unless()`                                   |
| `ifElse()` predicate → `derive()` | **YES**          | Predicates need reactive tracking              |
| Property access → `derive()`      | **NO**           | Already in reactive context                    |
| Template literal → `derive()`     | **NO**           | Already in reactive context                    |
| Ternary → `derive()`              | **NO**           | Already in reactive context                    |
| Unary `!` → `derive()`            | **NO**           | Already in reactive context                    |
| Container → `derive()`            | **NO**           | Already in reactive context                    |

### Key Insight

The `when()`/`unless()` transformations in `emitBinaryExpression` do NOT always
create `derive()` wrappers. They only wrap the condition in `derive()` if it
needs it (i.e., if it's not already a simple opaque ref access). The
transformation itself is:

```typescript
// Before
computed(() => showPanel) && <Panel />;

// After
when(computed(() => showPanel), <Panel />);
```

The `when()` function handles the short-circuit semantics correctly at runtime.

## Implementation Plan

### Step 1: Add `inSafeContext` to EmitterContext

**File:** `src/transformers/opaque-ref/types.ts`

```typescript
export interface EmitterContext {
  // ... existing fields

  /**
   * True when inside a safe callback wrapper (action, handler, computed, etc.)
   * where opaque reading is allowed. In safe contexts, we still need to apply
   * semantic transformations (&&->when, ||->unless) but NOT derive() wrappers.
   */
  inSafeContext: boolean;
}
```

### Step 2: Modify OpaqueRefJSXTransformer

**File:** `src/transformers/opaque-ref-jsx.ts`

Remove the early return for safe contexts. Instead, detect safe context and pass
it through:

```typescript
function transform(context: TransformationContext): ts.SourceFile {
  const checker = context.checker;
  const analyze = createDataFlowAnalyzer(context.checker);

  const visit: ts.Visitor = (node) => {
    if (ts.isJsxExpression(node)) {
      // Skip empty JSX expressions (like JSX comments {/* ... */})
      if (!node.expression) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      if (isEventHandlerJsxAttribute(node)) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      // Detect if we're in a safe context - still transform, but selectively
      const inSafeContext = isInsideSafeCallbackWrapper(node, checker);

      const analysis = analyze(node.expression);

      // Skip if doesn't require rewriting
      if (!analysis.requiresRewrite) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      // In safe contexts, only proceed if we have binary expressions that need when/unless
      // Skip if there's nothing semantic to transform
      if (inSafeContext && !hasBinaryLogicalOperator(node.expression)) {
        return visitEachChildWithJsx(node, visit, context.tsContext);
      }

      if (context.options.mode === "error") {
        // Only report errors for non-safe contexts
        if (!inSafeContext) {
          context.reportDiagnostic({
            type: "opaque-ref:jsx-expression",
            message:
              "JSX expression with OpaqueRef computation should use derive",
            node: node.expression,
          });
        }
        return node;
      }

      const result = rewriteExpression({
        expression: node.expression,
        analysis,
        context,
        analyze,
        inSafeContext, // NEW: pass the flag
      });

      // ... rest unchanged
    }
    // ... rest unchanged
  };
}

// Helper to check if expression contains && or || that might need transformation
function hasBinaryLogicalOperator(expr: ts.Expression): boolean {
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken
    ) {
      return true;
    }
  }
  // Check children
  let found = false;
  expr.forEachChild((child) => {
    if (ts.isExpression(child) && hasBinaryLogicalOperator(child)) {
      found = true;
    }
  });
  return found;
}
```

### Step 3: Update rewriteExpression

**File:** `src/transformers/opaque-ref/rewrite.ts`

Pass `inSafeContext` through to EmitterContext:

```typescript
export function rewriteExpression(
  params: RewriteParams,
): ts.Expression | undefined {
  const emitterContext: EmitterContext = {
    rewriteChildren(node: ts.Expression): ts.Expression {
      return rewriteChildExpressions(
        node,
        params.context,
        params.analyze,
        params.inSafeContext, // Pass through
      );
    },
    ...params,
    inSafeContext: params.inSafeContext ?? false, // NEW
    dataFlows: normalizeDataFlows(
      params.analysis.graph,
      params.analysis.dataFlows,
    ),
  };
  // ... rest unchanged
}
```

### Step 4: Update emitBinaryExpression

**File:** `src/transformers/opaque-ref/emitters/binary-expression.ts`

The `when()`/`unless()` logic stays the same. Only guard the fallback `derive()`
wrap:

```typescript
export const emitBinaryExpression: Emitter = ({
  expression,
  dataFlows,
  analysis,
  context,
  rewriteChildren,
  inSafeContext, // NEW
}) => {
  // ... existing && and || handling unchanged (still emits when/unless)

  // Fallback: wrap entire expression in derive (original behavior)
  // Skip in safe contexts - they don't need derive wrappers
  if (inSafeContext) {
    return undefined;
  }

  const relevantDataFlows = filterRelevantDataFlows(
    dataFlows.all,
    analysis,
    context,
  );
  if (relevantDataFlows.length === 0) return undefined;

  const plan = createBindingPlan(relevantDataFlows);
  return createComputedCallForExpression(expression, plan, context);
};
```

### Step 5: Update Other Emitters

All other emitters only do `derive()` wrapping, so they should early-return in
safe contexts:

**Files:**

- `emitters/property-access.ts`
- `emitters/template-expression.ts`
- `emitters/conditional-expression.ts`
- `emitters/element-access-expression.ts`
- `emitters/prefix-unary-expression.ts`
- `emitters/container-expression.ts`

```typescript
export const emitXxx: Emitter = ({
  // ...
  inSafeContext,
}) => {
  // Skip in safe contexts - derive wrapping not needed
  if (inSafeContext) {
    return undefined;
  }

  // ... existing logic unchanged
};
```

### Step 6: Update emitCallExpression

**File:** `src/transformers/opaque-ref/emitters/call-expression.ts`

The ifElse predicate handling should still work (it wraps predicates, not the
whole expression). Guard only the fallback:

```typescript
export const emitCallExpression: Emitter = ({
  // ...
  inSafeContext,
}) => {
  // ... existing hint handling unchanged

  // Fallback: wrap in derive
  // Skip in safe contexts
  if (inSafeContext) {
    return undefined;
  }

  const relevantDataFlows = filterRelevantDataFlows(/* ... */);
  // ... rest unchanged
};
```

## Test Cases

### New Tests to Add

**File:** `test/opaque-ref-jsx.test.ts` (or new file)

```typescript
describe("OpaqueRefJSXTransformer in safe contexts", () => {
  it("transforms && to when() inside handler callback", () => {
    const input = `
      handler<Event, { show: boolean }>((e, { show }) => {
        return <div>{computed(() => show) && <Panel />}</div>;
      });
    `;
    const expected = `
      handler<Event, { show: boolean }>((e, { show }) => {
        return <div>{when(computed(() => show), <Panel />)}</div>;
      });
    `;
    assertTransform(input, expected);
  });

  it("transforms || to unless() inside action callback", () => {
    const input = `
      action<State>(({ value }) => {
        return <div>{computed(() => value) || <Fallback />}</div>;
      });
    `;
    const expected = `
      action<State>(({ value }) => {
        return <div>{unless(computed(() => value), <Fallback />)}</div>;
      });
    `;
    assertTransform(input, expected);
  });

  it("does NOT wrap property access in derive inside handler", () => {
    const input = `
      handler<Event, { item: Item }>((e, { item }) => {
        return <div>{item.name}</div>;
      });
    `;
    // Should remain unchanged - no derive wrapper added
    const expected = input;
    assertTransform(input, expected);
  });

  it("handles nested && with JSX in safe context", () => {
    const input = `
      handler<Event, State>((e, state) => {
        return <div>{computed(() => a) && computed(() => b) && <Content />}</div>;
      });
    `;
    // Should transform both && to nested when() calls
    assertTransformContains(input, "when(");
  });
});
```

## Migration Notes

This is a **bug fix** - existing code that was incorrectly NOT being transformed
will now be transformed. This could cause:

1. **Runtime behavior changes** - Code that was evaluating OpaqueRef objects as
   truthy will now correctly evaluate their values
2. **Potential new errors** - If code relied on the buggy "always truthy"
   behavior

However, these are correctness improvements, not regressions.

## Files Changed Summary

| File                                                                | Change                                    |
| ------------------------------------------------------------------- | ----------------------------------------- |
| `src/transformers/opaque-ref/types.ts`                              | Add `inSafeContext` to interfaces         |
| `src/transformers/opaque-ref-jsx.ts`                                | Remove early return, pass `inSafeContext` |
| `src/transformers/opaque-ref/rewrite.ts`                            | Pass `inSafeContext` through              |
| `src/transformers/opaque-ref/emitters/binary-expression.ts`         | Guard fallback derive                     |
| `src/transformers/opaque-ref/emitters/call-expression.ts`           | Guard fallback derive                     |
| `src/transformers/opaque-ref/emitters/property-access.ts`           | Early return in safe context              |
| `src/transformers/opaque-ref/emitters/template-expression.ts`       | Early return in safe context              |
| `src/transformers/opaque-ref/emitters/conditional-expression.ts`    | Early return in safe context              |
| `src/transformers/opaque-ref/emitters/element-access-expression.ts` | Early return in safe context              |
| `src/transformers/opaque-ref/emitters/prefix-unary-expression.ts`   | Early return in safe context              |
| `src/transformers/opaque-ref/emitters/container-expression.ts`      | Early return in safe context              |
| `test/*.test.ts`                                                    | Add new test cases                        |
