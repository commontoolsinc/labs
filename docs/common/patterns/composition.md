Multiple patterns may share data and compose recursively:

```tsx
import { pattern, computed, NAME, UI } from "commontools";

interface Props {
  items: Array<{ name: string, category: string, quantity: number }>
}

const ShoppingList = pattern<Props, Props>(({ items }) => {
  return {
    [NAME]: "Shopping List",
    [UI]: (
      <div>
        Regular List Example
      </div>
    ),
    items,
  };
})

const CategoryView = pattern<Props, Props>(({ items }) => {
  return {
    [NAME]: "Category View",
    [UI]: (
      <div>
        Category Example
      </div>
    ),
    items
  };
})

export default pattern<Props, Props>(({ items }) => {
  const listView = ShoppingList({ items });
  const catView = CategoryView({ items });

  return {
    [NAME]: "Both Views",
    [UI]: (
      <div style={{ display: "flex", gap: "2rem" }}>
        <div>{listView}</div>
        <div>{catView}</div>
      </div>
    ),
    items,
  };
});
```

Both patterns receive the same `items` cell - changes sync automatically.

**When to use which:**
- **Pattern Composition**: Multiple views in one UI, reusable components
- **Linked Charms**: Independent deployments that communicate
