# Object Identity and Equality

## DO NOT Use `id` Properties

**This is the most important rule when coming from React or traditional web development:**

**DO NOT add `id`, `*Id`, or any identifier properties to your data types.** The CommonTools runtime tracks object identity automatically. You never need to generate or track IDs yourself.

If you find yourself writing `id: string` in an interface, stop and read this document.

## The Mental Model: Object Graph, Not Database

In traditional web development, you model data like a database: objects have `id` fields, and you look things up by ID. This works because you're constantly serializing and deserializing data—fetching from APIs, storing in localStorage, passing through JSON.

**CommonTools works differently.** The reactive fabric is an in-memory object graph with direct references (pointers), not a database with keyed records. When you have a reference to an object, you *have* that object—you don't need an ID to find it later.

```tsx
// Database thinking (avoid this)
interface Todo {
  id: string;        // Need this to find the todo later
  text: string;
  done: boolean;
}

// To delete, search by ID
const deleteTodo = (todoId: string) => {
  todos.set(todos.get().filter(t => t.id !== todoId));
};

// Object graph thinking (do this)
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
import { equals, Cell } from 'commontools';

const myCell = Cell.of({ name: "Ben" });

// Reference equality for cells
equals(myCell, myCell);                    // => true
equals(Cell.of({ name: "Ben" }),
       Cell.of({ name: "Ben" }));          // => false (different cells)

// Structural equality for plain values
equals({ name: "Gideon" }, { name: "Gideon" });  // => true
equals({ name: "Ben" }, { name: "Berni" });      // => false

// Mixed comparison (unwraps cell to compare)
equals(Cell.of({ name: "Gideon" }), { name: "Gideon" });  // => true
```

### Using `equals()` in Array Operations

The most common use case is finding or removing items from arrays:

```typescript
import { equals, handler, Writable } from 'commontools';

interface Item {
  name: string;
  quantity: number;
}

// Remove an item by reference
const removeItem = handler<{ item: Item }, { items: Writable<Item[]> }>(
  ({ item }, { items }) => {
    const currentItems = items.get();
    const index = currentItems.findIndex(el => equals(item, el));
    if (index >= 0) {
      items.set(currentItems.toSpliced(index, 1));
    }
  }
);

// Check if item exists
const hasItem = handler<{ item: Item }, { items: Writable<Item[]> }>(
  ({ item }, { items }) => {
    return items.get().some(el => equals(item, el));
  }
);
```

### In `.map()` Callbacks

When iterating with `.map()`, you have a reference to each item. Use that reference directly:

```tsx
{items.map((item) => (
  <ct-card>
    <span>{item.name}</span>
    <ct-button onClick={() => {
      // Use the reference you already have
      const allItems = items.get();
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

Or even simpler—use the index directly if that's all you need:

```tsx
{items.map((item, index) => (
  <ct-card>
    <span>{item.name}</span>
    <ct-button onClick={() => selectedIndex.set(index)}>
      Select
    </ct-button>
  </ct-card>
))}
```

## Why Custom `id` Properties Don't Work

A common instinct is to add `id` properties for tracking:

```typescript
// AVOID - Custom id properties cause problems
interface Deck {
  id: string;  // Don't do this
  name: string;
}
```

This fails because when you access `deck.id` inside a `.map()` callback, you get a Cell wrapping the value, not the plain string. Comparing or passing this Cell as if it were a string leads to silent failures.

```tsx
// This silently fails - deck.id is a Cell, not "deck-123"
{decks.map((deck) => (
  <ct-button onClick={() => {
    goToReview.send({ deckId: deck.id });  // Passes a Cell, not a string
  }}>
    Review
  </ct-button>
))}
```

Instead of fighting the reactive system with IDs, work with it using `equals()` and direct references.

See [Custom `id` Property Pitfall](../../development/debugging/gotchas/custom-id-property-pitfall.md) for more details and workarounds.
