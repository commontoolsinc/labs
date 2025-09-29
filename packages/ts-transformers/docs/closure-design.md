# Closure Transformation Design

_Created: 2025-09-24_ _Updated: 2025-09-29_ _Status: In Implementation_

## Overview

This document captures the design and implementation strategy for adding closure
support to the CommonTools TypeScript transformer. The goal is to transform
functions that capture reactive values (OpaqueRef) from outer scopes into
CommonTools-compatible patterns that maintain reactivity.

## Problem Statement

Currently, closures that capture reactive values don't maintain reactivity:

```typescript
// Problem: state.discount is captured but not reactive
state.items.map((item) => item.price * state.discount)

// Problem: state.count is captured in event handler
<button onClick={() => console.log(state.count)}>
```

## Design Principles

1. **Incremental Implementation**: Start with most common patterns, generalize
   progressively
2. **Leverage Existing Infrastructure**: Build on dataflow analysis and rewrite
   helpers
3. **Maintain Backwards Compatibility**: Don't break existing transformations
4. **Clear Separation of Concerns**: Detection vs. transformation
5. **Runtime Compatibility**: Work with existing CommonTools runtime

## Architecture (IMPLEMENTED)

### Component Responsibilities

1. **Separate Closure Module** (`src/closures/`)
   - Standalone transformer independent of opaque-ref
   - Runs FIRST in the pipeline
   - Has its own types and rule system

2. **Closure Transform Rule** (`src/closures/rules/closure-transform.ts`)
   - Detects map callbacks with captures
   - Transforms to recipe pattern with params
   - Manages import requests through context

3. **Dataflow Analysis** (Enhanced)
   - Added synthetic node handling for transformer-created nodes
   - Supports nodes without source files (inheritance approach)

## Implementation Phases

### Phase 1: Capture Detection Foundation ✅ IMPLEMENTED

**Key Insight**: Instead of maintaining our own scope tree with bindings, we'll
leverage TypeScript's symbol table which already knows where every variable is
declared.

```typescript
// Simple capture detection using TypeScript's built-in knowledge
function isCaptured(
  identifier: ts.Identifier,
  containingFunction: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): boolean {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (!symbol) return false;

  const declarations = symbol.getDeclarations();
  if (!declarations) return false;

  // Check if any declaration is outside the containing function
  return declarations.some((decl) => !isNodeWithin(decl, containingFunction));
}
```

**Important Design Decisions**:

- We pass ALL captured variables as params, not just reactive ones (they all
  need to be accessible)
- Closure transformation runs BEFORE jsx-expression transformation
- No need to track bindings in dataflow - TypeScript already has this
  information

### Phase 2: Map Callback Support ⚠️ IN PROGRESS

Transform map callbacks with captured variables:

```typescript
// Input:
state.items.map((item, index) => item.price * state.discount + state.tax);

// Output:
state.items.map({
  op: recipe(({ elem, index, params: { discount, tax } }) =>
    elem.price * discount + tax
  ),
  params: { discount: state.discount, tax: state.tax },
});
```

### Phase 3: Event Handler Support

Transform event handlers with captures:

```typescript
// Input:
<button onClick={() => state.count++}>

// Output:
<button onClick={handler((event, {count}) =>
  count.set(count.get() + 1),
  {count: state.count}
)}>
```

### Phase 4: Generic Closure Support

Transform arbitrary closures:

```typescript
// Input:
const compute = () => state.a + state.b;

// Output:
const compute = lift(
  ({ a, b }) => a + b,
).curry({ a: state.a, b: state.b });
```

## Transformation Patterns

### Pattern 1: Array Map with Params

**Applies when**:

- Inside array.map() callback
- Callback captures reactive values
- Map is called on OpaqueRef array

**Transformation**:

1. Collect all captured reactive values
2. Create params object with captured values
3. Transform callback to destructure params
4. Transform map call to object form with op and params

### Pattern 2: Event Handler with Context

**Applies when**:

- Inside JSX event handler attribute
- Handler captures reactive values
- Handler modifies state

**Transformation**:

1. Identify captured reactive values
2. Wrap in handler() call
3. Pass captured values as second parameter
4. Transform body to use destructured context

### Pattern 3: Lift with Curry

**Applies when**:

- General closure capturing reactive values
- Not in special context (map, handler)
- Returns computed value

**Transformation**:

1. Identify captured reactive values
2. Wrap function in lift()
3. Add curry() call with captured values
4. Transform body to use parameters

## Edge Cases and Considerations

### Nested Closures

