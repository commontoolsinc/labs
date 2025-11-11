# Recipe Framework Documentation

## Overview

The Recipe Framework is a declarative, reactive system for building
integrations and data transformations. It uses a component-based architecture
where recipes are autonomous modules that can import, process, and export data.

## Core Concepts

### Recipe

A recipe is the fundamental building block, defined using the `recipe<InputType>((input) => {})`
function. It takes a function parameter:

- Types: define Input and Output relationships for composition with other recipes
  - Properties such as `[UI]` and `[NAME]` do not have to be explicitly included in the output type
- Parameters: a function that receives the inputs and returns outputs

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

- `wish`: Access well-known paths and system data in your space. The wish()
  function provides a way to reference common system entities and data through
  semantic paths.

  Available paths:

  - **`"/"`**: Access the root space cell and its properties

    ```typescript
    const spaceConfig = wish("/config");
    const nestedData = wish("/nested/deep/data");
    ```

  - **`"#default"`**: Shortcut for `/defaultPattern` - access your default pattern

    ```typescript
    const defaultTitle = wish("#default/title");
    const defaultArg = wish("#default/argument/greeting");
    ```

  - **`"#mentionable"`**: Access mentionable items from the backlinks index
    (maps to `/defaultPattern/backlinksIndex/mentionable`)

    ```typescript
    const mentionable = wish("#mentionable");
    const firstMention = wish("#mentionable/0/name");
    ```

  - **`"#recent"`**: Access recently used charms (maps to `/recentCharms`)

    ```typescript
    const recentCharms = wish("#recent");
    const latestCharm = wish("#recent/0/name");
    ```

  - **`"#allCharms"`**: Access all charms in the system

    ```typescript
    const allCharms = wish("#allCharms");
    const firstCharm = wish("#allCharms/0/title");
    ```

  - **`"#now"`**: Get the current timestamp (no additional path segments allowed)

    ```typescript
    const timestamp = wish("#now");
    ```

  You can also provide a default value as the second argument:

  ```typescript
  const items = wish("/myItems", []); // Returns [] if /myItems doesn't exist
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

     items.push({ title: itemName, done: false });
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

   export default recipe(({ items, name }) => {
     const grouped = groupByCategory(items);
     return {
       [UI]: <ct-button onClick={addItem({ items, name })}>Add</ct-button>,
       grouped,
     };
   });

   // ❌ INCORRECT - Inside recipe function
   export default recipe(({ items, name }) => {
     const addItem = handler((_event, { items, name }) => { /* ... */ });
     const grouped = lift((items) => { /* ... */ })(items);
     // This creates new function instances on each evaluation
   });
   ```

7. **Type Array Map Parameters When Needed**: When mapping over cell arrays, TypeScript usually infers types correctly, but you may need to add type annotations in some cases:

   ```typescript
   // ✅ USUALLY WORKS - Type inference handles most cases
   {items.map((item) => (
     <div>
       <ct-checkbox $checked={item.done}>
         <span>{item.title}</span>
       </ct-checkbox>
       <ct-input $value={item.category} />
     </div>
   ))}

   // ✅ ADD TYPE IF NEEDED - For complex scenarios or type errors
   {items.map((item: OpaqueRef<ShoppingItem>) => (
     <ct-checkbox $checked={item.done}>
       <span>{item.title}</span>
     </ct-checkbox>
   ))}
   ```

   **When to add types:**
   - If you see TypeScript errors with bidirectional binding (`$-props`)
   - When working with complex nested structures
   - When TypeScript cannot infer the correct type

   **When to skip types:**
   - Most simple cases work fine without explicit types
   - The framework usually handles type inference correctly

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

   **⚠️ Include All Closed-Over Cells in Derive Dependencies**: When your derive callback references cells, you must include them in the dependency array:

   ```typescript
   // ❌ INCORRECT - items is closed over but not in dependencies
   {derive(itemCount, (count) =>
     count === 0 ? (
       <div>No items yet</div>
     ) : (
       <div>
         {items.map((item) => <div>{item.title}</div>)}
       </div>
     )
   )}

   // ✅ CORRECT - Include all cells used in the callback
   {derive([itemCount, items] as const, ([count, itemsList]: [number, Item[]]) =>
     count === 0 ? (
       <div>No items yet</div>
     ) : (
       <div>
         {itemsList.map((item) => <div>{item.title}</div>)}
       </div>
     )
   )}

   // Alternative: Use ternary directly if you don't need reactivity
   {itemCount === 0 ? (
     <div>No items yet</div>
   ) : (
     <div>
       {items.map((item) => <div>{item.title}</div>)}
     </div>
   )}
   ```

   **⚠️ CRITICAL: Items Inside Derive Callbacks Are Read-Only**:

   When you use `derive()` for conditional rendering and then `.map()` over arrays inside the callback, the items become **read-only snapshots**. This means you cannot access mutable properties or use bidirectional binding on those items.

   ```typescript
   // ❌ BROKEN - Using derive for conditional rendering with .map()
   {derive(customFields, (fields) => fields.length > 0 ? (
     <ct-vstack>
       {fields.map((field) => (
         <ct-input
           value={field.value}  // field.value will be undefined/read-only!
           onct-input={updateField({ fieldKey: field.key })}
         />
       ))}
     </ct-vstack>
   ) : null)}

   // ✅ CORRECT - Use ifElse for conditional rendering, map over cell directly
   {ifElse(
     derive(customFields, (fields) => fields.length > 0),
     <ct-vstack>
       {customFields.map((field) => (  // Map over the cell, not the derived array
         <ct-input
           value={field.value}  // Now field.value works correctly!
           onct-input={updateField({ fieldKey: field.key })}
         />
       ))}
     </ct-vstack>,
     null
   )}
   ```

   **Why this happens**: Inside a `derive()` callback, all values are immutable snapshots for consistency. When you map over a derived array, each item is also a snapshot, losing access to mutable properties.

   **The fix**: Use `ifElse()` for conditional rendering (which only needs a reactive boolean), and map directly over the cell itself. This keeps the items mutable and accessible.

   **This applies to**:
   - Bidirectional binding (`$checked`, `$value`)
   - Accessing nested cell properties (`.value`, `.field`)
   - Any pattern where you need to interact with individual items in a mapped array

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
      str`Hello ${user.name}, you have ${notification.count} notifications`;
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

