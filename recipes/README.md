# Recipe Framework Documentation

## Overview

The Recipe Framework appears to be a declarative, reactive system for building
integrations and data transformations. It uses a component-based architecture
where recipes are autonomous modules that can import, process, and export data.

## Core Concepts

### Recipe

A recipe is the fundamental building block, defined using the `recipe()`
function. It takes three parameters:

- Input Schema: Defines the input parameters and their types using JSON Schema
- Output Schema: Defines the output structure
- Implementation Function: A function that receives the inputs and returns
  outputs

### Schemas and Type Safety

The framework provides two ways to define schemas for recipes, handlers, and lifted functions:

1. **TypeScript Generics**: Directly pass TypeScript interfaces as type parameters
   ```typescript
   const myHandler = handler<InputType, StateType>((input, state) => { /* ... */ });
   ```

2. **JSON Schema**: Define schemas in JSON format (recommended approach)
   ```typescript
   const myHandler = handler(
     { type: "object", properties: { /* input schema */ } }, 
     { type: "object", properties: { /* state schema */ } },
     (input, state) => { /* ... */ }
   );
   ```

The JSON Schema approach provides several benefits:
- Runtime validation
- Self-documentation
- Better serialization support
- Integration with framework tooling

Importantly, the framework automatically derives TypeScript types from JSON Schemas,
giving you full type inference and type checking in your handler and lift functions.

### Data Flow

The framework uses a reactive programming model:

- `cell`: Represents a reactive state container that can be updated and observed
- `derive`: Creates a derived value that updates when its dependencies change
- `lift`: Similar to derive, but lifts a regular function into the reactive
  graph
  - `derive(param, function)` is an alias to `lift(function)(param)`

### Handlers vs Reactive Functions

There are important differences between the types of functions in the framework:

#### Handlers

Handlers are functions that declare node types in the reactive graph that respond to events:

- Created with `handler()` function
- Can be defined with JSON Schema or TypeScript generics (see Schemas section)
- The state schema can use `asCell: true` to receive cells directly:
  ```typescript
  // Using asCell: true
  const updateCounter = handler(
    { type: "object" }, // Input schema
    { 
      type: "object",
      properties: {
        count: { 
          type: "number", 
          asCell: true // Will receive a Cell instance
        }
      }
    },
    (input, { count }) => {
      // Now count is a Cell<number> instance
      count.set(count.get() + 1);
    }
  );
  ```
- Instantiated in recipes by passing parameters:
  ```typescript
  const stream = definedHandler({ cell1, cell2 });
  ```
- Return a stream that can be:
  - Passed to JSX components as event handlers (e.g., `onClick={stream}`)
  - Returned by a recipe for external consumption
  - Passed to another handler which can call `.send(...)` on it to generate events
- Can update cells and trigger side effects
- Support async operations for data processing
- React to outside events (user interactions, API responses)
- Cannot directly call built-in functions like `llm`

#### Reactive Functions (lift/derive)

- `lift`: Declares a reactive node type that transforms data in the reactive graph
  - Can also use JSON Schema for type safety with input and output schemas:
    ```typescript
    const transformData = lift(
      // Input schema
      {
        type: "object",
        properties: {
          value: { type: "number" },
          multiplier: { type: "number" }
        },
        required: ["value", "multiplier"]
      },
      // Output schema
      {
        type: "number"
      },
      // Function with inferred types
      ({ value, multiplier }) => value * multiplier
    );
    ```
  - When instantiated, it inserts a reactive node in the graph:
    ```typescript
    const newCell = liftedFunction({ cell1, cell2 });
    ```
  - The result is a proxy cell that can be further referenced:
    ```typescript
    const compound = { data: newCell.field };
    ```
- `derive`: A convenience wrapper around lift:
  ```typescript
  // These are equivalent:
  const result1 = derive({ x, y }, ({ x, y }) => x + y);
  const result2 = lift(({ x, y }) => x + y)({ x, y });
  ```
- React to data changes within the reactive graph
- Cannot directly call built-in functions like `llm`

### Data as Futures

Within recipes, functions cannot directly read values - they can only pass references to other nodes. Think of the data passed to a recipe as "futures" - promises of values that will be available when the program runs.

The system allows accessing fields using the dot notation (e.g., `cell.field`), but this doesn't actually read values - it's creating new references to future data.

```tsx
// This doesn't read values, it creates references:
const data = { 
  firstName: user.firstName, 
  lastName: user.lastName 
};
```

### UI Components

Recipes can include UI components using JSX syntax:

