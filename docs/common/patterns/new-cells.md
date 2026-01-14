### Creating Writable Cells with Cell.of()

Use `Cell.of()` to create NEW writable cells in your pattern body or return values.

This is rare. Generally prefer to add additional input parameters instead of
creating internal cells.

**When to use Cell.of():**

- Creating new cells inside a pattern that can't be input parameters.
- Creating local state that handlers will mutate

**When NOT to use Cell.of():**

- Input parameters (they're already writable if declared with `Writable<>`)
- Values you won't mutate

**IMPORTANT: Initialize with static values only**

You cannot initialize a cell with a reactive value (like an input prop) because `Cell.of()` runs at pattern initialization time, outside a reactive context:

```tsx
// WRONG - deck.name is reactive, causes "reactive reference outside context" error
export default pattern<Input>(({ deck }) => {
  const editedName = Cell.of(deck.name);  // ERROR!
  ...
});

// CORRECT - initialize with static value, set from event handler
export default pattern<Input>(({ deck }) => {
  const editedName = Cell.of("");  // Static initial value

  const startEditing = action(() => {
    editedName.set(deck.name);  // OK - event handlers run at click time
    editingMode.set(true);
  });
  ...
});
```

```typescript
// Creating new cells in pattern body
export default pattern(({ inputItems }) => {
  // Create new cells for local state
  const filteredItems = Cell.of<Item[]>([]);
  const searchQuery = Cell.of("");
  const selectedItem = Cell.of<Item | null>(null);

  return {
    [UI]: <div>...</div>,
    // Return cells so they're reactive and mutable
    filteredItems,
    searchQuery,
    selectedItem,
  };
});

// Common patterns
const count = Cell.of(0);                           // Number
const name = Cell.of("Alice");                      // String
const items = Cell.of<Item[]>([]);                  // Empty array with type
const user = Cell.of<User>();                       // Optional value
const config = Cell.of<Config>({ theme: "dark" });  // Object with initial value
```
