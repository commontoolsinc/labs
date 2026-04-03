```tsx
import { computed, UI, pattern } from 'commontools';

interface Item { title: string; category: string; }
interface Input { items: Item[]; }

export default pattern<Input>(({ items }) => {
  const groupedItems = computed(() => {
    const groups: Record<string, Item[]> = {};
    for (const item of items) {
      const cat = item.category || "Uncategorized";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(item);
    }
    return groups;
  });

  const categories = computed(() => Object.keys(groupedItems).sort());

  return {
    [UI]: (
      <>
        {categories.map(category => (
          <div>
            <h3>{category}</h3>
            {(groupedItems[category] ?? []).map(item => (
              <div>{item.title}</div>
            ))}
          </div>
        ))}
      </>
    ),
  };
});
```
