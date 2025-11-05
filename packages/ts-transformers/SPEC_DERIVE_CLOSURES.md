# Specification: Derive Closure Transformation

**Date:** 2025-11-05
**Status:** Draft
**Feature Branch:** `feature/derive-closure-transformer`

## Overview

This specification defines closure transformation support for user-written `derive()` calls. Currently, the transformer handles closures in handler JSX attributes and map callbacks. This extends that infrastructure to support derive calls.

## Motivation

User-written derive calls often capture variables from outer scope:

```tsx
const multiplier = cell(2);
derive(value, (v) => v * multiplier.get())
```

Without transformation, these closures don't work correctly in the reactive system. The derive callback needs explicit parameters for captured variables, similar to how handlers and maps work.

## Goals

1. **Reuse existing infrastructure:** Leverage `collectCaptures()`, `groupCapturesByRoot()`, and hierarchical params
2. **Minimal rewriting:** Preserve user's callback parameter names via destructuring aliases
3. **Consistent behavior:** Match the patterns established by handler and map closure transformations
4. **Type safety:** Integrate with TypeScript type inference and schema generation

## Current Behavior

### Auto-Wrapped Derive (JSX Expressions)

Already supported - handled by the opaque-ref transformer:

```tsx
// Input
<p>Next: {count + 1}</p>

// Output
<p>Next: {derive({count: count}, ({count}) => count + 1)}</p>
```

### User-Written Derive (No Closures)

Gets schema injection only:

```tsx
// Input
derive(value, (v) => v * 2)

// Output
derive(inputSchema, resultSchema, value, (v) => v * 2)
```

### User-Written Derive (With Closures)

**Currently:** Closures are NOT transformed, causing runtime issues:

```tsx
// Input
derive(value, (v) => v * multiplier.get())

// Output (current - BROKEN)
derive(inputSchema, resultSchema, value, (v) => v * multiplier.get())
// ❌ multiplier is captured but not passed as parameter
```

## New Behavior

### User-Written Derive (With Closures)

**After transformation:** Closures are detected and transformed:

```tsx
// Input
derive(value, (v) => v * multiplier.get())

// Output (new)
derive(
  inputSchema,
  resultSchema,
  {value, multiplier},
  ({value: v, multiplier}) => v * multiplier
)
```

**Key aspects:**
1. First argument becomes object containing input + captures
2. Callback parameter destructures object with **aliasing** to preserve user's parameter name
3. Schema is generated for the new object structure
4. Callback body references updated (`multiplier.get()` → `multiplier`)

## Transformation Rules

### Rule 1: Basic Closure Capture

**Input:**
```tsx
derive(value, (v) => v * multiplier.get())
```

**Output:**
```tsx
derive(
  {type: "object", properties: {value: {...}, multiplier: {...}}},
  resultSchema,
  {value, multiplier},
  ({value: v, multiplier}) => v * multiplier
)
```

**Notes:**
- Input wrapped in object literal
- Callback parameter uses destructuring with alias: `{value: v}`
- User's parameter name `v` preserved in callback body
- Captures added as additional properties: `multiplier`

### Rule 2: Multiple Captures

**Input:**
```tsx
derive(value, (v) => v * multiplier.get() + offset.get())
```

**Output:**
```tsx
derive(
  {type: "object", properties: {value: {...}, multiplier: {...}, offset: {...}}},
  resultSchema,
  {value, multiplier, offset},
  ({value: v, multiplier, offset}) => v * multiplier + offset
)
```

### Rule 3: Hierarchical Captures

Uses the same hierarchical params structure as handlers and maps:

**Input:**
```tsx
derive(value, (v) => v + state.user.profile.name.get())
```

**Output:**
```tsx
derive(
  {
    type: "object",
    properties: {
      value: {...},
      state: {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              profile: {
                type: "object",
                properties: {
                  name: {...}
                }
              }
            }
          }
        }
      }
    }
  },
  resultSchema,
  {
    value,
    state: {
      user: {
        profile: {
          name: state.user.profile.name
        }
      }
    }
  },
  ({value: v, state: {user: {profile: {name}}}}) => v + name
)
```

