# TypeScript AST Transformers Guide

This guide consolidates the TypeScript AST transformer functionality for the
CommonTools js-runtime package. It covers two main transformers that enable
reactive programming patterns:

1. **OpaqueRef Transformer** - Transforms operations on `OpaqueRef` types to use
   reactive primitives
2. **Schema Transformer** - Converts TypeScript type definitions to JSON Schema
   at compile time

## Core Concept: Opt-in Transformation

Both transformers require the `/// <cts-enable />` directive at the top of files
to be transformed:

```typescript
/// <cts-enable />
import { cell, derive, ifElse, toSchema } from "commontools";
```

Without this directive, the transformers will not modify your code.

## OpaqueRef Transformer

### What is OpaqueRef?

OpaqueRef is a type representing reactive values in CommonTools. It wraps:

- The actual value type (e.g., `string`, `number`, `{ name: string }`)
- Methods for reactivity (`.get()`, `.set()`, etc.) used inside
  lift/handler/derive functions

```typescript
const count = cell(0); // count is OpaqueRef<number>
```

### Core Transformation Patterns

#### 1. Binary Operations

Operations on OpaqueRef values are wrapped in `derive()`:

```typescript
// Input
const next = count + 1;
const total = price * quantity;
const isValid = age > 18;

// Output
const next = derive(count, (_v) => _v + 1);
const total = derive(
  { price, quantity },
  ({ price: _v1, quantity: _v2 }) => _v1 * _v2,
);
const isValid = derive(age, (_v) => _v > 18);
```

Supported operators: `+`, `-`, `*`, `/`, `%`, `>`, `<`, `>=`, `<=`, `==`, `===`,
`!=`, `!==`

#### 2. Ternary Conditionals

When a ternary operator's condition is an OpaqueRef, it transforms to
`ifElse()`:

```typescript
// Input
const status = isActive ? "on" : "off";

// Output
const status = ifElse(isActive, "on", "off");
```

Note: This transformation only occurs when the condition (`isActive`) is an
OpaqueRef type.

#### 3. Property Access and Method Calls

When accessing properties or calling methods on OpaqueRef values:

```typescript
// Input
const len = str.length;
const upper = str.toUpperCase();
const firstName = user.name;

// Output
const len = derive(str, (_v) => _v.length);
const upper = derive(str, (_v) => _v.toUpperCase());
const firstName = user.name; // No transform - property access on object returns nested OpaqueRef
```

Key principle: Direct property access on an OpaqueRef object returns another
OpaqueRef, while operations on the value require `derive()`.

#### 4. JSX Expressions

Operations on OpaqueRef values inside JSX expressions are transformed:

```typescript
// Input
<div>Count: {count + 1}</div>
<span>{user.name.toUpperCase()}</span>

// Output
<div>Count: {derive(count, _v => _v + 1)}</div>
<span>{derive(user.name, _v => _v.toUpperCase())}</span>
```

Note: Direct OpaqueRef references like `<div>{count}</div>` are preserved as-is,
allowing the UI framework to handle reactivity.

#### 5. Array and Object Literals

Each element/property is transformed independently:

```typescript
// Input
const arr = [count + 1, price * 2];
const obj = { next: count + 1, total: price * tax };

// Output
const arr = [derive(count, (_v) => _v + 1), derive(price, (_v) => _v * 2)];
const obj = {
  next: derive(count, (_v) => _v + 1),
  total: derive({ price, tax }, ({ price: _v1, tax: _v2 }) => _v1 * _v2),
};
```

### Current Limitations

1. **Array Methods** - Not yet supported:
   ```typescript
   const items = cell([1, 2, 3]);
   const doubled = items.map((x) => x * 2); // ❌ Not transformed
   const filtered = items.filter((x) => x > 2); // ❌ Not transformed
   ```
   **Why:** Array methods require special handling to maintain reactivity
   through the callback function.

2. **Async Operations** - Not yet supported:
   ```typescript
   const url = cell("https://api.example.com");
   const data = await fetch(url); // ❌ Not transformed
   ```
   **Why:** Async operations with OpaqueRef require special handling for promise
   resolution and error states.