- Common components like `common-input`, `common-hstack`, `common-vstack`
- Integration-specific components like `common-google-oauth`
- Custom components can be created as needed

#### JSX and TypeScript

The Recipe Framework uses custom JSX elements that may generate TypeScript
linter errors in the IDE. Common errors include:

- `Property 'common-*' does not exist on type 'JSX.IntrinsicElements'`
- Style-related type errors when using string styles
- Event handler type mismatches

These are expected in the development environment and don't affect runtime
functionality. The framework's processor handles these custom elements correctly
even though TypeScript doesn't recognize them.

### Built-in Functions

Several utility functions are available:

- `llm`: Makes calls to language models with parameters for system prompt, user
  prompt, etc.
- `fetchData`: Fetches data from URLs
- `streamData`: Streams data from URLs
- `ifElse`: Conditional logic for reactive flows
  ```typescript
  // Creates a reactive value that changes based on the condition
  const message = ifElse(
    user.isLoggedIn, 
    str`Welcome back, ${user.name}!`, 
    "Please log in to continue"
  );
  ```
- `str`: Template literal for string interpolation with reactive values, creating reactive strings
  ```typescript
  // Creates a reactive string that updates when cells change
  const greeting = str`Hello, ${user.name}! You have ${notifications.count} new messages.`;
  ```

**Important**: These built-in functions can only be called from within a recipe
function, not from handlers, lift, or derive functions. They create nodes in the
reactive graph and cannot be awaited directly.

## JSX and Reactive Arrays

The Recipe Framework has an interesting approach to handling arrays with JSX:

```typescript
{
  items.map((item) => <some-component data={item} />);
}
```

While this looks like regular JSX mapping, in the Recipe framework, this
actually creates mini-recipes for each item in the array, constructing a
reactive graph. Each mapped item becomes a reactive node that updates when the
source data changes.

In the todo-list example, this pattern is used to create draggable todo items,
where each item has its own encapsulated recipe:

```typescript
{items.map((item: TodoItem) => (
  <common-draggable
    $entity={item}
    spell={JSON.stringify(
      recipe(TodoItemSchema, {}, (item) => ({
        [UI]: (
          <common-todo
            checked={item.done}
            value={item.title}
            ontodo-checked={updateItem({ item })}
            ontodo-input={updateItem({ item })}
          />
        ),
      })),
    )}
  >
    <!-- Component content -->
  </common-draggable>
))}
```

This approach allows for efficient updates and encapsulation of item-specific
logic.

## Best Practices

1. **Use JSON Schema Over TypeScript Generics**: Prefer using JSON Schema for type definitions rather than TypeScript generics. This provides better runtime validation, self-documentation, and compatibility with framework tooling.

2. **Use `asCell: true` for Handler State**: When defining handler state schema, use `asCell: true` for properties that need to be updated. This gives you direct access to the Cell methods like `.set()` and `.get()`.

3. **Reference Data Instead of Copying**: When transforming data, reference the original objects rather than copying all their properties. This maintains reactivity and creates cleaner code:

   ```typescript
   // DO THIS: Reference the original data
   const processedItems = items.map(item => ({
     originalItem: item, // Direct reference
     processed: processItem(item)
   }));
   
   // NOT THIS: Spread/copy all properties
   const processedItems = items.map(item => ({
     id: item.id,         // Copying each field
     name: item.name,     // breaks the reactive
     date: item.date,     // connection to the
     // ... more fields   // original data
     processed: processItem(item)
   }));
   ```

4. **Use Reactive String Templates**: Use the `str` template literal to create reactive strings that update when their inputs change:

   ```typescript
   const message = str`Hello ${user.name}, you have ${notifications.count} notifications`;
   ```

5. **Keep Logic Inside Recipes**: Place as much logic as possible inside recipe functions or the `map` function. This creates a cleaner reactive system where data flow is transparent.

6. **Leverage Framework Reactivity**: Let the framework track changes and updates. Avoid manually tracking which items have been processed or creating complex state management patterns.

7. **Composition**: Build complex flows by composing smaller recipes.

8. **Minimize Side Effects**: Side effects should be managed through handlers rather than directly in recipes.

9. **Schema Reuse**: Define schemas once and reuse them across recipes, handlers, and lifted functions to maintain consistency.

10. **Follow Type Through Schema**: Leverage the framework's automatic type inference from JSON Schema rather than duplicating type definitions with TypeScript interfaces.

## Advanced Type Concepts

### Schema to TypeScript Inference

