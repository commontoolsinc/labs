Multiple patterns may share data and compose recursively:

```tsx
import ShoppingList from "./shopping-list.tsx";
import CategoryView from "./category-view.tsx";

export default pattern<Input, Input>(({ items }) => {
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
