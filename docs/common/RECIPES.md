# Recipe Framework Documentation

## Overview

The Recipe Framework is a declarative, reactive system for building
integrations and data transformations. It uses a component-based architecture
where recipes are autonomous modules that can import, process, and export data.

## Core Concepts

### Recipe

A recipe is the fundamental building block, defined using the `recipe<InputType, OutputType>('My Recipe', (input) => {})`
function. It takes two types and two parameters:

- Types: define Input and Output relationships for composition with other recipes
  - Properties such as `[UI]` and `[NAME]` do not have to be explicitly included in the output type
- Parameters: a descriptive name and a function that receives the inputs and returns
  outputs

### Types and Runtime Safety

The framework uses a TypeScript-first approach for defining types in recipes, handlers, and lifted functions:

```typescript
const myHandler = handler<InputType, StateType>(
  (input, state) => {/* ... */},
);
```

This TypeScript-first approach provides several benefits:

- Full TypeScript type inference and checking
- Clean, readable type definitions
- Integration with IDE tooling
- Express Cell vs readonly value requirements directly in types

Importantly, the framework automatically handles type validation and serialization using the CTS (Common Tools TypeScript) system. This gives you runtime validation, self-documentation, and serialization support. You can express your desire for Cells vs readonly values directly in TypeScript types, and the system will fulfill the values by reflecting on the types.

### Data Flow

The framework uses a reactive programming model:

- `cell`: Represents a reactive state container that can be updated and observed
- `derive`: Creates a derived value that updates when its dependencies change
- `lift`: Similar to derive, but lifts a regular function to work on reactive values
  - `derive(param, function)` is an alias to `lift(function)(param)`
- `handler`: Creates an event handler that always fires with up-to-date dependencies (possibly mutating them)
  - takes two parameters, an event and state (bound variables)
  - e.g. `<ct-button onClick={myHandler({ counter })}>`

### Handlers vs Reactive Functions

There are important differences between the types of functions in the framework:

#### Handlers

(For even more detail, see `HANDLERS.md`)

Handlers are functions that declare node types in the reactive graph that
respond to events:

- Created with `handler()` function
- Use `Cell<>` to indicate you want a reactive value (for mutation, usually):

  ```typescript
  const updateCounter = handler<never, { count: Cell<number> }>(
    (input, { count }) => {
      // Now count is a Cell<number> instance
      count.set(count.get() + 1);
    },
  );
  ```

- Instantiated in recipes by passing parameters:

  ```typescript
  const stream = definedHandler({ cell1, cell2 });
  ```

- Return a stream that can be:
  - Passed to JSX components as event handlers (e.g., `onClick={stream}`)
  - Returned by a recipe for external consumption
  - Passed to another handler which can call `.send(...)` on it to generate
    events
- Can update cells and trigger side effects
- Support async operations for data processing
- React to outside events (user interactions, API responses)
- Cannot directly call built-in functions like `llm`

#### Reactive Functions (lift/derive)

- `lift`: Declares a reactive node type that transforms data in the reactive
  graph

    ```typescript
    const transformData = lift(
      ({ value, multiplier }: { value: number, multiplier: number }) => value * multiplier,
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

Within recipes, functions cannot directly read values - they can only pass
references to other nodes. Think of the data passed to a recipe as "futures" -
promises of values that will be available when the program runs.

The system allows accessing fields using the dot notation (e.g., `cell.field`),
but this doesn't actually read values - it's creating new references to future
data.

```tsx
// This doesn't read values, it creates references:
const data = {
  firstName: user.firstName,
  lastName: user.lastName,
};
```

### UI Components

Recipes can include UI components using JSX syntax:

- Common components like `ct-input`, `ct-hstack`, `ct-vstack`
- Integration-specific components like `common-google-oauth`
- Custom components can be created as needed via `const MyComponent = recipe(...)` `<MyComponent ... />`

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
    "Please log in to continue",
  );
  ```