22. **Create Patterns On-Demand for Conditional Composition**: When composing patterns that share parent cell references and are conditionally instantiated, create them on-demand in handlers rather than during recipe initialization:

    ```typescript
    // ❌ WRONG - Creating shared-cell patterns during recipe init
    export default recipe("Launcher", ({ items }) => {
      const currentView = cell("none");

      // These patterns share the 'items' cell but are created upfront
      const listView = ShoppingList({ items });
      const gridView = GridView({ items });

      // Later conditionally shown based on user selection...
    });
    ```

    ```typescript
    // ✅ CORRECT - Create patterns on-demand in handlers
    const selectList = handler<
      unknown,
      { items: any; currentView: Cell<any> }
    >((_event, { items, currentView }) => {
      // Create pattern when user selects it
      const view = ShoppingList({ items });
      currentView.set(view);
    });

    const selectGrid = handler<
      unknown,
      { items: any; currentView: Cell<any> }
    >((_event, { items, currentView }) => {
      const view = GridView({ items });
      currentView.set(view);
    });

    export default recipe("Launcher", ({ items }) => {
      const currentView = cell(null);

      return {
        [UI]: (
          <div>
            <ct-button onClick={selectList({ items, currentView })}>
              List View
            </ct-button>
            <ct-button onClick={selectGrid({ items, currentView })}>
              Grid View
            </ct-button>
            <div>{currentView}</div>
          </div>
        ),
      };
    });
    ```

    **Why this matters**: Creating patterns that share parent cells during recipe initialization can cause "Shadow ref alias with parent cell not found in current frame" errors when those patterns are conditionally instantiated. The framework's cell tracking system works best when patterns are created on-demand in response to user events.

    **When this applies**:
    - Child patterns share cell references with parent
    - Patterns are created conditionally based on user selection
    - You see "Shadow ref alias" errors

    **When upfront creation is fine**:
    - All patterns are always rendered (even if hidden with CSS/ifElse)
    - Patterns don't share parent cell references
    - No conditional instantiation

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

#### 1. Creating Items Within lift Functions

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

## Examples: Most of the time you don't need [ID]

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

  items.push(currentItems, { title: itemName, done: false, category: "Uncategorized" });
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
interface ReferencedNote {
  title: string;
  content: string;
  // References to other notes are just object references:
  backlinks: ReferencedNote[];
}

const createNote = lift((title: string, content: string) => {
  return {
    title,
    content,
    backlinks: [],
  };
});

// Notes can now reference each other by ID
const addBacklink = handler<
  unknown,
  { note: Cell<ReferencedNote>; target: ReferencedNote }
>((_event, { note, target }) => {
  // .key to select a subset of the cell, .push to just change that
  note.key("backlinks").push(target);
});
```

## Rule of Thumb

**Start without `[ID]`. Only add it if:**

1. You're generating new items within a `lift` function that have to be
   references elsewhere.

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
- `cell.key(property)`: Navigate into the cell, selecting a property
- `cell.update({ [key]: value })`: Update only these keys

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

## Pattern Discovery with wish()

Patterns can discover and interact with other charms in the space using `wish()`.

### Auto-Discovering All Charms

```tsx
import { wish, derive } from "commontools";

