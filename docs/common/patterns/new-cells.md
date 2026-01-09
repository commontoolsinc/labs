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

```typescript
// ✅ Creating new cells in pattern body
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

// ✅ Common patterns
const count = Cell.of(0);                           // Number
const name = Cell.of("Alice");                      // String
const items = Cell.of<Item[]>([]);                  // Empty array with type
const user = Cell.of<User>();                       // Optional value
const config = Cell.of<Config>({ theme: "dark" });  // Object with initial value
```
