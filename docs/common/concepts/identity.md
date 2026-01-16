# Object Identity and Equality

## The Mental Model: Object Graph, Not Database

In traditional web development, you often model data like a database: objects have `id` fields, and you look things up by ID. This works because you're constantly serializing and deserializing data—fetching from APIs, storing in localStorage, passing through JSON.

**Common Tools works differently.** The reactive fabric is an in-memory object graph with direct references (pointers), not a database with keyed records. When you have a reference to an object, you *have* that object—you don't need an ID to find it later.

```tsx
// Object graph (no id!)
interface Todo {
  text: string;
  done: boolean;
}

// To delete, use the reference you already have
const deleteTodo = (todo: Todo) => {
  todos.set(todos.get().filter(t => !equals(todo, t)));
};
```

This shift has several benefits:

- **No ID generation** - No UUIDs, no incrementing counters, no collision worries
- **No stale references** - You work with live objects, not cached IDs that might be outdated
- **Simpler types** - Your data models are cleaner without synthetic keys
- **Natural composition** - Objects can reference other objects directly

## The `equals()` Function

Use `equals()` to compare cells or values. For cells, this checks reference equality (same object in the graph). For plain values, it checks structural equality.

```typescript
import { equals, Writable } from 'commontools';

const data = Writable.of({ name: "Ben" });

// Reference equality for cells
equals(data, data);                    // => true
equals(Writable.of({ name: "Ben" }),
       Writable.of({ name: "Ben" }));  // => false (different cells)

// Reference equality for values from a cell
equals(data, data.get());              // => true

// Does not compare cell values!
equals(Writable.of({ name: "Gideon" }), { name: "Gideon" });  // => false

// Works when navigating via .key()
const deepData = Writable.of({ address: { street: "123 Main" } });
equals(deepData.key("address"), deepData.get().address); // => true

// But only for objects
equals(deepData.key("address", "street"), deepData.get().address.street); // => type error
```

### Using `equals()` in Array Operations

The most common use case is finding items in arrays:

```typescript
import { equals, handler, Writable } from 'commontools';

interface Item {
  name: string;
  quantity: number;
}

// Check if item exists
const hasItem = lift<{ item: Item, items: Item[] }>(
  ({ item, items }) => items.some(el => equals(item, el))
);
```

**Tip:** For removing items, use `array.remove(item)`, it uses the same `equals()` under the hood.

### In `.map()` Callbacks

When iterating with `.map()`, you have a reference to each item. Use that reference directly:

```tsx
{items.map((item) => (
  <ct-card>
    <span>{item.name}</span>
    <ct-button onClick={() => {
      // Use the reference you already have
      const allItems = items.get(); // If items is a Writable<Item[]>, otherwise use directly
      const idx = allItems.findIndex(i => equals(item, i));
      if (idx >= 0) {
        selectedIndex.set(idx);
      }
    }}>
      Select
    </ct-button>
  </ct-card>
))}
```

Instead of fighting the reactive system with IDs, work with it using `equals()` and direct references.

See [Custom `id` Property Pitfall](../../development/debugging/gotchas/custom-id-property-pitfall.md) for more details and workarounds.
