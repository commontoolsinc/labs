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

### Important Scope Limitation

**OpaqueRef transformations only apply within JSX expressions.** Statement-level transformations (like if statements, loops, etc.) are not supported because they require complex control flow analysis and handling of side effects.

```typescript
// ✅ Transformed - JSX expression context
<div>{count + 1}</div>  // → <div>{derive(count, _v => _v + 1)}</div>

// ❌ Not transformed - statement context
if (count > 5) {  // Statements with OpaqueRef are not transformed
  console.log("High");
}
```

### Core Transformation Patterns (JSX Expression Context Only)

The following transformations apply **only within JSX expressions**. OpaqueRef operations in regular TypeScript statements are not transformed.

#### 1. Binary Operations in JSX

Operations on OpaqueRef values inside JSX are wrapped in `derive()`:

```typescript
// Input - JSX context
<div>
  <span>Next: {count + 1}</span>
  <span>Total: {price * quantity}</span>
  <span>Valid: {age > 18 ? "Yes" : "No"}</span>
</div>

// Output
<div>
  <span>Next: {derive(count, (_v) => _v + 1)}</span>
  <span>Total: {derive({ price, quantity }, ({ price: _v1, quantity: _v2 }) => _v1 * _v2)}</span>
  <span>Valid: {ifElse(derive(age, (_v) => _v > 18), "Yes", "No")}</span>
</div>
```

Supported operators: `+`, `-`, `*`, `/`, `%`, `>`, `<`, `>=`, `<=`, `==`, `===`,
`!=`, `!==`

#### 2. Ternary Conditionals in JSX

When a ternary operator's condition is an OpaqueRef inside JSX, it transforms to
`ifElse()`:

```typescript
// Input - JSX context
<div>{isActive ? "on" : "off"}</div>

// Output
<div>{ifElse(isActive, "on", "off")}</div>
```

Note: This transformation only occurs when the condition (`isActive`) is an
OpaqueRef type.

#### 3. Property Access and Method Calls in JSX

When accessing properties or calling methods on OpaqueRef values inside JSX:

```typescript
// Input - JSX context
<div>
  <span>Length: {str.length}</span>
  <span>Upper: {str.toUpperCase()}</span>
  <span>Name: {user.name}</span>
</div>

// Output
<div>
  <span>Length: {derive(str, (_v) => _v.length)}</span>
  <span>Upper: {derive(str, (_v) => _v.toUpperCase())}</span>
  <span>Name: {user.name}</span>
</div>
```

Key principle: Direct property access on an OpaqueRef object returns another
OpaqueRef, while operations on the value require `derive()`.

#### 4. Direct OpaqueRef References in JSX

Direct OpaqueRef references inside JSX are preserved as-is, allowing the UI framework to handle reactivity:

```typescript
// Input & Output (no transformation needed)
<div>{count}</div>
<span>{user.name}</span>
```

#### 5. Array and Object Literals in JSX

Each element/property is transformed independently when used in JSX:

```typescript
// Input - JSX context
<div data-values={[count + 1, price * 2]} />
<div data-info={{ next: count + 1, total: price * tax }} />

// Output
<div data-values={[derive(count, (_v) => _v + 1), derive(price, (_v) => _v * 2)]} />
<div data-info={{
  next: derive(count, (_v) => _v + 1),
  total: derive({ price, tax }, ({ price: _v1, tax: _v2 }) => _v1 * _v2),
}} />
```

### Current Limitations

1. **Statement-Level Transformations** - Not supported:
   ```typescript
   // These patterns in regular statements are NOT transformed
   if (count > 5) { ... }           // ❌ If statements
   while (count < 10) { ... }       // ❌ Loops
   const result = count + 1;        // ❌ Variable declarations outside JSX
   ```
   **Why:** Statement transformations require complex control flow analysis and
   handling of side effects. OpaqueRef transformations are limited to JSX
   expression contexts where the transformation is straightforward.