The framework provides automatic type inference from JSON Schema to TypeScript types:

```typescript
// Define a schema
const PersonSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    age: { type: "number" }
  },
  required: ["name"]
} as const;

// Automatically infer TypeScript type
type Person = Schema<typeof PersonSchema>; 
// Equivalent to: type Person = { name: string; age?: number; };
```

### Cell Type vs Value Type

When working with handlers that use `asCell: true`, it's important to understand the distinction:

```typescript
// Regular state property (value type)
{ count: number } // Handler receives the number directly

// Cell-typed property
{ count: { type: "number", asCell: true } } // Handler receives Cell<number>
```

With Cell-typed properties, the handler function receives actual Cell instances with methods:
- `cell.get()`: Get the current value
- `cell.set(newValue)`: Set a new value
- `cell.update(fn)`: Update using a function

This allows for more control over state updates, including:
- Batching multiple updates
- Conditional updates based on current value
- Handling complex state transitions

## Framework Goals

The primary goal of this framework is to generate "low taint code" that enables effective data flow analysis. In this system:

- Recipes are transparent to data flow analysis
- Functions passed to `handler` or `lift` aren't transparent (they're "tainted")
- JSON Schema provides a clean abstraction for data validation and type safety
- The `asCell: true` pattern maintains reactivity while allowing direct manipulation

By following these principles, applications built with this framework can achieve predictable data flow, easier testing, and better security through data flow isolation.

## Integration Process

1. Define schemas for inputs and outputs
2. Create cells to hold state
3. Implement handlers for user interactions
4. Return an object with processed data and UI components

## Example Pattern

```typescript
export default recipe(
  InputSchema,
  OutputSchema,
  ({ input1, input2 }) => {
    const state = cell<SomeState>([]);
    
    // Define handlers and side effects
    
    return {
      [NAME]: "Recipe Name",
      [UI]: (
        // JSX component
      ),
      outputField1: state,
      outputField2: derivedValue
    };
  }
);
```

## Integration Between Recipes

Recipes can be composed together, where the output of one recipe serves as the
input to another. This is done by:

1. Defining a common data schema between recipes
2. Exporting data from the source recipe
3. Importing that data as input in the consuming recipe

For example, our Email Summarizer recipe takes emails from the Gmail recipe as
input:

- Gmail recipe exports an array of emails
- Email Summarizer recipe consumes these emails and processes them with LLM

## LLM Integration

The framework provides integration with language models through the `llm`
function:

```typescript
const result = llm({
  system: "System prompt here", // Instructions for the LLM
  prompt: "User prompt here", // Content to process
  // Optional parameters
  stop: "custom stop sequence", // Stop generation at this sequence
  max_tokens: 1000, // Max tokens to generate
});
```

**Important restrictions**:

1. The `llm` function can only be called directly within a recipe function, not
   in handlers, lift, or derive functions
2. You cannot `await` the result directly, as it's a node in the reactive graph
3. To use LLM results, you need to access them through the reactive graph (e.g.,
   via derive)

The result object includes:

- `result`: The generated text
- `partial`: Streaming partial results
- `pending`: Boolean indicating if the request is still processing
- `error`: Any error that occurred

## Reactive Processing Pattern

A common pattern in recipes is:

1. Initialize state using `cell()`
2. Create derived values with `derive()`
3. Define handlers for UI events and data processing
4. Create async functions for complex operations
5. Return a recipe object with UI and exported values

## Example Pattern for Data Transformation Recipes

```typescript
export default recipe(
  InputSchema,
  OutputSchema,
  ({ inputData, settings }) => {
    // Initialize state
    const processedData = cell<ProcessedData[]>([]);
    
    // Process data with LLM (directly in recipe)
    // Notice we call map() directly on the cell - inputData is a cell
    const processedItems = inputData.map(item => {
      return {
        originalItem: item,
        llmResult: llm({
          system: "System prompt",
          prompt: `Process this: ${item.content}`,
        })
      };
    });
    
    // Create derived value from LLM results
    const summaries = derive(processedItems, items => 
      items.map(item => ({
        id: item.originalItem.id,
        summary: item.llmResult.result || "Processing...",
      }))
    );
    
    // Handler for user interactions
    const refreshData = handler<{}, { processedData: Cell<ProcessedData[]> }>(
      (_, state) => {
        // Update state based on user action
        // Note: Cannot call llm() directly here
      }
    );
    
    return {
      [NAME]: "Recipe Name",
      [UI]: (
        // JSX UI component
      ),
      processedData,
    };
  }
);
```
