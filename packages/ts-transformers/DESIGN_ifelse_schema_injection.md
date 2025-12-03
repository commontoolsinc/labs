# Design: Schema Injection for ifElse, when, and unless

## Overview

This document outlines the design for adding schema injection support to the
`ifElse`, `when`, and `unless` functions in the ts-transformers package.

## Current State

### What Exists

1. **Call Detection**: `ifElse` is detected in `call-kind.ts` (line 38, 67-68),
   but `when` and `unless` are NOT detected.

2. **Runtime Signatures** (from `runner/src/builder/built-in.ts`):
   ```typescript
   function ifElse<T, U, V>(
     condition: Opaque<T>,
     ifTrue: Opaque<U>,
     ifFalse: Opaque<V>,
   ): OpaqueRef<U | V>;
   function when<T, U>(
     condition: Opaque<T>,
     value: Opaque<U>,
   ): OpaqueRef<T | U>;
   function unless<T, U>(
     condition: Opaque<T>,
     value: Opaque<U>,
   ): OpaqueRef<T | U>;
   ```

3. **Schema Injection**: No handlers exist for any of these functions in
   `SchemaInjectionTransformer`.

4. **Transformation Pipeline**: `OpaqueRefJSXTransformer` creates
   `when`/`unless` calls from `&&`/`||` expressions, but these bypass schema
   injection entirely.

### Current Generated Output (no schemas)

```tsx
// Input: {condition && <Content />}
// Output:
__ctHelpers.when(
  __ctHelpers.derive({...schema...}, {...schema...}, {...}, ({ x }) => x > 0),
  <Content />
)
```

Note: The `derive()` inside has schemas, but `when()` itself has none.

## Proposed Design

### 1. Extend Call Detection

**File**: `src/ast/call-kind.ts`

Add `when` and `unless` to the `CallKind` type and detection logic:

```typescript
// Line 37-45: Extend CallKind type
export type CallKind =
  | { kind: "ifElse"; symbol?: ts.Symbol }
  | { kind: "when"; symbol?: ts.Symbol } // NEW
  | { kind: "unless"; symbol?: ts.Symbol } // NEW
  | { kind: "builder"; symbol?: ts.Symbol; builderName: string };
// ... rest unchanged

// Line 62-78: Add identifier detection
if (ts.isIdentifier(target)) {
  const name = target.text;
  if (name === "when") { // NEW
    return { kind: "when" };
  }
  if (name === "unless") { // NEW
    return { kind: "unless" };
  }
  // ... existing cases
}
```

### 2. Runtime Signature Changes

**File**: `runner/src/builder/built-in.ts`

Update runtime signatures to accept schema arguments:

```typescript
// ifElse: 3 schemas for 3 arguments
export function ifElse<T = unknown, U = unknown, V = unknown>(
  conditionSchema: JSONSchema,
  ifTrueSchema: JSONSchema,
  ifFalseSchema: JSONSchema,
  condition: Opaque<T>,
  ifTrue: Opaque<U>,
  ifFalse: Opaque<V>,
): OpaqueRef<U | V>;

// when: 2 schemas for 2 arguments
export function when<T = unknown, U = unknown>(
  conditionSchema: JSONSchema,
  valueSchema: JSONSchema,
  condition: Opaque<T>,
  value: Opaque<U>,
): OpaqueRef<T | U>;

// unless: 2 schemas for 2 arguments
export function unless<T = unknown, U = unknown>(
  conditionSchema: JSONSchema,
  valueSchema: JSONSchema,
  condition: Opaque<T>,
  value: Opaque<U>,
): OpaqueRef<T | U>;
```

**Backward Compatibility**: Support both old (no schemas) and new (with schemas)
signatures by checking argument count/types.

### 3. Schema Injection Handlers

**File**: `src/transformers/schema-injection.ts`

Add handlers after line 1260 (after generateObject handler):

#### Handler for `when`

```typescript
if (callKind?.kind === "when") {
  const factory = transformation.factory;
  const args = node.arguments;

  // Skip if already has schemas (4+ args means schemas present)
  if (args.length >= 4) {
    return ts.visitEachChild(node, visit, transformation);
  }

  // Must have exactly 2 arguments: condition, value
  if (args.length !== 2) {
    return ts.visitEachChild(node, visit, transformation);
  }

  const [conditionExpr, valueExpr] = args;

  // Infer types for each argument
  const conditionType = checker.getTypeAtLocation(conditionExpr);
  const valueType = checker.getTypeAtLocation(valueExpr);

  // Create schema TypeNodes (with literal widening for consistency with cell())
  const conditionTypeNode = typeToSchemaTypeNode(
    widenLiteralType(conditionType, checker),
    checker,
    sourceFile,
  ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

  const valueTypeNode = typeToSchemaTypeNode(
    widenLiteralType(valueType, checker),
    checker,
    sourceFile,
  ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

  // Create toSchema<T>() calls
  const conditionSchema = createToSchemaCall(context, conditionTypeNode);
  const valueSchema = createToSchemaCall(context, valueTypeNode);

  // Register in TypeRegistry for SchemaGeneratorTransformer
  if (typeRegistry) {
    typeRegistry.set(conditionSchema, conditionType);
    typeRegistry.set(valueSchema, valueType);
  }

  // Create new call with schemas prepended
  const updated = factory.createCallExpression(
    node.expression,
    undefined,
    [conditionSchema, valueSchema, ...args],
  );

  return ts.visitEachChild(updated, visit, transformation);
}
```

#### Handler for `unless`

Identical to `when` handler, just with `callKind?.kind === "unless"`.

#### Handler for `ifElse`

