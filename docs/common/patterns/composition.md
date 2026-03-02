# Pattern Composition

Patterns can compose other patterns by instantiating them and including the result in the vdom.

## Syntax: Function Calls or JSX

Use either function call or JSX syntax:

```ts
{items.map((item) => ItemCard({ item }))}
```

```tsx
{items.map((item) => <ItemCard item={item} />)}
```

## How It Works

When you place a pattern result in the vdom, the runtime:
1. Extracts the `[UI]: VNode` property from the pattern result
2. Renders that VNode in place

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

## Merging Complex Objects from Pattern Inputs

Pattern inputs are cellified — they become cell proxies, not plain objects. You **cannot** spread a pattern input directly into an object literal, because the spread operates on the proxy's own properties (which are empty) rather than the underlying value.

```tsx
// BROKEN: ...extraTools spreads a cell proxy, yields nothing
const omnibot = Chatbot({
  tools: {
    ...baseTools,
    ...extraTools,  // extraTools is a pattern input — this is a no-op
  },
});
```

**Fix:** wrap the merge in `computed()`. Inside a computed body, CTS auto-unwraps cell proxies to their actual values, so the spread works on the plain object:

```tsx
// WORKS: computed() unwraps extraTools before spreading
const baseTools = {
  searchWeb: { pattern: searchWeb },
  calculator: { pattern: calculator },
};

const allTools = computed(() => ({
  ...baseTools,
  ...extraTools,  // extraTools is unwrapped here
}));

const omnibot = Chatbot({
  tools: allTools,  // passed as a single cell reference
});
```

This pattern is useful when a sub-pattern needs to accept additional configuration (e.g. extra chatbot tools, extra fields) from its caller while also defining its own base set internally.