**Notes:**
- Nested captures organized hierarchically
- Avoids duplication of parent objects
- Reflects JavaScript destructuring semantics

### Rule 4: Object Literal Input

When user provides object literal as input, add captures as additional properties:

**Input:**
```tsx
derive({a, b}, ({a, b}) => a + b + external.get())
```

**Output:**
```tsx
derive(
  {type: "object", properties: {a: {...}, b: {...}, external: {...}}},
  resultSchema,
  {a, b, external},
  ({a, b, external}) => a + b + external
)
```

**Input with nested structure:**
```tsx
derive({user: state.user}, ({user}) => user.name + multiplier.get())
```

**Output:**
```tsx
derive(
  {type: "object", properties: {user: {...}, multiplier: {...}}},
  resultSchema,
  {user: state.user, multiplier},
  ({user, multiplier}) => user.name + multiplier
)
```

### Rule 5: Destructured Parameters

User may destructure the derive parameter:

**Input:**
```tsx
derive(obj, ({x, y}) => x + y + offset.get())
```

**Output:**
```tsx
derive(
  {type: "object", properties: {obj: {...}, offset: {...}}},
  resultSchema,
  {obj, offset},
  ({obj: {x, y}, offset}) => x + y + offset
)
```

**Notes:**
- Original destructuring pattern preserved via alias
- User's destructuring applied to aliased binding
- Offset added as peer property

### Rule 6: No Captures

If callback has no captures, skip closure transformation (schema injection only):

**Input:**
```tsx
derive(value, (v) => v * 2)
```

**Output:**
```tsx
derive(inputSchema, resultSchema, value, (v) => v * 2)
```

**Notes:**
- No closure transformation needed
- Only schema injection applied
- Input and callback unchanged

## Type Annotation Handling

### User Type Annotations

When user provides type annotation on callback parameter:

**Input:**
```tsx
derive(value, (v: number) => v * multiplier.get())
```

**Output:**
```tsx
derive(
  schema,
  resultSchema,
  {value, multiplier},
  ({value: v, multiplier}) => v * multiplier
)
// Note: Type annotation removed
```

**Rule:** Remove explicit type annotations, rely on TypeScript inference from the first argument.

**Rationale:**
- Parameter structure changes fundamentally (scalar → object)
- Original type annotation no longer applicable
- TypeScript infers correct type from object literal
- Consistent with how handlers create new parameters

### Type Inference

The transformer must:
1. Infer types for captured variables using TypeScript's type checker
2. Build schema reflecting the merged object structure
3. Register types in the type registry for schema generation
4. Let TypeScript infer callback parameter type from transformed input

## Edge Cases

### Name Collisions

When capture name conflicts with callback parameter name:

**Input:**
```tsx
const value = external;
derive(value, (value) => value * 2)
```

**Output:**
```tsx
derive(
  schema,
  resultSchema,
  {value},
  ({value}) => value * 2
)
```

**Notes:**
- No capture added (input IS the captured value)
- No collision occurs in this case

**Complex collision:**
```tsx
const state = external;
derive(value, (v) => v + state.get())
```

If callback somehow had `state` parameter (invalid for derive but hypothetically):
```tsx
// Would need renaming - use numeric suffix like handlers
({value: v, state: state_1}) => ...
```

Use the same collision resolution as handlers: append numeric suffix.

### Reserved Identifier Names

Captures may use reserved identifiers:

**Input:**
```tsx
derive(value, (v) => v + __ctHelpers.get())
```

**Output:**
```tsx
derive(
  schema,
  resultSchema,
  {value, __ctHelpers},
  ({value: v, __ctHelpers}) => v + __ctHelpers
)
```

**Rule:** Allow reserved identifiers, let runtime handle any issues.

### Non-Serializable Captures

Captures may reference functions or classes:

**Input:**
```tsx
derive(value, (v) => transform(v))
```

Where `transform` is a function.

**Rule:** Ignore non-serializable captures (functions, classes). Don't add to captures.

