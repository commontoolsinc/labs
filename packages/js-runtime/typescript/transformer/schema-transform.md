# Schema Transformer

The schema transformer allows you to write TypeScript interfaces and
automatically transform them into JSONSchema objects at compile time. This
provides a more compact and type-safe way to define schemas for CommonTools
recipes.

## Usage

Instead of manually writing JSONSchema objects:

```typescript
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

You can write TypeScript interfaces and use `toSchema`:

```typescript
interface User {
  name: string;
  age: number;
  email?: string;
}

const userSchema = toSchema<User>();
```

## Features

### Type Support

- Primitive types: `string`, `number`, `boolean`
- Arrays: `string[]`, `User[]`
- Objects and nested interfaces
- Optional properties with `?`
- Date types (converted to `{ type: "string", format: "date-time" }`)

### Special Comments

Add special behaviors with comments:

```typescript
interface RecipeInput {
  values: string[]; // @asCell - makes this a reactive cell
  events: Event[]; // @asStream - makes this a stream
}
```

### Options

Pass additional schema properties:

```typescript
const schema = toSchema<User>({
  title: "User Schema",
  description: "A user in the system",
  default: { name: "Anonymous" },
  examples: [{ name: "John", age: 30 }],
});
```

### Full Example

```typescript
import { handler, recipe, toSchema } from "commontools";

interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
}

interface TodoInput {
  todos: TodoItem[]; // @asCell
}

interface AddTodoEvent {
  text: string;
}

// Schemas are generated at compile time
const inputSchema = toSchema<TodoInput>({
  default: { todos: [] },
});

const addTodoSchema = toSchema<AddTodoEvent>({
  title: "Add Todo",
  description: "Add a new todo item",
});

// Type-safe handlers
const addTodo = handler(
  addTodoSchema,
  inputSchema,
  (event: AddTodoEvent, state: TodoInput) => {
    state.todos.push({
      id: Date.now().toString(),
      text: event.text,
      completed: false,
    });
  },
);
```

## Benefits

1. **More Compact**: TypeScript interfaces are more concise than JSONSchema
2. **Type Safety**: Full TypeScript type checking for your schemas
3. **Single Source of Truth**: Define types once, use everywhere
4. **Compile-Time Generation**: No runtime overhead
5. **IDE Support**: Full autocomplete and type checking

## Limitations

- Union types are converted to `oneOf` schemas
- Complex generic types may not be fully supported
- Comments must be on the same line as the property
- Transformation happens at compile time, so dynamic types aren't supported