- `str`: Template literal for string interpolation with reactive values,
  creating reactive strings

  ```typescript
  // Creates a reactive string that updates when cells change
  const greeting =
    str`Hello, ${user.name}! You have ${notifications.count} new messages.`;
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

1. **Use CTS TypeScript Types**: Define clear TypeScript interfaces for your
   input and output schemas. This provides runtime validation, self-documentation,
   and compatibility with framework tooling through the CTS (Common Tools TypeScript) system.

2. **Use `Cell<>` for Handler State**: When defining handler state types, use `Cell<>` for properties that need to be updated. This gives you direct access to the Cell methods like `.set()` and `.get()`.

3. **⚠️ No DOM Access Allowed**: DOM access is not allowed in patterns. Use cells to capture and manage all state instead:

   ```typescript
   // ❌ DON'T DO THIS - DOM access won't work
   const addItem = handler((_, { items }) => {
     const input = document.getElementById('item-input');
     const value = input.value; // This won't work!
     items.push({ title: value });
   });

   // ✅ DO THIS - Use cells for input state
   const name = cell("");
   const category = cell("Other");

   // Bind to inputs
   <ct-input $value={name} placeholder="Name" />
   <ct-select $value={category}>...</ct-select>

   // Access in handlers
   const addItem = handler((_event, { items, name, category }) => {
     const nameValue = name.get();
     if (nameValue.trim()) {
       items.push({ name: nameValue, category: category.get() });
       name.set("");
     }
   });
   ```

4. **Array Mutation Patterns - Two Approaches**: Choose the right pattern based on what you're doing:

   **Pattern A: Bidirectional Binding for Simple Value Updates**

   For updating individual item properties, use bidirectional binding:

   ```typescript
   // ✅ PATTERN A - No handler needed for simple property updates
   {items.map((item: OpaqueRef<ShoppingItem>) => (
     <div>
       <ct-checkbox $checked={item.done}>
         {item.title}
       </ct-checkbox>
       <ct-input $value={item.category} />
     </div>
   ))}
   ```

   The cells update automatically when users interact with the UI. No handler needed!

   **Pattern B: Handlers for Structural Changes**

   For adding, removing, or reordering items, use handlers:

   ```typescript
   // ✅ PATTERN B - Handler for adding items
   const addItem = handler<
     { detail: { message: string } },
     { items: Cell<ShoppingItem[]> }
   >(({ detail }, { items }) => {
     const itemName = detail?.message?.trim();
     if (!itemName) return;

     const currentItems = items.get();
     items.set([...currentItems, { title: itemName, done: false }]);
   });

   // ✅ PATTERN B - Handler for removing items
   const removeItem = handler<
     unknown,
     { items: Cell<ShoppingItem[]>; item: Cell<ShoppingItem> }
   >((_event, { items, item }) => {
     const currentItems = items.get();
     const index = currentItems.findIndex((el) => item.equals(el as any));
     if (index >= 0) {
       items.set(currentItems.toSpliced(index, 1));
     }
   });

   // Usage
   <ct-button onClick={removeItem({ items, item })}>Remove</ct-button>
   ```

   **Why toSpliced?** It's more explicit about what's being removed (index and count) and integrates better with Cell equality checking.

   **Decision Guide:**
   - **Simple property updates** (checking box, changing text): Use bidirectional binding
   - **Structural changes** (add, remove, reorder): Use handlers
   - **Complex operations** (validation, side effects): Use handlers

5. **Prefer Item References Over Indices**: When working with arrays, pass direct item references instead of indices:

   ```typescript
   // ✅ DO THIS - Pass item reference
   {items.map((item: OpaqueRef<ShoppingItem>) => (
     <ct-button onClick={removeItem({ items, item })}>Remove</ct-button>
   ))}

   const removeItem = handler((_, { items, item }) => {
     const currentItems = items.get();
     const index = currentItems.findIndex((el) => item.equals(el as any));
     if (index >= 0) {
       items.set(currentItems.toSpliced(index, 1));
     }
   });

   // ❌ AVOID - Pass index
   {items.map((item, index) => (
     <ct-button onClick={removeItem({ items, index })}>Remove</ct-button>
   ))}
   ```

   **Why?** Using `cell.equals(other)` is more reliable than index-based operations, especially when items are reordered or modified.

6. **Define Handlers and Lifts at Module Level**: Place `handler` and `lift` definitions outside the recipe function for reusability and performance:

   ```typescript
   // ✅ CORRECT - Module level
   const addItem = handler(
     (_event, { items, name }: { items: Cell<Item[]>; name: Cell<string> }) => {
       if (name.get().trim()) {
         items.push({ title: name.get() });
         name.set("");
       }
     }
   );

   const groupByCategory = lift((items: Item[]) => {
     return items.reduce((acc, item) => {
       if (!acc[item.category]) acc[item.category] = [];
       acc[item.category].push(item);
       return acc;
     }, {} as Record<string, Item[]>);
   });

   export default recipe("my-recipe", ({ items, name }) => {
     const grouped = groupByCategory(items);
     return {
       [UI]: <ct-button onClick={addItem({ items, name })}>Add</ct-button>,
       grouped,
     };
   });

   // ❌ INCORRECT - Inside recipe function
   export default recipe("my-recipe", ({ items, name }) => {
     const addItem = handler((_event, { items, name }) => { /* ... */ });
     const grouped = lift((items) => { /* ... */ })(items);
     // This creates new function instances on each evaluation
   });
   ```

7. **Type Array Map Parameters as OpaqueRef**: When mapping over cell arrays with bidirectional binding, you **must** add the `OpaqueRef<T>` type annotation to make it type-check correctly:

   ```typescript
   // ✅ CORRECT - Type as OpaqueRef for bidirectional binding
   {items.map((item: OpaqueRef<ShoppingItem>) => (
     <div>
       <ct-checkbox $checked={item.done}>
         <span>{item.title}</span>
       </ct-checkbox>
       <ct-input $value={item.category} />
     </div>
   ))}

   // ❌ INCORRECT - Missing type leads to type errors with $-props
   {items.map((item) => (
     <ct-checkbox $checked={item.done} /> // Type error!
   ))}
   ```

   **Why is this needed?** When you use `.map()` on a Cell array, TypeScript cannot always infer the correct type for bidirectional binding properties. The `OpaqueRef<T>` annotation tells TypeScript that each item is a cell-like reference that supports property access and bidirectional binding.

8. **Understand When Conditionals Work in JSX**: Ternary operators work fine in JSX **attributes**, but you need `ifElse()` for conditional **rendering** and **data transformations**:

   ```typescript
   // ✅ TERNARIES WORK - In JSX attributes (simple values)
   <span style={item.done ? "text-decoration: line-through;" : ""}>
     {item.title}
   </span>

   <div class={isActive ? "active" : "inactive"}>
     Content
   </div>

   // ❌ DON'T USE - Ternaries for conditional rendering
   const tableHeader = (
     <tr>
       <th>Name</th>
       {settings.showDetails ? <th>Details</th> : null} // This won't work!
     </tr>
   );

   // ✅ USE ifElse - For conditional rendering
   const tableHeader = (
     <tr>
       <th>Name</th>
       {ifElse(settings.showDetails, <th>Details</th>, null)}
     </tr>
   );

   // ❌ DON'T USE - if statements in data transformations
   const result = emails.map((email) => {
     if (email.hasContent) { // This won't work!
       return processEmail(email);
     } else {
       return { email, empty: true };
     }
   });

   // ✅ USE ifElse - For data transformations
   const result = emails.map((email) =>
     ifElse(
       email.hasContent,
       () => processEmail(email),
       () => ({ email, empty: true }),
     )
   );
   ```

   **Rule of thumb:**
   - **Ternaries in attributes**: ✅ Works great for simple string/number values
   - **Ternaries for elements**: ❌ Use `ifElse()` instead
   - **if statements**: ❌ Never work, use `ifElse()` instead

9. **Understand lift vs derive**: Know when to use each reactive function:

   ```typescript
   // lift - Creates a reusable function that can be called multiple times
   const groupByCategory = lift((items: Item[]) => {
     return items.reduce((acc, item) => {
       if (!acc[item.category]) acc[item.category] = [];
       acc[item.category].push(item);
       return acc;
     }, {} as Record<string, Item[]>);
   });

   // Call it with different inputs
   const grouped1 = groupByCategory(items);
   const grouped2 = groupByCategory(otherItems);

   // derive - Directly computes a value from cells (convenience wrapper)
   const categories = derive(itemsByCategory, (grouped) => {
     return Object.keys(grouped).sort();
   });

   // These are equivalent:
   const result1 = derive({ x, y }, ({ x, y }) => x + y);
   const result2 = lift(({ x, y }) => x + y)({ x, y });
   ```

   **When to use lift:** When you need a reusable transformation function that you'll call with different inputs.

   **When to use derive:** When you're computing a single value from specific cells.

10. **Access Properties Directly on Derived Objects**: You can access properties on derived objects without additional helpers:

    ```typescript
    const itemsByCategory = groupByCategory(items);
    // Returns Record<string, Item[]>

    // ✅ DO THIS - Direct property access works
    {categories.map((categoryName) => (
      <div>
        <h3>{categoryName}</h3>
        {itemsByCategory[categoryName].map((item) => (
          <div>{item.name}</div>
        ))}
      </div>
    ))}

    // ❌ NOT NEEDED - Don't create unnecessary helpers
    const getCategoryItems = lift((grouped, category) => grouped[category]);
    {itemsByCategory[categoryName].map((item) => ...)}
    ```

11. **Prefer Inline Expressions Over Intermediate Variables**: Use inline expressions like `(array ?? []).map(...)` instead of extracting to variables, unless clarity genuinely improves:

    ```typescript
    // ✅ PREFERRED - Inline expression is clear and concise
    <div>
      {(groupedItems[category] ?? []).map((item: OpaqueRef<Item>) => (
        <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
      ))}
    </div>

    // ❌ AVOID - Unnecessary intermediate variable
    {derive(groupedItems, (groups) => {
      const categoryItems = groups[category] || [];
      return (
        <div>
          {categoryItems.map(item => ...)}
        </div>
      );
    })}

    // ✅ GOOD USE - When expression is complex or reused
    const sortedItems = derive(items, (list) => {
      return list
        .filter(item => !item.done)
        .sort((a, b) => a.priority - b.priority)
        .slice(0, 10);
    });

    // Now use sortedItems multiple times
    <div>Count: {sortedItems.length}</div>
    <div>{sortedItems.map(...)}</div>
    ```

    **When to use intermediate variables:**
    - The expression is complex (multiple operations)
    - The value is used multiple times
    - Extracting improves readability significantly

    **When to use inline:**
    - Simple property access or null coalescing
    - Single use
    - The expression is self-explanatory

12. **Remove Unnecessary Keys**: Don't add `key` attributes unless you need them for dynamic reordering or reconciliation:

    ```typescript
    // ❌ AVOID - Unnecessary key attribute
    {items.map((item: OpaqueRef<Item>, index) => (
      <div key={index}>
        <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
      </div>
    ))}

    // ✅ PREFERRED - No key needed for simple rendering
    {items.map((item: OpaqueRef<Item>) => (
      <div>
        <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
      </div>
    ))}

    // ✅ WHEN KEYS ARE NEEDED - For dynamic reordering or performance
    {sortableItems.map((item: OpaqueRef<Item>) => (
      <draggable-item key={item.id}>
        <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
      </draggable-item>
    ))}
    ```

    **When keys ARE needed:**
    - Items can be reordered by user
    - Items are frequently added/removed at arbitrary positions
    - You're experiencing performance issues with list updates

    **When keys are NOT needed:**
    - Simple, static rendering
    - Items only added to end or removed from end
    - Most basic list patterns

13. **Understand Variable Scoping Limitations**: Variables from outer scopes don't work as expected inside `.map()` callbacks:

    ```typescript
    // ❌ DOESN'T WORK - Can't access `category` from outer map
    {categories.map((category) => (
      {derive(items, (arr) => arr.filter(i => i.category === category))}
      // category is not accessible here
    ))}

    // ✅ WORKS - Use property access or pre-computed values
    const itemsByCategory = groupByCategory(items);
    {categories.map((category) => (
      {itemsByCategory[category].map((item) => (
        <div>{item.name}</div>
      ))}
    ))}
    ```

14. **Understand lift Currying with Multiple Parameters**: Multi-parameter lift creates curried functions:

    ```typescript
    // lift with multiple parameters creates curried function
    const formatValue = lift((label: string, value: number) => `${label}: ${value}`);

    // ✅ CORRECT - Call with currying
    const result = formatValue("count")(42); // "count: 42"

    // ❌ INCORRECT - This won't work
    const result = formatValue("count", 42);

    // Usually better to use single parameter with object
    const formatValue = lift(({ label, value }: { label: string; value: number }) =>
      `${label}: ${value}`
    );
    const result = formatValue({ label: "count", value: 42 });
    ```

    **Recommendation:** In most cases, direct property access or single-parameter lifts are clearer than multi-parameter curried functions.

15. **Reference Data Instead of Copying**: When transforming data, reference the
   original objects rather than copying all their properties. This maintains
   reactivity and creates cleaner code:

   ```typescript
   // DO THIS: Reference the original data
   const processedItems = items.map((item) => ({
     originalItem: item, // Direct reference
     processed: processItem(item),
   }));

   // NOT THIS: Spread/copy all properties
   const processedItems = items.map((item) => ({
     id: item.id, // Copying each field
     name: item.name, // breaks the reactive
     date: item.date, // connection to the
     // ... more fields   // original data
     processed: processItem(item),
   }));
   ```

16. **Use Reactive String Templates**: Use the `str` template literal to create
   reactive strings that update when their inputs change:

   ```typescript
   const message =
     str`Hello ${user.name}, you have ${notifications.count} notifications`;
   ```

17. **Keep Logic Inside Recipes**: Place as much logic as possible inside recipe
   functions or the `map` function. This creates a cleaner reactive system where
   data flow is transparent.

18. **Leverage Framework Reactivity**: Let the framework track changes and
   updates. Avoid manually tracking which items have been processed or creating
   complex state management patterns.

19. **Composition**: Build complex flows by composing smaller recipes.

20. **Minimize Side Effects**: Side effects should be managed through handlers
   rather than directly in recipes.

21. **Type Reuse**: Define types once and reuse them across recipes, handlers, and lifted functions to maintain consistency.

## Type Best Practices

When defining types in the Recipe Framework, follow these guidelines for best
results:

1. **Define Types as Reusable Interfaces**: Declare types as interfaces or type aliases for reuse and
   reference:

   ```typescript
   type User = {
     id: string;
     name: string;
     email?: string;
   };
   ```

2. **Use Descriptive Type Names**: Always use clear, descriptive names that explain what the type represents:

   ```typescript
   // DO THIS
   type UserPreferences = {
     theme: "light" | "dark" | "system";
     fontSize: number;
     notifications: boolean;
   };

   // NOT THIS
   type Config = { theme: string; size: number; alerts: boolean };
   ```

3. **Use Default<> for Sensible Defaults**: Where possible, provide sensible default values using the CTS Default<> type:

   ```typescript
   type UserSettings = {
     theme: Default<"light" | "dark" | "system", "system">;
     fontSize: Default<number, 14>;
     notifications: Default<boolean, true>;
   };
   ```

4. **Compose Types Instead of Duplicating**: For complex objects, compose existing types:

   ```typescript
   type User = {
     id: string;
     name: string;
     email: string;
   };

   type Post = {
     author: User; // Reference the existing type
     content: string;
     timestamp: Date;
   };
   ```

5. **Document Types with Comments**: Add JSDoc comments to types for better self-documentation:

   ```typescript
   /** User's primary email address used for notifications */
   type Email = string;

   type User = {
     id: string;
     name: string;
     /** User's primary email address used for notifications */
     email?: Email;
   };
   ```

6. **Use Cell<> for Reactive State**: In handler state types, use `Cell<>` for properties that need direct access to Cell methods:

   ```typescript
   type HandlerState = {
     /** Counter value that can be directly manipulated */
     counter: Cell<number>;
     readonlyValue: string; // Regular values are readonly
   };
   ```

7. **Make Optional vs Required Explicit**: Use TypeScript's optional properties (?) to clearly indicate what's required:

   ```typescript
   type User = {
     id: string;        // Required
     name: string;      // Required
     email?: string;    // Optional
   };
   ```

8. **Use Type Composition**: Break down complex types into smaller, reusable parts:

   ```typescript
   type Address = {
     street: string;
     city: string;
     zipCode: string;
   };

   type Contact = {
     phone?: string;
     email: string;
   };

   type User = {
     // Basic info
     id: string;
     name: string;
     // Composed types
     address: Address;
     contact: Contact;
   };
   ```

9. **Use Union Types for Enums**: Define enums with union types and const assertions:

   ```typescript
   const StatusValues = ["pending", "active", "suspended", "deleted"] as const;
   type Status = typeof StatusValues[number]; // "pending" | "active" | "suspended" | "deleted"

   type User = {
     id: string;
     name: string;
     status: Default<Status, "pending">; // Provide a reasonable default
   };
   ```

## Advanced Type Concepts

### When to Use [ID]

The `[ID]` symbol is often seen in examples, but **most patterns don't need it**. Only add `[ID]` when you have specific identity and stability requirements.

```typescript
import { ID } from "commontools";