// Get all charms in the space
const allCharms = derive<any[], any[]>(
  wish<any[]>("#allCharms", []),
  (c) => c,
);

// Filter for specific pattern types
const personCharms = derive(allCharms, (charms) =>
  charms.filter((charm: any) =>
    charm && typeof charm === "object" && "profile" in charm
  )
);

// Use in your UI
const personCount = derive(personCharms, (list) => list.length);
```

### Common Wish Patterns

| Wish | Purpose | Example Use Case |
|------|---------|------------------|
| `wish("#allCharms", [])` | All charms in space | Meta-analysis, aggregation |
| `wish("#mentionable", [])` | Charms available for `[[` refs | Autocomplete lists |
| `wish("#recentCharms", [])` | Recently viewed | Navigation helpers |

### When to Use wish vs Manual Linking

**Use wish when:**
- You want to find all charms of a certain type
- The list of charms changes dynamically
- You're building meta-patterns (analyzers, dashboards)

**Use manual linking when:**
- You need a specific charm reference that doesn't change
- You're connecting exactly two patterns
- The relationship is one-to-one

Example: A meta-analyzer that finds all Person charms should use `wish("#allCharms")` and filter. A single Person linked to their Company record should use explicit linking.

## Exporting Tools with patternTool

Patterns can export functions that chatbots and other patterns can call programmatically using `patternTool`.

### When to Use patternTool

**Use `patternTool` when:**
- You need to parametrize the operation (e.g., supply a search term, filter criteria)
- The operation requires input from the caller beyond what's in the pattern's state

**Don't use `patternTool` when:**
- The chatbot just needs to read data - simply return the data alongside your UI
- Example: `return { [UI]: <MyUI />, items }` - chatbot can read `items` directly

### Basic Pattern Tool

```tsx
import { patternTool, derive } from "commontools";

return {
  [UI]: <MyUI />,
  content,
  // Export a tool for searching content
  searchContent: patternTool(
    ({ query, content }: { query: string; content: string }) => {
      return derive({ query, content }, ({ query, content }) => {
        if (!query) return [];
        return content.split("\n").filter((line) =>
          line.toLowerCase().includes(query.toLowerCase())
        );
      });
    },
    { content } // Bind to pattern fields
  ),
};
```

### How Parameter Splitting Works

The second argument to `patternTool` determines which parameters are pre-filled vs. callable:

```tsx
// Function signature has: { items: Item[], query: string }
// Second argument supplies: { items }
// Result: query becomes the tool parameter
searchItems: patternTool(
  ({ items, query }: { items: Item[], query: string }) => {
    return derive({ items, query }, ({ items, query }) =>
      items.filter(item => item.text.includes(query))
    );
  },
  { items }  // Pre-fill items, query is left as a parameter
)
```

**Key insight:** Only supply **some** of the function's inputs in the second argument. The remainder become tool parameters that the caller (chatbot/pattern) must provide.

### Pattern Tool Best Practices

1. **Return derived values**: patternTool functions should return `derive()` results
2. **Bind to pattern fields**: Second argument connects to your pattern's data
3. **Clear function signatures**: Type your inputs for better tool calling
4. **Useful operations**: Export things chatbots would want to do (search, summarize, extract)
5. **Parameter splitting**: Use the second argument to pre-fill pattern data, leaving caller-specific params open

### Example: Person Pattern Tools

```tsx
return {
  [UI]: <PersonUI />,
  displayName,
  emails,
  notes,
  // Tools for omnibot/chatbot
  getContactInfo: patternTool(
    ({ displayName, emails }: { displayName: string; emails: EmailEntry[] }) => {
      return derive({ displayName, emails }, ({ displayName, emails }) => {
        const parts = [`Name: ${displayName || "Not provided"}`];
        if (emails && emails.length > 0) {
          parts.push(`Email: ${emails[0].value}`);
        }
        return parts.join("\n");
      });
    },
    { displayName, emails }
  ),
  searchNotes: patternTool(
    ({ query, notes }: { query: string; notes: string }) => {
      return derive({ query, notes }, ({ query, notes }) => {
        if (!query || !notes) return [];
        return notes.split("\n").filter((line) =>
          line.toLowerCase().includes(query.toLowerCase())
        );
      });
    },
    { notes }
  ),
};
```

### How Chatbots Use Pattern Tools

When a charm with patternTool exports is attached to a chatbot:
1. The tools appear in the chatbot's available tools list
2. The LLM can call them like: `PersonCharm_searchNotes({ query: "MIT" })`
3. Results are returned to the LLM for further processing

This enables rich AI interactions where the chatbot can programmatically query and extract information from attached charms.

