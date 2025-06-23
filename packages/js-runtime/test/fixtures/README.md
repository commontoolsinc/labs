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