**Detection:** Use same logic as handlers/maps - check if declaration is a function or import.

### Optional Chaining

Captures may use optional chaining:

**Input:**
```tsx
derive(value, (v) => v + state?.user?.name?.get())
```

**Output:**
```tsx
derive(
  schema,
  resultSchema,
  {value, state: {user: {name: state?.user?.name}}},
  ({value: v, state: {user: {name}}}) => v + name
)
```

**Rule:** Preserve optional chaining in property access, but capture the full expression.

### Computed Properties

Captures with computed property access:

**Input:**
```tsx
derive(value, (v) => v + obj[key].get())
```

**Output:**
```tsx
derive(
  schema,
  resultSchema,
  {value, obj_key: obj[key]},
  ({value: v, obj_key}) => v + obj_key
)
```

**Rule:** Use fallback entry mechanism (same as derive builtin currently handles).

### Nested Derive

User writes nested derive calls:

**Input:**
```tsx
derive(outer, (o) => derive(inner, (i) => o + i + capture.get()))
```

**Output:**
```tsx
derive(
  schema1,
  resultSchema1,
  {outer, capture},
  ({outer: o, capture}) => derive(
    schema2,
    resultSchema2,
    {inner, capture},
    ({inner: i, capture}) => o + i + capture
  )
)
```

**Notes:**
- Both derive calls transformed independently
- Inner derive captures both `o` (from outer callback) and `capture` (from outer scope)
- Handled naturally by recursive visitor pattern

### Method Calls

Captures in method calls:

**Input:**
```tsx
derive(value, (v) => v * counter.get())
```

**Output:**
```tsx
derive(
  schema,
  resultSchema,
  {value, counter},
  ({value: v, counter}) => v * counter
)
```

**Rule:** Capture the object (`counter`), not the method (`.get()`). Same as handlers/maps.

## Detection Algorithm

### When to Transform

Transform a derive call when:
1. It's a call to `derive` (imported from commontools)
2. The callback parameter (2nd or 4th argument) has captures from outer scope
3. Captures include serializable variables (exclude functions, imports)

### How to Detect

```typescript
function shouldTransformDerive(
  deriveCall: ts.CallExpression,
  context: TransformationContext
): boolean {
  // 1. Check it's a derive call
  if (!isDeriveCall(deriveCall)) return false;

  // 2. Extract callback (2 or 4 argument form)
  const callback = extractDeriveCallback(deriveCall);
  if (!callback) return false;

  // 3. Collect captures
  const captures = collectCaptures(callback, context.checker);
  if (captures.size === 0) return false;

  // 4. Has serializable captures
  return true;
}
```

### Derive Call Signature Detection

Derive has two signatures:
```typescript
// Simple form (2 arguments)
derive<In, Out>(input: Opaque<In>, f: (input: In) => Out): OpaqueRef<Out>

// Schema form (4 arguments)
derive<InputSchema, ResultSchema>(
  inputSchema: InputSchema,
  resultSchema: ResultSchema,
  input: Opaque<...>,
  f: (input: ...) => ...
): OpaqueRef<...>
```

**Detection:**
- 2 args: callback at index 1
- 4 args: callback at index 3

## Implementation Approach

### Reuse Existing Infrastructure

Reuse from handler/map closures:
1. `collectCaptures()` - Capture detection using TypeScript symbols
2. `groupCapturesByRoot()` - Hierarchical organization
3. `buildTypeElementsFromCaptureTree()` - Schema generation
4. `buildHierarchicalParamsValue()` - Building params object
5. `createBindingElementsFromNames()` - Destructuring pattern creation
6. `reserveIdentifier()` - Name collision resolution

### New Functions Needed

