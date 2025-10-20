# Pattern Development Feedback

This document captures feedback for maintainers about unclear aspects of the pattern development documentation and examples, based on developing the shopping list patterns.

## Issues Encountered and Suggestions

### 1. Array Mutation Patterns

**Problem**: The `list-operations.tsx` example shows using `items.set([...items.get(), newItem])` pattern, but the preferred pattern is `items.push(newItem)` and `items.set(items.get().toSpliced(index, 1))`.

**Suggestion**:
- Update examples to show preferred array mutation methods
- Document that `toSpliced()` is the preferred way to remove items from arrays
- Add a clear section in the docs showing:
  ```typescript
  // Adding items - preferred
  items.push(newItem);

  // Removing items - preferred
  const currentItems = items.get();
  const index = currentItems.findIndex((el) => itemCell.equals(el));
  if (index >= 0) {
    items.set(currentItems.toSpliced(index, 1));
  }

  // Avoid
  items.set([...items.get(), newItem]);
  items.set(items.get().filter((_, i) => i !== index));
  ```

### 2. Bidirectional Binding Power

**Problem**: The `ct-checkbox-cell.tsx` example shows using an `onChange` handler with a checkbox, which suggests handlers are always needed. The power of bidirectional binding (`$checked={item.checked}` automatically updating the cell) wasn't clear.

**Suggestion**:
- Add a prominent example showing bidirectional binding without handlers
- Document explicitly: "When using `$checked={}`, `$value={}`, or other `$prop` bindings, the cell is automatically updated when the user interacts with the component. No onChange handler is needed."
- Show a comparison:
  ```typescript
  // Simple case - bidirectional binding (preferred)
  <ct-checkbox $checked={item.checked} />

  // Complex case - when you need additional logic
  const toggle = handler((_event, { item }: { item: Cell<Item> }) => {
    item.checked.set(!item.checked.get());
    // Additional side effects here
  });
  <ct-checkbox $checked={item.checked} onChange={toggle({ item })} />
  ```

### 3. Handler Factory Calling Pattern

**Problem**: Initial code used two-parameter handler calls like `removeItem({ items }, { index })`, but the correct pattern is single-parameter with all context: `removeItem({ items, item })`.

**Suggestion**:
- Clarify in docs: "Handler factories are called with a single object containing all the context they need"
- Show the pattern clearly:
  ```typescript
  const removeItem = handler(
    (_event, { items, item }: { items: Cell<Item[]>; item: Cell<Item> }) => {
      // handler implementation
    }
  );

  // Called with single context object
  <ct-button onClick={removeItem({ items, item })}>Remove</ct-button>
  ```

### 4. Avoid Index-Based Operations

**Problem**: Not documented that passing item references is preferred over indices.

**Suggestion**:
- Add a "Best Practices" section stating:
  - "Prefer passing direct item references over indices"
  - "Use `cell.equals(other)` to compare cells for equality"
  - Show the pattern:
    ```typescript
    items.map((item: OpaqueRef<Item>) => (
      <ct-button onClick={removeItem({ items, item })}>Remove</ct-button>
    ))
    ```

### 5. No DOM Access Restriction

**Problem**: The restriction on DOM access (no `document.getElementById()`, etc.) isn't clearly documented.

**Suggestion**:
- Add a prominent warning in the docs: "⚠️ DOM access is not allowed in patterns. Use cells to capture and manage all state."
- Document the input pattern:
  ```typescript
  // Create cells for input state
  const name = cell("");
  const category = cell("Other");

  // Bind to inputs
  <ct-input $value={name} placeholder="Name" />
  <ct-select $value={category}>...</ct-select>

  // Access in handlers
  const addItem = handler((_event, { name, category }) => {
    const nameValue = name.get();
    // ...
  });
  ```

### 6. lift vs derive Usage

**Problem**: When to use `lift` to create a factory vs `derive` wasn't clear.

**Suggestion**:
- Document the distinction:
  - `lift`: Creates a reusable function that can be called multiple times with different inputs
  - `derive`: Directly computes a value from cells
- Show examples:
  ```typescript
  // lift - create a reusable factory
  const groupByCategory = lift((items: Item[]) => {
    // transformation logic
  });
  const grouped = groupByCategory(items);

  // derive - direct computation
  const categories = derive(itemsByCategory, (grouped) => {
    return Object.keys(grouped).sort();
  });
  ```

### 7. [ID] Requirement Confusion

**Problem**: The `list-operations.tsx` example heavily uses `[ID]` on items, suggesting it's always needed. The docs say it's "only needed when creating referencable data from within a lift," but this wasn't clear.

**Suggestion**:
- Clarify in examples when `[ID]` is actually needed
- Update `list-operations.tsx` to note: "Note: `[ID]` is used here because [specific reason]. For most patterns, you don't need it."
- Document clearly: "Only add `[ID]` to your interface when creating data URIs or when you need stable references within `lift` functions"

### 8. OpaqueRef Typing

**Problem**: Type errors occur when mapping over items without typing as `OpaqueRef<T>`, but this isn't documented.

**Suggestion**:
- Add to docs: "When mapping over cell arrays, type the parameter as `OpaqueRef<T>` to avoid type errors"
- Show the pattern:
  ```typescript
  {items.map((item: OpaqueRef<ShoppingItem>) => (
    // item rendering
  ))}
  ```

