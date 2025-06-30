# TypeScript AST Transformers

This document describes the TypeScript AST (Abstract Syntax Tree) transformers
used in the CommonTools js-runtime package. These transformers enable reactive
programming patterns by automatically transforming TypeScript code that uses
OpaqueRef types and generating JSON schemas from TypeScript types.

## Overview

The js-runtime package includes two main TypeScript transformers:

1. **OpaqueRef Transformer** - Transforms operations on `OpaqueRef` types to use
   reactive primitives
2. **Schema Transformer** - Converts TypeScript type definitions to JSON Schema
   at compile time

Both transformers are opt-in and require the `/// <cts-enable />` directive at
the top of the file.

## Enabling Transformations

To enable AST transformations in a TypeScript file, add the following directive
at the top:

```typescript
/// <cts-enable />
import { cell, derive, ifElse } from "commontools";
// ... your code
```

Without this directive, the transformers will not modify your code.

## OpaqueRef Transformer

The OpaqueRef transformer automatically transforms certain patterns involving
`OpaqueRef` types from the CommonTools framework.

### Transformations

#### 1. Ternary Operators

When a ternary operator's condition is an OpaqueRef, transform to `ifElse()`:

```typescript
// Before
const status = isActive ? "on" : "off";

// After
const status = ifElse(isActive, "on", "off");
```

**Why**: OpaqueRef values cannot be directly used in JavaScript conditionals.
The `ifElse` function handles the reactive subscription internally.

#### 2. Binary Operations

When any operand in a binary expression is an OpaqueRef, wrap in `derive()`:

```typescript
// Before
const next = count + 1;
const total = price * quantity;

// After
const next = derive(count, (_v1) => _v1 + 1);
const total = derive(
  { price, quantity },
  ({ price: _v1, quantity: _v2 }) => _v1 * _v2,
);
```

**Why**: JavaScript operators cannot work with OpaqueRef values directly. The
`derive` function unwraps the values, performs the operation, and returns a new
OpaqueRef.

Supported operators: `+`, `-`, `*`, `/`, `%`, `>`, `<`, `>=`, `<=`, `==`, `===`,
`!=`, `!==`

#### 3. JSX Expressions

Transform OpaqueRef operations inside JSX expressions:

```typescript
// Before
const element = <div>Count: {count + 1}</div>;

// After
const element = <div>Count: {derive(count, (_v1) => _v1 + 1)}</div>;
```

Note: Simple references like `<div>{count}</div>` are not transformed, only
expressions that perform operations.

#### 4. Property Access and Method Calls

Access properties and call methods on OpaqueRef objects:

```typescript
// Before
const len = str.length;
const upper = str.toUpperCase();
const item = data.items[0];

// After
const len = derive(str, (_v1) => _v1.length);
const upper = derive(str, (_v1) => _v1.toUpperCase());
const item = derive(data, (_v1) => _v1.items[0]);
```

#### 5. Array and Object Literals

Transform each element/property independently (principle of independent
reactivity):

```typescript
// Before
const arr = [count + 1, price * 2];
const obj = { next: count + 1, total: price * tax };

// After
const arr = [derive(count, (_v1) => _v1 + 1), derive(price, (_v1) => _v1 * 2)];
const obj = {
  next: derive(count, (_v1) => _v1 + 1),
  total: derive({ price, tax }, ({ price: _v1, tax: _v2 }) => _v1 * _v2),
};
```

**Why**: Each element/property may have different OpaqueRef dependencies and
should be reactive independently.

### Key Principles

1. **Minimal Transformation**: Only transform what's necessary. Direct OpaqueRef
   references don't need transformation.
2. **Preserve Semantics**: The transformed code should behave identically to the
   original, just with reactive support.
3. **Independent Reactivity**: Each operation should be independently reactive
   to minimize unnecessary recomputation.
4. **Type Safety**: Transformations maintain TypeScript type information.

## Schema Transformer

The Schema transformer converts TypeScript type definitions to JSON Schema at
compile time using the `toSchema<T>()` function.

### Basic Usage

```typescript
/// <cts-enable />
import { toSchema } from "commontools";

interface User {
  name: string;
  age: number;
  email?: string;
}

// This gets transformed at compile time
const userSchema = toSchema<User>();

// Result:
const userSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "number" },
    email: { type: "string" },
  },
  required: ["name", "age"],
};
```

### With Options

```typescript
const schema = toSchema<User>({
  default: { name: "Anonymous", age: 0 },
});

// Result includes the default
const schema = {
  type: "object",
  properties: {/* ... */},
  required: ["name", "age"],
  default: { name: "Anonymous", age: 0 },
};
```

### Special Type Handling

#### Cell and Stream Types

Types marked with `Cell<T>` or `Stream<T>` are flagged in the schema:

```typescript
interface State {
  count: Cell<number>;
  messages: Stream<string[]>;
}

const schema = toSchema<State>();

// Result:
const schema = {
  type: "object",
  properties: {
    count: { type: "number", asCell: true },
    messages: {
      type: "array",
      items: { type: "string" },
      asStream: true,
    },
  },
};
```