interface Item {
  [ID]: number;  // Only add this when you need it!
  title: string;
}
```

## Decision Guide: Do You Need [ID]?

**Start without [ID]**. Only add it if you encounter specific bugs or have one of the use cases below.

### When [ID] is NOT Needed (Most Cases)

✅ **Use simple interfaces without [ID] for:**

- **Basic lists and CRUD operations**
  ```typescript
  interface ShoppingItem {
    title: string;
    done: boolean;
    category: string;
  }
  ```

- **Items that are only displayed, not referenced**
- **Adding items to the end of arrays**
- **Removing items by button click (using index)**
- **Editing items in place**
- **Most todo lists, shopping lists, and simple data displays**

**Why you don't need it:** The framework handles reactivity and updates correctly for these common cases without requiring stable identifiers.

### When [ID] IS Needed (Specific Cases)

❌ **Only add [ID] when you need:**

#### 1. Creating Data URIs for Network References

When items need stable references across the network:

```typescript
import { ID } from "commontools";

interface NetworkItem {
  [ID]: number;  // Needed for stable cross-network reference
  title: string;
  data: string;
}

const createReferenceable = lift((title: string) => {
  return {
    [ID]: Date.now(),  // Stable ID for URI creation
    title,
    data: "content",
  };
});
```

#### 2. Creating Items Within lift Functions

When generating new items inside `lift`:

```typescript
const generateItems = lift((count: number) => {
  return Array.from({ length: count }, (_, i) => ({
    [ID]: i,  // Needed for stable references
    title: `Item ${i}`,
  }));
});
```

#### 3. Complex Reordering or Front-Insertion

When you need to insert items at the beginning of arrays or have complex drag-and-drop:

```typescript
interface ReorderableItem {
  [ID]: number;  // Needed for stable identity during reordering
  title: string;
  position: number;
}