```typescript
// Multiple levels of capture
state.items.map((item) => {
  const helper = () => item.price * state.discount;
  return helper();
});
```

### Mixed Captures

```typescript
// Some reactive, some not
const constant = 10;
state.items.map((item) => item.price * state.discount + constant);
```

### Mutation vs. Read

```typescript
// Mutations need Cell access
<button onClick={() => state.count++}>  // Needs mutable access
<span>{() => state.count + 1}</span>    // Only needs read access
```

## Testing Strategy

### Fixture-Based Tests (Primary) ✅ IMPLEMENTED

Following the existing pattern in `test/fixture-based.test.ts`, we have created
fixture pairs for closure transformations:

**Directory Structure**:

```
test/fixtures/closures/
├── map-single-capture.input.tsx
├── map-single-capture.expected.tsx
├── map-multiple-captures.input.tsx
├── map-multiple-captures.expected.tsx
├── event-handler-mutation.input.tsx
├── event-handler-mutation.expected.tsx
├── nested-closures.input.tsx
├── nested-closures.expected.tsx
└── ...
```

**Configuration Addition** to `fixture-based.test.ts` ✅ COMPLETED:

```typescript
{
  directory: "closures",
  describe: "Closure Transformation",
  transformerOptions: { applySchemaTransformer: true },
  formatTestName: (name) => `transforms ${name.replace(/-/g, " ")}`,
  groups: [
    { pattern: /^map-/, name: "Map callbacks" },
    { pattern: /^event-/, name: "Event handlers" },
    { pattern: /^lift-/, name: "Generic closures" },
  ],
}
```

### Unit Tests

- Capture detection in `dataflow.test.ts`
- Scope capture tracking in isolation
- Helper function tests for params generation

### Integration Tests

- Full pipeline with closure transformations
- Interaction between closure and JSX expression rules
- Runtime compatibility verification

### Test Cases Priority

#### Phase 1: Map Callbacks (Fixtures)

1. `map-single-capture` - Simple map with one captured value
2. `map-multiple-captures` - Map with multiple captured values
3. `map-nested-property` - Captured value with nested property access
4. `map-with-existing-params` - Map already using elem/index params
5. `map-mixed-captures` - Mix of reactive and non-reactive captures

#### Phase 2: Event Handlers (Fixtures)

6. `event-handler-read` - Handler that reads captured state
7. `event-handler-mutation` - Handler that modifies captured state
8. `event-handler-multiple` - Handler with multiple captures

#### Phase 3: Generic Closures (Fixtures)

9. `lift-simple-closure` - Basic closure transformation
10. `nested-closures` - Closures within closures
11. `closure-in-conditional` - Closure inside ternary/ifElse

### Fixture Test Benefits

- Easy to add new test cases without writing test code
- Visual side-by-side comparison of input/expected
- Automatic diff generation on failures
- Grouped test organization
- Consistent with existing test patterns

## Migration Guide

For users upgrading:

### Before

```typescript
// Manual curry pattern
const compute = (state) => () => state.a + state.b;
```

### After (Automatic)

```typescript
// Transformer handles this
const compute = () => state.a + state.b;
```

## Implementation Decisions Made

1. **Architecture**: Created separate `src/closures/` module instead of embedding in opaque-ref
2. **Ordering**: Closure transformer runs FIRST in the pipeline
3. **Synthetic Nodes**: Implemented inheritance approach in dataflow.ts
4. **Testing**: Using commonTypeScriptTransformer for all tests
5. **Import Management**: Using context.imports for managing CommonTools imports

## Known Issues

1. **Capture Detection Bug**:
   - Currently captures individual identifiers instead of full property expressions
   - Example: `state.discount` is incorrectly captured as "state" and "discount" separately
   - Root cause identified: `collectCaptures` function needs to handle property access expressions as units

## Open Questions

1. **Performance**: Should we cache capture analysis results?
2. **Debugging**: How do we preserve source maps through transformation?
3. **Type Safety**: How do we ensure transformed code maintains type safety?
4. **Runtime Support**: Does the runtime support lift+curry pattern for generic closures?

## Success Metrics

1. All map callbacks with captures transform correctly
2. Event handlers maintain reactivity
3. No regression in existing transformations
4. Clear error messages for unsupported patterns
5. Performance impact < 10% on compilation time

## Future Extensions

1. **Async/Await Support**: Handle closures in async functions
2. **Generator Functions**: Support generators that capture state
3. **Class Methods**: Transform methods that capture instance state
4. **Optimization Pass**: Eliminate redundant transformations
5. **Smart Curry**: Only curry when necessary based on usage