### Integration with OpaqueRef Transformer

Both transformers work together seamlessly:

```typescript
/// <cts-enable />
import { cell, handler, recipe, toSchema } from "commontools";

interface InputState {
  count: number;
}

const schema = toSchema<InputState>(); // Transformed to JSON Schema

const myHandler = handler({}, schema, (_, state) => {
  // OpaqueRef operations are transformed
  const next = state.count + 1; // Becomes: derive(state.count, _v1 => _v1 + 1)
});
```

## Architecture

The transformer system is organized into focused modules:

### OpaqueRef Transformer

- `typescript/transformer/opaque-ref.ts` - Main transformer with configuration
- `typescript/transformer/types.ts` - Type checking utilities for OpaqueRef
  detection
- `typescript/transformer/transforms.ts` - Individual transformation functions
- `typescript/transformer/imports.ts` - Import management utilities

### Schema Transformer

- `typescript/transformer/schema.ts` - Main schema transformer
- `typescript/transformer/schema-converter.ts` - TypeScript to JSON Schema
  conversion logic

### Shared

- `typescript/compiler.ts` - TypeScript compiler integration
- `test/test-utils.ts` - Testing utilities for transformers

## Configuration

### Transformer Options

```typescript
interface TransformerOptions {
  mode?: "transform" | "error"; // Default: 'transform'
  debug?: boolean; // Enable debug logging
  logger?: (msg: string) => void; // Custom logger
}
```

### Usage in Compilation

```typescript
import { createOpaqueRefTransformer } from "./transformer/opaque-ref.ts";
import { createSchemaTransformer } from "./transformer/schema.ts";

const opaqueRefTransformer = createOpaqueRefTransformer(tsProgram, {
  mode: "transform",
  debug: true,
});

const schemaTransformer = createSchemaTransformer(tsProgram, {
  debug: true,
});

// Use in TypeScript compilation
tsProgram.emit(sourceFile, undefined, undefined, undefined, {
  before: [opaqueRefTransformer, schemaTransformer],
});
```

## Testing

### Test Utilities

The package includes comprehensive test utilities:

```typescript
import { checkWouldTransform, transformSource } from "./test-utils.ts";

// Transform source code for testing
const transformed = await transformSource(sourceCode, {
  mode: "transform",
  types: { "commontools.d.ts": typeDefinitions },
});

// Check if transformation would occur
const needsTransform = checkWouldTransform(sourceCode);
```

### Fixture Tests

Test fixtures are located in `test/fixtures/` with the following structure:

```
fixtures/
├── opaque-refs/           # OpaqueRef transformation tests
├── jsx-expressions/       # JSX expression transformation tests
└── transformations/       # Other transformation tests
```

Naming convention:

- `*.input.ts` or `*.input.tsx` - Source code before transformation
- `*.expected.ts` or `*.expected.tsx` - Expected output after transformation
- `no-transform-*` - Cases where transformation should NOT occur

## Error Mode

Both transformers support an error mode that reports what transformations would
be applied instead of applying them:

```typescript
const transformer = createOpaqueRefTransformer(tsProgram, { mode: "error" });

// This will throw an error listing all transformations that would be applied
```

This is useful for:

- Gradually migrating code to use transformers
- Understanding what transformations will be applied
- Debugging transformation issues

## Examples

### Complete Recipe Example

```typescript
/// <cts-enable />
import { cell, derive, h, ifElse, recipe, toSchema, UI } from "commontools";

interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
}

interface TodoState {
  items: TodoItem[];
  filter: "all" | "active" | "completed";
}

const schema = toSchema<TodoState>({
  default: { items: [], filter: "all" },
});

export default recipe(schema, schema, (state) => {
  // These operations are automatically transformed
  const activeCount = state.items.filter((item) => !item.completed).length;
  const hasActive = activeCount > 0;

  return {
    [UI]: (
      <div>
        <h1>Todo List</h1>
        <p>Active items: {activeCount}</p>
        {ifElse(
          hasActive,
          <button>Clear completed</button>,
          <span>No active items</span>,
        )}
      </div>
    ),
    items: state.items,
    filter: state.filter,
  };
});
```

## Future Enhancements

Potential areas for expansion:

1. **Async Operations** - Transform promises and async/await with OpaqueRef
2. **Logical Operations** - Special handling for `&&`, `||`, `!` with
   short-circuiting
3. **Template Literals** - Transform template strings with OpaqueRef
   interpolations
4. **Destructuring** - Handle OpaqueRef in destructuring patterns
5. **Spread Operations** - Transform spread with OpaqueRef values
6. **Type Assertions** - Preserve type assertions through transformations

## Contributing

To add new transformations:

1. Add detection logic to the appropriate transformer
2. Implement the transformation function
3. Update the visitor pattern
4. Add comprehensive tests
5. Update this documentation

Remember to follow the key principles: minimal transformation, preserve
semantics, independent reactivity, and type safety.