```typescript
// Detect derive calls
function isDeriveCall(
  callExpr: ts.CallExpression,
  context: TransformationContext
): boolean

// Extract callback from derive call (2 or 4 arg form)
function extractDeriveCallback(
  deriveCall: ts.CallExpression
): ts.ArrowFunction | ts.FunctionExpression | undefined

// Transform derive call with closures
function transformDeriveCall(
  deriveCall: ts.CallExpression,
  context: TransformationContext,
  visitor: ts.Visitor
): ts.CallExpression

// Build merged input object (original input + captures)
function buildDeriveInputObject(
  originalInput: ts.Expression,
  captureTree: Map<string, CaptureTreeNode>,
  factory: ts.NodeFactory
): ts.ObjectLiteralExpression

// Create callback with aliased destructuring
function createDeriveCallback(
  callback: ts.ArrowFunction | ts.FunctionExpression,
  transformedBody: ts.ConciseBody,
  originalParam: ts.ParameterDeclaration,
  captureTree: Map<string, CaptureTreeNode>,
  context: TransformationContext
): ts.ArrowFunction | ts.FunctionExpression

// Build schema for merged input
function buildDeriveInputSchema(
  originalInput: ts.Expression,
  captureTree: Map<string, CaptureTreeNode>,
  context: TransformationContext
): ts.TypeNode
```

### Transformation Pipeline

```
Derive Call
  ↓
isDeriveCall() - Check if it's a derive call
  ↓
extractDeriveCallback() - Get callback (2 or 4 arg form)
  ↓
collectCaptures() - Find captured variables
  ↓
groupCapturesByRoot() - Organize hierarchically
  ↓
transformedBody = visit(callback.body) - Recursively transform body
  ↓
buildDeriveInputObject() - Create {input, ...captures}
  ↓
createDeriveCallback() - Create ({input: param, ...captures}) => body
  ↓
buildDeriveInputSchema() - Generate schema for merged input
  ↓
Build final derive call with 4 args
```

### Integration Point

Add to `createClosureTransformVisitor()` in `transformer.ts`:

```typescript
function createClosureTransformVisitor(
  context: TransformationContext,
): ts.Visitor {
  const visitor: ts.Visitor = (node: ts.Node): ts.Node => {
    // Existing handler transformation
    if (ts.isJsxAttribute(node) && isEventHandlerJsxAttribute(node)) {
      // ...
    }

    // Existing map transformation
    if (ts.isCallExpression(node) && isOpaqueRefArrayMapCall(node, context)) {
      // ...
    }

    // NEW: Derive transformation
    if (ts.isCallExpression(node) && isDeriveCall(node, context)) {
      const transformed = transformDeriveCall(node, context, visitor);
      if (transformed) return transformed;
    }

    return ts.visitEachChild(node, visitor, context.tsContext);
  };

  return visitor;
}
```

## Test Coverage

### Test Fixtures Required

Location: `packages/ts-transformers/test/fixtures/closures/`

**Basic Cases:**
1. ✅ `derive-basic-capture.input/expected.tsx`
   - Single capture, simple expression
   - `derive(value, (v) => v * multiplier.get())`

2. ✅ `derive-no-captures.input/expected.tsx`
   - No closures, should only add schema
   - `derive(value, (v) => v * 2)`

3. ✅ `derive-multiple-captures.input/expected.tsx`
   - Multiple unrelated captures
   - `derive(value, (v) => v * multiplier.get() + offset.get())`

**Hierarchical Captures:**
4. ✅ `derive-nested-captures.input/expected.tsx`
   - Nested property access
   - `derive(value, (v) => v + state.user.profile.name.get())`

5. ✅ `derive-mixed-captures.input/expected.tsx`
   - Mix of root and nested captures
   - `derive(value, (v) => v + state.counter.get() + external.get())`

**Object Literal Input:**
6. ✅ `derive-object-input-with-capture.input/expected.tsx`
   - Object literal input + captures
   - `derive({a, b}, ({a, b}) => a + b + external.get())`

7. ✅ `derive-object-nested-input.input/expected.tsx`
   - Object with nested structure + captures
   - `derive({user: state.user}, ({user}) => user.name + multiplier.get())`

**Parameter Patterns:**
8. ✅ `derive-destructured-param.input/expected.tsx`
   - User destructures parameter
   - `derive(obj, ({x, y}) => x + y + offset.get())`