### 9. ct-select API

**Problem**: The `ct-select.tsx` example is minimal and doesn't show that it uses an `items` attribute (an array of `{ label, value }` objects) rather than `<option>` elements like standard HTML selects.

**Suggestion**:
- Update `ct-select.tsx` example to show the correct usage pattern
- Document clearly:
  ```typescript
  // Correct - use items attribute with array of {label, value} objects
  <ct-select
    $value={category}
    items={[
      { label: "Produce", value: "Produce" },
      { label: "Dairy", value: "Dairy" },
      { label: "Other", value: "Other" },
    ]}
  />

  // Note: value can be any type, not just strings
  <ct-select
    $value={selectedId}
    items={[
      { label: "First Item", value: 1 },
      { label: "Second Item", value: 2 },
    ]}
  />

  // Incorrect - option elements don't work
  <ct-select $value={category}>
    <option value="Produce">Produce</option>
  </ct-select>
  ```

### 10. Module-Level lift and handler Definitions

**Problem**: Examples don't emphasize that `lift` and `handler` should be defined at module scope (outside the recipe function) rather than closing over variables in the module scope.

**Suggestion**:
- Document the best practice: "Define `handler` and `lift` functions at module level for reusability and performance"
- Show the pattern:
  ```typescript
  // Correct - module level
  const addItem = handler(
    (_event, { items, name }: { items: Cell<Item[]>; name: Cell<string> }) => {
      // handler implementation
    }
  );

  const groupByCategory = lift((items: Item[]) => {
    // transformation logic
  });

  export default recipe("my-recipe", ({ items }) => {
    const grouped = groupByCategory(items);
    // ...
  });

  // Incorrect - inside recipe function
  export default recipe("my-recipe", ({ items }) => {
    const addItem = handler((_event, { items }) => { /* ... */ });
    const grouped = lift((items) => { /* ... */ })(items);
    // This creates new function instances on each evaluation
  });
  ```

### 11. Handler Parameter Types

**Problem**: It's unclear when to use `Cell<T[]>` vs `Cell<Array<Cell<T>>>` in handler signatures.

**Suggestion**:
- Document clearly: "In handler parameters, use `Cell<T[]>` where T is the plain type"
- Explain the difference:
  ```typescript
  // Correct - handler parameter types
  const handler = handler(
    (_event, { items }: { items: Cell<ShoppingItem[]> }) => {
      const itemsArray = items.get(); // ShoppingItem[]
      // work with plain array
    }
  );

  // When iterating in JSX, items are wrapped
  {items.map((item: OpaqueRef<ShoppingItem>) => (
    // item is a cell-like reference here
  ))}
  ```

### 12. Property Access on Derived Objects

**Problem**: Not documented that you can directly access properties on derived objects in JSX.

**Suggestion**:
- Show that object properties can be accessed directly:
  ```typescript
  const itemsByCategory = groupByCategory(items);
  // Returns Record<string, Item[]>

  // Direct property access works
  {itemsByCategory[categoryName].map((item) => ...)}

  // No need for helper functions or derive
  ```

### 13. Variable Scoping in Nested Iterations

**Problem**: Using `derive()` or accessing outer variables inside `.map()` callbacks doesn't work as expected.

**Suggestion**:
- Document this limitation clearly
- Show workarounds:
  ```typescript
  // Doesn't work - can't access `category` from outer map
  {categories.map((category) => (
    {derive(items, (arr) => arr.filter(i => i.category === category))}
  ))}

  // Works - use property access or pre-computed values
  const itemsByCategory = groupByCategory(items);
  {categories.map((category) => (
    {itemsByCategory[category].map(...)}
  ))}
  ```

### 14. Testing Patterns Before Deployment

**Problem**: No clear workflow documented for iterative pattern development and testing.

**Suggestion**:
- Add a "Development Workflow" section:
  1. `./dist/ct dev pattern.tsx --no-run` - Check syntax
  2. `./dist/ct dev pattern.tsx` - Test execution locally
  3. `./dist/ct charm new --space test-space pattern.tsx` - Deploy to test space
  4. Iterate using `./dist/ct charm setsrc` to update without creating new charms
- Document common error patterns and solutions

### 15. Lift Currying Behavior

**Problem**: Not clear that `lift` creates curried functions when multiple parameters are used.

**Suggestion**:
- Document the currying behavior:
  ```typescript
  // lift with multiple parameters creates curried function
  const fn = lift((a: string, b: number) => `${a}: ${b}`);

  // Call with currying
  const result = fn("count")(42); // "count: 42"

  // NOT: fn("count", 42) - this won't work
  ```
- In many cases, direct property access or single-parameter lifts are clearer

## Summary

The core concepts are solid, but the examples and documentation could better highlight:
1. Preferred patterns (push/toSpliced over manual set)
2. The power of bidirectional binding
3. Restrictions (no DOM access)
4. Type annotations needed (OpaqueRef)
5. When to use specific features ([ID], lift vs derive)
6. Handler parameter type patterns (Cell<T[]> vs Cell<Array<Cell<T>>>)
7. Direct property access capabilities on derived values
8. Variable scoping limitations in nested iterations
9. Development and testing workflow
10. Currying behavior of multi-parameter lift functions

These improvements would significantly reduce the learning curve for new pattern developers.
