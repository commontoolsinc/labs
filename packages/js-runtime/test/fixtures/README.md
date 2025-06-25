# Test Fixtures

This directory contains test fixtures for the TypeScript transformer tests. Each fixture consists of an input file and an expected output file.

## Structure

```
fixtures/
├── opaque-refs/           # OpaqueRef transformation tests
├── jsx-expressions/       # JSX expression transformation tests
└── transformations/       # Other transformation tests
    └── ifelse/           # Ternary to ifElse transformations
```

## Naming Convention

- `*.input.ts` or `*.input.tsx` - Source code before transformation
- `*.expected.ts` or `*.expected.tsx` - Expected output after transformation
- `no-transform-*` - Cases where transformation should NOT occur

## Usage

```typescript
import { transformFixture, compareFixtureTransformation } from "../test-utils.ts";

// Transform a fixture and make assertions
const transformed = await transformFixture("opaque-refs/binary-expressions.input.ts", { types });

// Compare input/expected automatically
const result = await compareFixtureTransformation(
  "opaque-refs/nested-ternary.input.ts",
  "opaque-refs/nested-ternary.expected.ts",
  { types }
);
expect(result.matches).toBe(true);
```

## Transformation Rules

The OpaqueRef transformer applies AST rewrites based on these rules:

### 1. **Ternary Expressions with OpaqueRef Conditions**
**Rule**: When a ternary operator's condition is an OpaqueRef, transform to `ifElse()`
- **Why**: OpaqueRef values cannot be directly used in JavaScript conditionals. The `ifElse` function handles the reactive subscription internally.
- **Example**: `opaqueRef ? a : b` → `ifElse(opaqueRef, a, b)`

### 2. **Binary Operations with OpaqueRef Values**
**Rule**: When any operand in a binary expression is an OpaqueRef, wrap in `derive()`
- **Why**: JavaScript operators cannot work with OpaqueRef values directly. The `derive` function unwraps the values, performs the operation, and returns a new OpaqueRef.
- **Example**: `count + 1` → `derive(count, _v1 => _v1 + 1)`
- **Multiple refs**: `a + b` → `derive({ a, b }, ({ a: _v1, b: _v2 }) => _v1 + _v2)`

### 3. **JSX Expressions with OpaqueRef Operations**
**Rule**: Transform OpaqueRef operations inside JSX expressions, but leave simple references alone
- **Why**: JSX can render OpaqueRef values directly, but operations need to be wrapped in `derive()`
- **Example**: `<div>{count}</div>` → no change
- **Example**: `<div>{count + 1}</div>` → `<div>{derive(count, _v1 => _v1 + 1)}</div>`

### 4. **Array and Object Literals** (Principle of Independent Reactivity)
**Rule**: Transform each element/property independently if it contains OpaqueRef operations
- **Why**: Each element/property may have different OpaqueRef dependencies and should be reactive independently. This follows the **principle of independent reactivity** - minimizing recomputation by making each value depend only on its specific OpaqueRef inputs.
- **Example**: `[a + 1, b - 1]` → `[derive(a, _v1 => _v1 + 1), derive(b, _v1 => _v1 - 1)]`
- **Example**: `{ x: a + 1, y: b * 2 }` → `{ x: derive(a, _v1 => _v1 + 1), y: derive(b, _v1 => _v1 * 2) }`

### 5. **Nested Transformations**
**Rule**: Recursively transform nested expressions
- **Why**: Complex expressions may have OpaqueRef operations at multiple levels
- **Example**: `a ? (b ? 1 : 2) : 3` → `ifElse(a, ifElse(b, 1, 2), 3)`

### Key Principles

1. **Minimal Transformation**: Only transform what's necessary. Direct OpaqueRef references don't need transformation.
2. **Preserve Semantics**: The transformed code should behave identically to the original, just with reactive support.
3. **Independent Reactivity**: Each operation should be independently reactive to minimize unnecessary recomputation.
4. **Type Safety**: Transformations maintain TypeScript type information.

## Future Test Cases to Implement

1. **Object Literals with OpaqueRef Operations** ✅
   - Transform each property value independently
   - Implemented in `object-literal-operations` fixture

2. **Method Calls on OpaqueRef**
   - `str.toUpperCase()`, `str.length`
   - Need to determine if these should use derive

3. **Function Calls with OpaqueRef Arguments**
   - `Math.max(a, 10)`, `someFunction(a + 1, "prefix")`

4. **Nested Object/Array Access**
   - `data.items[0]`, `data.items.length`

5. **Assignment Operations**
   - `count += 1` vs `count = count + 1`

6. **Logical Operations**
   - `a && b`, `a || b`, `!a`
   - May need special handling for short-circuiting

7. **Comparison Operations**
   - `a > b`, `a === b`

8. **Template Literals**
   - `` `Hello, ${name}!` ``, `` `Count: ${count + 1}` ``

9. **Spread Operations**
   - `[...arr, 4]`, `{ ...obj, b: 2 }`

10. **Complex Nested Expressions**
    - `(a + 1) * (b ? c - 2 : 3)`

11. **Return Statements**
    - Function returns with OpaqueRef operations

12. **Arrow Function Bodies**
    - `() => a + 1` vs `() => { return a + 1; }`

13. **Nullish Coalescing and Optional Chaining**
    - `maybeNum ?? 0`, `maybeObj?.property`

14. **Type Assertions**
    - `(val as number) + 1`, `<string>val + "!"`

15. **Multiple Operations in One Statement**
    - Complex expressions with multiple OpaqueRefs and operations

## Test Cases

### OpaqueRef Transformations

- **binary-expressions**: Basic arithmetic operations with OpaqueRef
- **complex-multiple-refs**: Complex expressions with multiple OpaqueRef values
- **multiple-refs**: Simple operations with two different OpaqueRefs
- **nested-ternary**: Nested ternary expressions with OpaqueRef conditions
- **property-access**: Property access on OpaqueRef objects
- **same-ref-multiple-times**: Using the same OpaqueRef multiple times
- **string-concatenation**: String concatenation with OpaqueRef
- **ternary-adds-import**: Ternary that needs ifElse import added
- **ternary-with-cell**: Ternary with cell() function result
- **various-binary-operators**: Different binary operators (+, -, *, /, %)
- **binary-with-ternary**: Binary expression containing ternary with OpaqueRef
- **array-with-opaque-operations**: Array literal with OpaqueRef operations
- **object-literal-operations**: Object literal with OpaqueRef operations

### JSX Expression Transformations

- **complex-expressions**: Multiple JSX expressions with OpaqueRef operations
- **opaque-ref-operations**: Various OpaqueRef operations in JSX
- **recipe-with-cells**: Full recipe with cell operations in JSX
- **simple-opaque-ref**: Basic OpaqueRef operation in JSX
- **no-transform-simple-ref**: Simple OpaqueRef reference (no transformation)

### No-Transform Cases

- **no-transform-regular-binary**: Regular number operations
- **no-transform-regular-ternary**: Regular boolean ternary
- **no-transform-simple-ref**: Direct OpaqueRef usage without operations