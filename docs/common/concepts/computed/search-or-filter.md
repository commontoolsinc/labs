```tsx
import { computed, Writable, UI, pattern } from 'commontools';

interface Item { title: string; }
interface Input { items: Item[]; }

export default pattern<Input>(({ items }) => {
  const searchQuery = Writable.of("");

  // Reactive filtered list
  const filteredItems = computed(() => {
    const query = searchQuery.get().toLowerCase();
    return items.filter(item =>
      item.title.toLowerCase().includes(query)
    );
  });

  return {
    [UI]: (
      <div>
        <ct-input $value={searchQuery} placeholder="Search..." />
        {filteredItems.map(item => <div>{item.title}</div>)}
      </div>
    ),
  };
});
```
