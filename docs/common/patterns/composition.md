# Pattern Composition

Patterns can compose other patterns by instantiating them and including the result in the vdom.

## Syntax: Function Calls, Not JSX

**Always use function call syntax** to render sub-patterns:

```
// ✅ Correct - function call returns OpaqueCell with [UI]
{items.map((item) => ItemCard({ item }))}

// ❌ Wrong - JSX fails type checking for patterns with Output types
{items.map((item) => <ItemCard item={item} />)}
```

**Why?** Patterns return `OpaqueCell<Output>`, not a JSX `Element`. The runtime extracts `[UI]` from the cell when rendering, but TypeScript's JSX type system doesn't understand this - it expects JSX components to return `Element` directly.

## How It Works

When you place a pattern result in the vdom, the runtime:
1. Receives the `OpaqueCell<Output>` from the pattern call
2. Extracts the `[UI]: VNode` property from the cell
3. Renders that VNode in place

This is why sub-patterns **must include `[UI]` in their Output type** - see [Pattern Types](../concepts/pattern.md#output-types-for-sub-patterns).

## Example

```tsx
import { pattern, NAME, UI, VNode, Writable } from "commontools";

interface Item { name: Writable<string> }

interface ItemInput { item: Item }
interface ItemOutput {
  [NAME]: string;
  [UI]: VNode;  // Required for composition
  item: Item;
}

const ItemCard = pattern<ItemInput, ItemOutput>(({ item }) => ({
  [NAME]: item.name,
  [UI]: <div>{item.name}</div>,
  item,
}));

interface ListInput { items: Writable<Item[]> }
interface ListOutput {
  [NAME]: string;
  [UI]: VNode;
  items: Item[];
}

// Parent pattern composes ItemCard
export default pattern<ListInput, ListOutput>(({ items }) => ({
  [NAME]: "Item List",
  [UI]: (
    <div>
      {items.map((item) => ItemCard({ item }))}
    </div>
  ),
  items,
}));
```

Both patterns receive the same `items` cell - changes sync automatically.

**When to use which:**
- **Pattern Composition**: Multiple views in one UI, reusable components
- **Linked Charms**: Independent deployments that communicate