const insertAtStart = handler<unknown, { items: Cell<ReorderableItem[]> }>(
  (_, { items }) => {
    const current = items.get();
    items.set([{ [ID]: Date.now(), title: "New", position: 0 }, ...current]);
  }
);
```

**Note:** Even for reordering, try without [ID] first. Many reordering scenarios work fine without it.

## Examples: With and Without [ID]

### Example 1: Basic Shopping List (No [ID] Needed)

```typescript
// ✅ SIMPLE - No [ID] needed
interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
  category: Default<string, "Uncategorized">;
}

const addItem = handler<
  { detail: { message: string } },
  { items: Cell<ShoppingItem[]> }
>(({ detail }, { items }) => {
  const itemName = detail?.message?.trim();
  if (!itemName) return;

  const currentItems = items.get();
  items.set([...currentItems, { title: itemName, done: false, category: "Uncategorized" }]);
});

const removeItem = handler<
  unknown,
  { items: Cell<ShoppingItem[]>; item: Cell<ShoppingItem> }
>((_event, { items, item }) => {
  const currentItems = items.get();
  const index = currentItems.findIndex((el) => item.equals(el as any));
  if (index >= 0) {
    items.set(currentItems.toSpliced(index, 1));
  }
});
```

This works perfectly without [ID] because:
- Items are added to the end
- Removal uses item references with `.equals()`
- No cross-network references needed

### Example 2: When You Actually Need [ID]

```typescript
// ✅ CORRECT - [ID] needed for data URIs and cross-charm references
import { ID } from "commontools";