3. **Destructuring** - Extracts values, losing reactivity:
   ```typescript
   const user = cell({ name: "John", age: 25 });
   const { name, age } = user; // ❌ name and age are plain values, not OpaqueRef
   ```
   **Why:** Destructuring extracts the current value, breaking the reactive
   chain.

## Schema Transformer

### Basic Usage

Transform TypeScript interfaces to JSON Schema at compile time:

```typescript
/// <cts-enable />
import { toSchema } from "commontools";

interface User {
  name: string;
  age: number;
  email?: string;
}

const userSchema = toSchema<User>();

// This is transformed at compile time to:
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

### Schema Options

```typescript
const schema = toSchema<User>({
  title: "User Schema",
  description: "A user in the system",
  default: { name: "Anonymous", age: 0 },
  examples: [{ name: "John", age: 30 }],
});
```

### Cell and Stream Types

Properties marked with `Cell<T>` or `Stream<T>` types are flagged in the schema:

```typescript
interface State {
  count: Cell<number>;
  messages: Stream<string[]>;
}

const schema = toSchema<State>();

// Generates:
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
  required: ["count", "messages"],
};
```

## Implementation Strategy

### Phase 1: Core Functionality

1. Basic OpaqueRef binary operations (+, -, *, /, comparisons)
2. Simple schema generation for primitives and objects
3. Test infrastructure setup
4. Basic validation framework

### Phase 2: Essential Patterns

1. Ternary operator transformation (ifElse)
2. Property access and method calls on OpaqueRef
3. JSX expression handling
4. Optional properties in schema generation
5. Event handler validation (must be Streams)

### Phase 3: Advanced Features

1. Multiple OpaqueRef handling in single expression
2. Nested object and array transformations
3. Cell/Stream type detection in schemas
4. Error mode for gradual migration
5. Non-transformable pattern detection with helpful errors

### Phase 4: Future Enhancements

1. Array method support (map, filter, reduce)
2. Async/await integration with OpaqueRef
3. Template literal transformations
4. Advanced destructuring patterns
5. Logical operators (&&, ||, !) with short-circuiting

## Semantic Validation

A critical aspect of the AST system is semantic validation that runs
**regardless of transformation mode**. This validation ensures recipes follow
CommonTools patterns correctly and provides helpful error messages for both
humans and LLMs.

### Core Validation Rules

#### 1. Event Handler Validation

All JSX event handlers (onFoo attributes) must be bound to Streams:

```typescript
// ❌ Invalid - direct function
<button onClick={(e) => console.log(e)}>Click</button>

// ❌ Invalid - unbound handler
<button onClick={handleClick}>Click</button>

// ✅ Valid - bound handler (Stream)
<button onClick={events.click}>Click</button>
<button onClick={handlers.submit}>Submit</button>
```

**Error Message Example:**

```
Error: JSX event handler 'onClick' must be bound to a Stream.
Found: Arrow function expression
Expected: A Stream reference (e.g., events.click or handlers.submit)

To fix:
1. Define a handler using handler() or subscribe()
2. Bind it to a Stream property
3. Reference that Stream in the JSX

Example:
  const handlers = {
    click: handler(clickSchema, stateSchema, (event, state) => {
      // handle click
    })
  };
  
  <button onClick={handlers.click}>Click</button>
```

#### 2. Non-Transformable Pattern Detection

Detect patterns that cannot be mechanically transformed and provide guidance:

```typescript
// Complex event handler that can't be auto-transformed
<input onChange={(e) => {
  if (e.target.value.length > 0) {
    setState(e.target.value);
  }
}}>

// Error:
Error: Complex event handler cannot be automatically transformed to reactive pattern.
Found: Conditional logic in inline event handler

This pattern requires manual refactoring:
1. Extract the logic into a handler function
2. Use derive() for the conditional check
3. Bind the handler to a Stream

Suggested refactor:
  const inputHandler = handler(inputSchema, stateSchema, (event, state) => {
    const value = event.target.value;
    const isValid = derive(value, v => v.length > 0);
    ifElse(isValid, () => state.set(value), () => {});
  });
```

#### 3. Reactive Pattern Validation

Ensure reactive patterns are used correctly:

```typescript
// ❌ Invalid - mutating OpaqueRef directly
state.items.push(newItem);