```typescript
if (callKind?.kind === "ifElse") {
  const factory = transformation.factory;
  const args = node.arguments;

  // Skip if already has schemas (6+ args means schemas present)
  if (args.length >= 6) {
    return ts.visitEachChild(node, visit, transformation);
  }

  // Must have exactly 3 arguments: condition, ifTrue, ifFalse
  if (args.length !== 3) {
    return ts.visitEachChild(node, visit, transformation);
  }

  const [conditionExpr, ifTrueExpr, ifFalseExpr] = args;

  // Infer types for each argument
  const conditionType = checker.getTypeAtLocation(conditionExpr);
  const ifTrueType = checker.getTypeAtLocation(ifTrueExpr);
  const ifFalseType = checker.getTypeAtLocation(ifFalseExpr);

  // Create schema TypeNodes (with literal widening)
  const conditionTypeNode = typeToSchemaTypeNode(
    widenLiteralType(conditionType, checker),
    checker,
    sourceFile,
  ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

  const ifTrueTypeNode = typeToSchemaTypeNode(
    widenLiteralType(ifTrueType, checker),
    checker,
    sourceFile,
  ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

  const ifFalseTypeNode = typeToSchemaTypeNode(
    widenLiteralType(ifFalseType, checker),
    checker,
    sourceFile,
  ) ?? factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

  // Create toSchema<T>() calls
  const conditionSchema = createToSchemaCall(context, conditionTypeNode);
  const ifTrueSchema = createToSchemaCall(context, ifTrueTypeNode);
  const ifFalseSchema = createToSchemaCall(context, ifFalseTypeNode);

  // Register in TypeRegistry
  if (typeRegistry) {
    typeRegistry.set(conditionSchema, conditionType);
    typeRegistry.set(ifTrueSchema, ifTrueType);
    typeRegistry.set(ifFalseSchema, ifFalseType);
  }

  // Create new call with schemas prepended
  const updated = factory.createCallExpression(
    node.expression,
    undefined,
    [conditionSchema, ifTrueSchema, ifFalseSchema, ...args],
  );

  return ts.visitEachChild(updated, visit, transformation);
}
```

### 4. Expected Output After Changes

```tsx
// Input: {condition && <Content />}
// Output:
__ctHelpers.when(
  toSchema<boolean>(),           // condition schema
  toSchema<VNode>(),             // value schema
  __ctHelpers.derive({...}, {...}, {...}, ({ x }) => x > 0),
  <Content />
)

// After SchemaGeneratorTransformer:
__ctHelpers.when(
  { type: "boolean" } as const satisfies JSONSchema,
  { type: "object", properties: {...} } as const satisfies JSONSchema,
  __ctHelpers.derive({...}, {...}, {...}, ({ x }) => x > 0),
  <Content />
)
```

## Implementation Plan

### Phase 1: Call Detection

1. Add `when` and `unless` to `CallKind` type
2. Add identifier detection in `resolveExpressionKind()`
3. Add symbol-based detection for completeness

### Phase 2: Schema Injection

1. Add `when` handler in `SchemaInjectionTransformer`
2. Add `unless` handler (nearly identical)
3. Add `ifElse` handler (3 schemas instead of 2)

### Phase 3: Runtime Support

1. Update `ifElse`/`when`/`unless` signatures in runner
2. Add backward compatibility for calls without schemas
3. Wire schemas through to `ifElseFactory`

### Phase 4: Testing

1. Add transformer fixture tests for each function
2. Add integration tests verifying runtime behavior
3. Verify existing JSX expression tests still pass

## Files to Modify

| File                                   | Changes                                          |
| -------------------------------------- | ------------------------------------------------ |
| `src/ast/call-kind.ts`                 | Add `when`/`unless` to CallKind, detection logic |
| `src/transformers/schema-injection.ts` | Add 3 new handlers (~100 lines)                  |
| `runner/src/builder/built-in.ts`       | Update signatures for schema args                |

## New Business Logic Required?

**No.** This design reuses:

- `detectCallKind()` - existing pattern, just adding new cases
- `typeToSchemaTypeNode()` - existing utility for type→TypeNode conversion
- `widenLiteralType()` - existing utility for literal widening
- `createToSchemaCall()` - existing utility for creating `toSchema<T>()` calls
- `TypeRegistry` - existing mechanism for type preservation
- `SchemaGeneratorTransformer` - handles `toSchema<T>()` → JSON schema
  conversion automatically

The implementation is mechanical application of existing patterns to new call
kinds.

## Open Questions

1. **Literal Widening**: Should we use `widenLiterals: true`?
   - **Recommendation**: Yes, for consistency with `cell()` and because
     conditional branches often contain literals.

2. **Nested Reactive Expressions**: What if arguments are already
   `derive()`/`lift()` calls?
   - **Answer**: Not a problem. We inject schemas for `when()`'s arguments. If
     an argument is `derive()`, that `derive()` already has its own schemas. The
     `when()` schema describes the _output_ type of that derive.

3. **VNode/JSX Schemas**: How should JSX elements be schematized?
   - **Answer**: The existing JSX transformation already handles this. VNode
     types have established schema patterns.

## Test Cases

1. `when-basic.input.tsx` - Simple `when(condition, value)`
2. `unless-basic.input.tsx` - Simple `unless(condition, fallback)`
3. `ifelse-basic.input.tsx` - Simple `ifElse(cond, ifTrue, ifFalse)`
4. `when-with-derive.input.tsx` - `when(derive(...), value)`
5. `unless-jsx.input.tsx` - `unless(condition, <JSX />)`
6. `ifelse-complex-types.input.tsx` - Object/array branch types
7. `when-already-has-schemas.input.tsx` - Verify no double-injection