interface ReferencedNote {
  [ID]: number;  // Needed because notes reference each other
  title: string;
  content: string;
  backlinks: number[];  // References to other note IDs
}

const createNote = lift((title: string, content: string) => {
  return {
    [ID]: Date.now(),  // Stable ID for backlinking
    title,
    content,
    backlinks: [],
  };
});

// Notes can now reference each other by ID
const addBacklink = handler<
  unknown,
  { note: Cell<ReferencedNote>; targetId: number }
>((_event, { note, targetId }) => {
  const current = note.get();
  note.set({
    ...current,
    backlinks: [...current.backlinks, targetId],
  });
});
```

## Trade-offs

| Approach | Pros | Cons | When to Use |
|----------|------|------|-------------|
| **Without [ID]** (recommended) | • Simpler code<br>• Less boilerplate<br>• Easier to understand<br>• Works for 90% of cases | • May have issues with front-insertion in some cases<br>• No stable cross-network references | • Todo lists<br>• Shopping lists<br>• Simple CRUD<br>• Display-only data<br>• Most basic patterns |
| **With [ID]** (when needed) | • Stable references<br>• Handles all operations<br>• Cross-network linking<br>• Complex reordering | • More complex code<br>• Requires ID management<br>• More boilerplate | • Data URIs<br>• Backlinking systems<br>• Cross-charm references<br>• Complex drag-and-drop<br>• Generating items in `lift` |

## Rule of Thumb

**Start without `[ID]`. Only add it if:**
1. You're creating data URIs for cross-network references
2. You're generating new items within a `lift` function
3. You encounter specific bugs with item identity during complex operations

**Don't add `[ID]` just because you see it in examples.** The `list-operations.tsx` example demonstrates advanced features, but your basic shopping list, todo list, or simple CRUD pattern doesn't need it.

### TypeScript to Runtime Schema

The CTS framework automatically handles your TypeScript types at runtime:

```typescript
// Define TypeScript types
type Person = {
  name: string;
  age?: number;
};

