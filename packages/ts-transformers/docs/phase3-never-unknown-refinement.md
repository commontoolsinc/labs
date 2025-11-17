# Phase 3: Never/Unknown Refinement Implementation

## Overview

Phase 3 implements a refined fallback policy for the TypeScript schema
transformer that distinguishes between missing/unused parameters (never type →
`false` schema) and present-but-untyped parameters (unknown type → `true`
schema).

## Implementation Date

2025-11-16

## Motivation

Based on manager feedback, the transformer should:

1. **Always generate schemas** for all CommonTools functions (pattern, derive,
   recipe, handler, lift)
2. **Use `false` schema (never type)** when parameters are missing or
   intentionally unused
3. **Use `true` schema (unknown type)** when parameters exist but lack type
   annotations
4. **Make Recipe lenient** - change from strict mode (skip transformation) to
   always transforming

## Refinement Rules

### Parameter Schema Type Determination

```typescript
/**
 * Rules for determining schema type:
 * - No parameter at all → never (schema: false)
 * - Parameter with _ prefix and no type → never (schema: false)
 * - Parameter with explicit type → use that type
 * - Parameter without type → unknown (schema: true)
 */
```

### Examples

| Input                              | Schema Type | Reasoning                          |
| ---------------------------------- | ----------- | ---------------------------------- |
| `handler((event) => {...})`        | `true`      | Parameter exists without type      |
| `handler((_event) => {...})`       | `false`     | Underscore prefix indicates unused |
| `handler((event: Event) => {...})` | Event type  | Explicit type annotation           |
| `recipe(() => {...})`              | `false`     | No parameter at all                |
| `recipe((_state) => {...})`        | `false`     | Unused parameter                   |
| `recipe((state: State) => {...})`  | State type  | Explicit type annotation           |

## Code Changes

### 1. Helper Function (`schema-injection.ts:210-241`)

Added `getParameterSchemaType()` helper to centralize the never/unknown logic:

```typescript
function getParameterSchemaType(
  factory: ts.NodeFactory,
  param: ts.ParameterDeclaration | undefined,
): ts.TypeNode {
  // No parameter at all → never
  if (!param) {
    return factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
  }

  // Has explicit type → use it
  if (param.type) {
    return param.type;
  }

  // Check if parameter name starts with _ (unused convention)
  if (ts.isIdentifier(param.name) && param.name.text.startsWith("_")) {
    return factory.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword);
  }

  // Parameter exists without type → unknown
  return factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
}
```

### 2. Handler Transformation

**Before (lenient with unknown)**:

```typescript
const eventType = eventParam?.type ??
  factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
```

**After (never/unknown refinement)**:

```typescript
const eventParam = handlerFn.parameters[0];
const stateParam = handlerFn.parameters[1];

const eventType = getParameterSchemaType(factory, eventParam);
const stateType = getParameterSchemaType(factory, stateParam);

// Always transform with both schemas
```

### 3. Pattern Transformation

**Before (optional schemas)**:

```typescript
if (argumentTypeNode) {
  newArgs.push(argSchemaCall);
}
if (resultTypeNode) {
  newArgs.push(resSchemaCall);
}
```

**After (always both schemas)**:

```typescript
const argumentTypeNode = inferred.argument ??
  getParameterSchemaType(factory, patternFunction.parameters[0]);

const resultTypeNode = inferred.result ??
  factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

// Always transform with both schemas
```

### 4. Recipe Transformation

**Before (strict - only transform with explicit types)**:

```typescript
if (inputParam?.type) {
  const toSchemaInput = createSchemaCallWithRegistryTransfer(...);
  // ... transform
}
```

**After (lenient - always transform)**:

```typescript
const inputParam = recipeFn.parameters[0];
const inputType = getParameterSchemaType(factory, inputParam);
const toSchemaInput = createSchemaCallWithRegistryTransfer(
  context,
  inputType,
  typeRegistry,
);
// ... always transform
```

### 5. Derive Transformation

**Before (conditional)**:

```typescript
if (argNode || inferred.result) {
  const finalArgNode = argNode ??
    factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
  // ... transform
}
```

**After (always transform)**:

```typescript
const finalArgNode = argNode ??
  factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
const resNode = inferred.result ??
  factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
return updateWithSchemas(...);
```

### 6. Lift Transformation

**Before (conditional)**:

```typescript
if (inferred.argument || inferred.result) {
  const argNode = inferred.argument ??
    factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
  // ... transform
}
```

**After (always transform with refinement)**:

```typescript
const argNode = inferred.argument ??
  getParameterSchemaType(factory, callback.parameters[0]);

const resNode = inferred.result ??
  factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);

// Always transform with both schemas
```

## Test Fixture Updates

Updated 30+ test fixtures following three main patterns:

### Pattern 1: Handler with `_` prefix

```typescript
// Before
handler(..., true as const satisfies __ctHelpers.JSONSchema, (_event, state) => {

// After
handler(..., false as const satisfies __ctHelpers.JSONSchema, (_event, state) => {
```

### Pattern 2: Recipe with no parameters

```typescript
// Before
recipe("Name", () => {

// After
recipe("Name", false as const satisfies __ctHelpers.JSONSchema, () => {
```

### Pattern 3: Derive with unknown types

```typescript
// Before
<span>Count: {derive(items.length, (n) => n + 1)}</span>

// After
<span>Count: {derive(true as const satisfies __ctHelpers.JSONSchema,
                      true as const satisfies __ctHelpers.JSONSchema,
                      items.length, (n) => n + 1)}</span>
```

## Test Results

All tests pass after implementation:

- **16 test suites passed**
- **180 test steps passed**
- **0 failures**

Test suites updated:

- Handler fixtures (8 files)
- Recipe fixtures (12 files)
- Pattern fixtures (4 files)
- Derive fixtures (2 files)
- JSX Expression fixtures (4 files)
- Closure Transformation fixtures (3 files)
- Schema Transformer fixtures (1 file)

## Benefits

1. **Semantic clarity**: Distinguishes between "not provided" (never) and "not
   typed" (unknown)
2. **Type safety**: Using `never` for unused parameters prevents accidental
   usage
3. **Consistency**: All functions now always generate schemas, making the system
   more predictable
4. **Better runtime validation**: Schemas accurately reflect which parameters
   should accept values
5. **Lenient Recipe**: Recipe now works without explicit type annotations,
   improving developer experience

## Future Considerations

1. The underscore prefix convention (`_param`) is currently used as a heuristic
   for "unused"
2. This works well with linter conventions but may need refinement for edge
   cases
3. Consider integrating with TypeScript's unused variable detection for more
   accuracy

## Related Documentation

- Original Phase 1-3 Analysis:
  `/Users/gideonwald/coding/session_outputs/2025-11-05_ts-transformers-analysis/`
- Schema Injection Transformer:
  `packages/ts-transformers/src/transformers/schema-injection.ts`
- Test Fixtures: `packages/ts-transformers/test/fixtures/`
