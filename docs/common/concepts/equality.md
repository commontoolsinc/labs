### equals()

Use `equals()` to compare cells or values. For cells, this is reference equality, for values it is primitive equality.

```typescript
// Works with cells or plain values
const isSame = Cell.equals(cell1, cell2);
const isSame = Cell.equals(value1, value2);
const isSame = Cell.equals(cell, value);

// Useful in array operations
const removeItem = (items: Writable<Item[]>, item: Writable<Item>) => {
  const currentItems = items.get();
  const index = currentItems.findIndex(el => Cell.equals(item, el));
  if (index >= 0) {
    items.set(currentItems.toSpliced(index, 1));
  }
};
```
