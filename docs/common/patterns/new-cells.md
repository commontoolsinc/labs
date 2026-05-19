### Creating Writable Cells with new Writable()

Use `new Writable()` to create NEW writable cells in your pattern body or return values.

This is rare. Generally prefer to add additional input parameters instead of
creating internal cells.

**When to use new Writable():**

- Creating new cells inside a pattern that can't be input parameters.
- Creating local state that handlers will mutate

**When NOT to use new Writable():**

- Input parameters (they're already writable if declared with `Writable<>`)
- Values you won't mutate

**IMPORTANT: Initialize with static values only**

You cannot initialize a cell with a reactive value (like an input prop) because `new Writable()` runs at pattern initialization time, outside a reactive context:

```tsx
// WRONG - deck.name is reactive, causes "reactive reference outside context" error
export default pattern<Input>(({ deck }) => {
  const editedName = new Writable(deck.name);  // ERROR!
  ...
});

// CORRECT - initialize with static value, set from event handler
export default pattern<Input>(({ deck }) => {
  const editedName = new Writable("");  // Static initial value

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
  const filteredItems = new Writable<Item[]>([]);
  const searchQuery = new Writable("");
  const selectedItem = new Writable<Item | null>(null);

  return {
    [UI]: <div>...</div>,
    // Return cells so they're reactive and mutable
    filteredItems,
    searchQuery,
    selectedItem,
  };
});

// Common patterns
const count = new Writable(0);                           // Number
const name = new Writable("Alice");                      // String
const items = new Writable<Item[]>([]);                  // Empty array with type
const user = new Writable<User>();                       // Optional value
const config = new Writable<Config>({ theme: "dark" });  // Object with initial value
```