2. **Array Methods** - Not yet supported:
   ```typescript
   const items = cell([1, 2, 3]);
   const doubled = items.map((x) => x * 2); // ❌ Not transformed
   const filtered = items.filter((x) => x > 2); // ❌ Not transformed
   ```
   **Why:** Array methods require special handling to maintain reactivity
   through the callback function.

3. **Async Operations** - Not yet supported:
   ```typescript
   const url = cell("https://api.example.com");
   const data = await fetch(url); // ❌ Not transformed
   ```
   **Why:** Async operations with OpaqueRef require special handling for promise
   resolution and error states.

4. **Destructuring** - Extracts values, losing reactivity:
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
} as const satisfies JSONSchema;
```

### Handler and Recipe Transformations

The schema transformer also converts `handler` and `recipe` calls with type arguments:

```typescript
/// <cts-enable />
import { handler, recipe, Cell } from "commontools";

// Handler with type arguments
const myHandler = handler<ClickEvent, { count: Cell<number> }>((event, state) => {
  state.count.set(state.count.get() + 1);
});

// Recipe with type argument
export default recipe<CounterState>("Counter", (state) => {
  return { [UI]: <div>Count: {state.count}</div> };
});

// Transforms to:
const myHandler = handler({
  type: "object",
  additionalProperties: true
} as const satisfies JSONSchema, {
  type: "object",
  properties: {
    count: { type: "number", asCell: true }
  },
  required: ["count"]
} as const satisfies JSONSchema, (event, state) => {
  state.count.set(state.count.get() + 1);
});

export default recipe({
  type: "object",
  properties: {
    count: { type: "number" }
  },
  required: ["count"]
} as const satisfies JSONSchema, "Counter", (state) => {
  return { [UI]: <div>Count: {state.count}</div> };
});
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
} as const satisfies JSONSchema;
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

## Current Transformer Architecture

The OpaqueRef transformer handles both OpaqueRef transformations AND schema transformations for `handler` and `recipe` calls. This is intentional - the OpaqueRef transformer:

1. **Transforms JSX expressions** - Wraps OpaqueRef operations in `derive()` and `ifElse()`
2. **Transforms handler/recipe calls** - Converts type arguments to schema objects
3. **Manages imports** - Adds necessary imports for `derive`, `ifElse`, `toSchema`

The separate schema transformer is used for standalone `toSchema<T>()` calls.

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
8. **Statement vs JSX Context** - Only transform OpaqueRef operations within JSX expressions

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
import { cell, derive, ifElse, recipe, toSchema, UI, Cell } from "commontools";

interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
}

interface TodoState {
  items: TodoItem[];
  filter: "all" | "active" | "completed";
}

export default recipe<TodoState>("TodoList", (state) => {
  // These statement-level operations are NOT transformed:
  // They will fail at runtime if you try to use OpaqueRef directly
  // const activeItems = state.items.filter((item) => !item.completed); // ❌ Not transformed
  // const activeCount = activeItems.length; // ❌ Not transformed
  
  return {
    [UI]: (
      <div>
        <h1>Todo List</h1>
        {/* These JSX expressions ARE transformed: */}
        <p>Total: {state.items.length}</p>
        <p>Status: {state.filter === "all" ? "All Items" : "Filtered"}</p>
        <div>
          {/* Complex expressions in JSX get wrapped in derive: */}
          <span>Active: {derive(state.items, items => items.filter(item => !item.completed).length)}</span>
        </div>
      </div>
    ),
    items: state.items,
    filter: state.filter,
  };
});

// After transformation:
export default recipe({
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          completed: { type: "boolean" }
        },
        required: ["id", "text", "completed"]
      }
    },
    filter: {
      type: "string",
      enum: ["all", "active", "completed"]
    }
  },
  required: ["items", "filter"]
} as const satisfies JSONSchema, "TodoList", (state) => {
  return {
    [UI]: (
      <div>
        <h1>Todo List</h1>
        <p>Total: {derive(state.items, _v => _v.length)}</p>
        <p>Status: {ifElse(derive(state.filter, _v => _v === "all"), "All Items", "Filtered")}</p>
        <div>
          <span>Active: {derive(state.items, items => items.filter(item => !item.completed).length)}</span>
        </div>
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
