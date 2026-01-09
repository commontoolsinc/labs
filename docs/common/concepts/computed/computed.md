The `computed()` function is used for derived data:

```tsx
import { computed, Default, NAME, pattern, UI } from "commontools";

interface Item {
  title: string;
  done: Default<boolean, false>;
  category: Default<string, "Other">;
}

interface Input {
  items: Default<Item[], []>;
}

export default pattern<Input, Input>(({ items }) => {
  // Any values mentioned in a computed() are automatically closed-over.
  const grouped = computed(() => {
    const groups: Record<string, Item[]> = {};
    for (const item of items) {
      const cat = item.category || "Other";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(item);
    }
    return groups;
  });

  const categories = computed(() => Object.keys(grouped).sort());

  return {
    [NAME]: "By Category",
    [UI]: (
      <div>
        {categories.map((cat) => (
          <div>
            <h3>{cat}</h3>
            {(grouped[cat] ?? []).map((item) => (
              <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
            ))}
          </div>
        ))}
      </div>
    ),
    items,
  };
});
```