// The framework automatically processes this TypeScript type
// No manual schema definition needed - it's all handled by CTS reflection
```

### Cell Type vs Value Type

When working with handlers, it's important to understand the distinction:

```typescript
// Regular state property (value type)
{ count: number } // Handler receives the number directly (readonly)

// Cell-typed property
{ count: Cell<number> } // Handler receives Cell<number> for mutation
```

With Cell-typed properties, the handler function receives actual Cell instances
with methods:

- `cell.get()`: Get the current value
- `cell.set(newValue)`: Set a new value
- `cell.update(fn)`: Update using a function

This allows for more control over state updates, including:

- Batching multiple updates
- Conditional updates based on current value
- Handling complex state transitions

## Framework Goals

The primary goal of this framework is to generate "low taint code" that enables
effective data flow analysis. In this system:

- Recipes are transparent to data flow analysis
- Functions passed to `handler` or `lift` aren't transparent (they're "tainted")
- TypeScript types provide clean abstractions that are automatically converted to runtime validation
- The `Cell<>` pattern maintains reactivity while allowing direct manipulation

By following these principles, applications built with this framework can
achieve predictable data flow, easier testing, and better security through data
flow isolation.

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
export default recipe<Input, Output>(
  "Recipe Name",
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
    const refreshData = handler<never, { processedData: Cell<ProcessedData[]> }>(
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