9. ✅ `derive-computed-property.input/expected.tsx`
   - Computed property in destructuring
   - `derive(obj, ({[key]: value}) => value + external.get())`

**Edge Cases:**
10. ✅ `derive-name-collision.input/expected.tsx`
    - Capture name conflicts with parameter
    - `const value = external; derive(value, (value) => value * 2)`

11. ✅ `derive-reserved-names.input/expected.tsx`
    - Captures use reserved identifiers
    - `derive(value, (v) => v + __ctHelpers.get())`

12. ✅ `derive-type-annotation.input/expected.tsx`
    - Parameter has type annotation (should be removed)
    - `derive(value, (v: number) => v * multiplier.get())`

**Complex Scenarios:**
13. ✅ `derive-nested-derive.input/expected.tsx`
    - Derive inside derive
    - `derive(outer, (o) => derive(inner, (i) => o + i + capture.get()))`

14. ✅ `derive-in-jsx.input/expected.tsx`
    - User-written derive in JSX expression
    - `<div>{derive(value, (v) => v * multiplier.get())}</div>`

15. ✅ `derive-optional-chain-capture.input/expected.tsx`
    - Optional chaining in captures
    - `derive(value, (v) => v + state?.user?.name?.get())`

**Special Cases:**
16. ✅ `derive-method-call-capture.input/expected.tsx`
    - Capture object in method call
    - `derive(value, (v) => v * counter.get())`

17. ✅ `derive-shorthand-property.input/expected.tsx`
    - Shorthand property in object input
    - `const x = cell(1); derive({x}, ({x}) => x + external.get())`

18. ✅ `derive-four-arg-form.input/expected.tsx`
    - Derive with explicit schemas (4-arg form)
    - `derive(inputSchema, resultSchema, value, (v) => v * mult.get())`

19. ✅ `derive-two-arg-form.input/expected.tsx`
    - Derive simple form (2-arg)
    - `derive(value, (v) => v * multiplier.get())`

### Test Strategy

Each fixture should have:
- `.input.tsx` - Source code before transformation
- `.expected.tsx` - Expected output after transformation

Tests should verify:
- Correct schema generation
- Proper parameter aliasing
- Hierarchical capture organization
- Callback body references updated
- Edge cases handled gracefully

### Schema Validation

Some fixtures should also test schema generation:
- Location: `packages/ts-transformers/test/fixtures/handler-schema/`
- Create: `derive-schema-generation.input/expected.tsx`
- Validates that schemas match expected structure

## Open Questions

### Resolved
- ✅ Parameter name handling: Use destructuring aliases
- ✅ Object literal input: Add captures as properties
- ✅ Type annotations: Remove, rely on inference
- ✅ Hierarchical params: Reuse existing infrastructure
- ✅ Name collisions: Use numeric suffix (like handlers)
- ✅ Auto-wrapped derive: No conflict, separate transformations

### Pending
- ⏳ Performance implications for deeply nested captures?
- ⏳ Error messages for unsupported patterns?
- ⏳ Integration testing with runtime behavior?

## Success Criteria

1. ✅ All 19 test fixtures pass
2. ✅ Reuses at least 80% of handler/map closure infrastructure
3. ✅ No regression in existing tests
4. ✅ Schema generation works correctly
5. ✅ TypeScript type inference works
6. ✅ Runtime behavior matches expectations
7. ✅ Code review approval from team

## Timeline

- **Week 1:** Implementation + unit tests
- **Week 2:** Integration testing + refinement
- **Week 3:** Code review + documentation
- **Week 4:** Merge to main

## References

- Handler closure transformation: `src/closures/transformer.ts` lines 672-751
- Map closure transformation: `src/closures/transformer.ts` lines 1063-1101
- Derive builtin: `src/transformers/builtins/derive.ts`
- Capture tree: `src/utils/capture-tree.ts`
- Type building: `src/ast/type-building.ts`
- Scope analysis: `src/ast/scope-analysis.ts`

---

**Document Status:** Ready for review and implementation
**Next Steps:** Review spec with team, then begin implementation
