# Consistent Literal Widening Design

## Problem Statement

TypeScript infers literal types for `const` declarations:

```typescript
const value = 5; // Type: 5 (literal), not number
```

When generating JSON schemas from these inferred types, the transformer produces
overly restrictive schemas:

```json
{ "type": "number", "enum": [5] }
```

This is technically correct but semantically wrong for CommonTools. A cell or
derive input initialized with `5` should accept any number, not just `5`.

## Current State

Literal widening is **inconsistently applied**:

| Construct              | Widening? | Mechanism                                   |
| ---------------------- | --------- | ------------------------------------------- |
| `cell(10)`             | ✅ Yes    | `widenLiteralType()` in schema-injection.ts |
| `Cell.of(10)`          | ✅ Yes    | Same as above                               |
| `derive(value, fn)`    | ❌ No     | Raw `getTypeAtLocation()`                   |
| `handler(fn)` captures | ❌ No     | Raw type inference                          |
| `lift(fn)`             | ❌ No     | Raw type inference                          |
| Closure captures       | ❌ No     | Raw `getTypeAtLocation()`                   |

## Design Principle

**Widen at the Type level, not the Schema level.**

When we infer a type from a value or expression, apply `widenLiteralType()`
immediately. This ensures:

1. Widening happens at the source, not as a downstream fix
2. Future code paths automatically benefit
3. Semantic correctness - we're widening "inferred types", not "all types"

## When to Widen

**DO widen:**

- Types inferred from expressions: `checker.getTypeAtLocation(expr)`
- Types inferred from untyped parameters: `checker.getTypeOfSymbol(param)`
- Closure-captured variable types

**DO NOT widen:**

- Explicit type annotations: `Cell.of<number>(10)` → use `number` as-is
- Types from type arguments: `derive<Input, Output>(...)`
- Types from interface/type declarations

## Implementation Plan

### 1. schema-injection.ts Changes

#### derive() - Line ~870

```typescript
// BEFORE
const argumentType = checker.getTypeAtLocation(firstArg);

// AFTER
const argumentType = widenLiteralType(
  checker.getTypeAtLocation(firstArg),
  checker,
);
```

#### handler() - Captured state types

Apply widening when inferring captured variable types for handler state schemas.

#### lift() - Input types

Apply widening when inferring input types from function parameters.

#### pattern - Inferred input types

Apply widening when no explicit type argument is provided.

### 2. closure-transformer.ts Changes

When capturing variables in closures, the type of the captured variable may be a
literal type. Apply widening when building the captures object type.

### 3. type-inference.ts Changes

Consider adding a helper function:

```typescript
/**
 * Infer type from an expression with automatic literal widening.
 * Use this for value-based type inference where literal types should
 * be widened to their base types.
 */
export function inferWidenedType(
  expr: ts.Expression,
  checker: ts.TypeChecker,
): ts.Type {
  const type = checker.getTypeAtLocation(expr);
  return widenLiteralType(type, checker);
}
```

## Test Cases

### Existing (should continue to work)

- `literal-widen-number.input.tsx` - cell(10) → type: "number"
- `literal-widen-string.input.tsx` - cell("hello") → type: "string"
- `literal-widen-explicit-type-args.input.tsx` - Cell.of<number>(10) → preserved

### Updated

- `derive-param-initializer.input.tsx` - Remove TODO, expect type: "number" (no
  enum)

### New (to add)

- `derive-literal-input.input.tsx` - derive(5, fn) should widen
- `handler-literal-capture.input.tsx` - captured const should widen
- `closure-literal-capture.input.tsx` - closure capture should widen

## Risks and Mitigations

### Risk: Breaking explicit literal type unions

```typescript
type Status = "pending" | "active" | "done";
const status: Status = "pending";
```

**Mitigation:** Only widen _inferred_ types, not types from explicit
annotations. The annotation provides `Status`, not `"pending"`.

### Risk: Over-widening in complex scenarios

**Mitigation:** Only call `widenLiteralType()` on types we _know_ are inferred
from values, not on types from type nodes or signatures.

## Success Criteria

1. `derive-param-initializer` fixture produces `type: "number"` without `enum`
2. All existing tests pass
3. New test cases verify widening for derive/handler/lift/closure captures
4. No regressions in explicit type argument handling