// Error:
Error: Cannot mutate OpaqueRef value directly.
Found: Mutation method 'push' called on OpaqueRef<Array>

OpaqueRef values are immutable. To update arrays:
1. Create a new array with the changes
2. Use state.items.set([...state.items.get(), newItem])

Or use a handler to manage state updates.
```

#### 4. Recipe Structure Validation

Validate overall recipe structure:

```typescript
// ❌ Invalid - missing UI export
export default recipe(schema, schema, (state) => {
  return {
    count: state.count + 1  // This will error in validation
  };
});

// Error:
Error: Recipe must return UI element or have [UI] property.
Found: Object with only data properties

Recipes must render UI. Either:
1. Return a JSX element directly
2. Include a [UI] property with JSX
3. Use a fragment to wrap multiple elements
```

### Validation Modes

```typescript
interface ValidationOptions {
  mode: "strict" | "loose" | "off";

  // Strict: All patterns must be valid (default)
  // Loose: Warn on issues but don't error
  // Off: No validation (not recommended)

  customRules?: ValidationRule[];
  errorFormatter?: (error: ValidationError) => string;
}
```

### Error Message Philosophy

Error messages should:

1. **Identify the problem clearly** - What pattern was found vs expected
2. **Explain why it's invalid** - The reasoning behind the rule
3. **Provide actionable fixes** - Step-by-step guidance
4. **Show examples** - Concrete before/after code
5. **Be LLM-friendly** - Structured format that AI assistants can parse

### Integration with Transformers

Validation runs in three contexts:

1. **Pre-transformation validation** - Catches issues before attempting
   transforms
2. **Transform-time validation** - Ensures transformations are valid
3. **Post-transformation validation** - Verifies output is semantically correct

```typescript
const transformer = createOpaqueRefTransformer(program, {
  mode: "transform",
  validation: {
    mode: "strict",
    preTransform: true,
    postTransform: true,
  },
});
```

## Key Design Principles

1. **Minimal Transformation** - Only transform what's necessary
2. **Preserve Semantics** - Transformed code behaves identically with reactive
   support
3. **Independent Reactivity** - Each operation is independently reactive
4. **Type Safety** - Maintain TypeScript type information
5. **Opt-in Transformation** - Require explicit directive to enable
   transformations
6. **Always Validate** - Semantic validation runs regardless of transformation
   mode
7. **Helpful Errors** - Error messages guide users to correct patterns

## Testing Strategy

### Directory Structure

```
test/fixtures/
├── opaque-refs/          # Core OpaqueRef tests
├── jsx-expressions/      # JSX-specific tests
└── schema/              # Schema generation tests
```

### Test File Conventions

- `*.input.ts` - Source before transformation
- `*.expected.ts` - Expected output
- `no-transform-*` - Cases that should NOT transform

## Configuration

```typescript
interface TransformerOptions {
  mode?: "transform" | "error"; // Default: 'transform'
  debug?: boolean; // Enable debug logging
  logger?: (msg: string) => void; // Custom logger
}
```

## Complete Example

```typescript
/// <cts-enable />
import { cell, derive, ifElse, recipe, toSchema, UI } from "commontools";

interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
}

interface TodoState {
  items: Cell<TodoItem[]>;
  filter: Cell<"all" | "active" | "completed">;
}

const schema = toSchema<TodoState>({
  default: { items: [], filter: "all" },
});

export default recipe(schema, schema, (state) => {
  // These operations will be automatically transformed:
  // state.items is OpaqueRef<TodoItem[]>, so this becomes a derive() call
  const activeItems = state.items.filter((item) => !item.completed);
  const activeCount = activeItems.length;
  const hasActive = activeCount > 0;

  return {
    [UI]: (
      <div>
        <h1>Todo List</h1>
        <p>Active: {activeCount}</p>
        {ifElse(
          hasActive,
          <button>Clear completed</button>,
          <span>All done!</span>,
        )}
      </div>
    ),
    items: state.items,
    filter: state.filter,
  };
});
```

## Notes on Implementation

- Start with the simplest transformations first
- Ensure each phase is fully tested before moving to the next
- Consider performance implications of transformation patterns
- Maintain clear separation between transformer concerns
- Document edge cases and limitations clearly
