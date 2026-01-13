### equals()

Use `equals()` to compare cells or values. For cells, this is reference equality, for values it is primitive equality.

```typescript
import { equals, handler, Writable, Cell } from 'commontools';

const myCell = Cell.of({ name: "Ben" });

// Works with cells or plain values
console.log(equals(Cell.of({ name: "Ben" }), Cell.of({ name: "Berni" })));
// => false
console.log(equals(myCell, myCell));
// => true
console.log(equals({ name: "Ben" }, { name: "Berni" }));
// => false
console.log(equals({ name: "Gideon" }, { name: "Gideon" }));
// => true
console.log(equals(Cell.of({ name: "Gideon" }), { name: "Gideon" }));
// => true

interface Item {}

// Useful in array operations
const removeItem = handler(({ item }: { item: Writable<Item> }, { items }: { items: Writable<Item[]> }) => {
  const currentItems = items.get();
  const index = currentItems.findIndex(el => Cell.equals(item, el));
  if (index >= 0) {
    items.set(currentItems.toSpliced(index, 1));
  }
});
```

### Why Not Use Custom `id` Properties?

A common pattern in traditional JavaScript is adding `id` properties to objects for tracking:

```typescript
// AVOID - Custom id properties cause problems
interface Deck {
  id: string;  // Don't do this
  name: string;
}
```

This fails because when you access `deck.id` inside a `.map()` callback, you get a Cell, not a plain string. Use `equals()` instead for object identity comparison.

See [Custom `id` Property Pitfall](../../development/debugging/gotchas/custom-id-property-pitfall.md) for the full explanation and workarounds.
