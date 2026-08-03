# Pattern Composition

Patterns can compose other patterns by instantiating them and including the result in the vdom.

## Syntax: Function Calls or JSX

Use either function call or JSX syntax:

```ts
// Shown inside a pattern body.
{items.map((item) => ItemCard({ item }))}
```

```tsx
// Shown inside a pattern body.
{items.map((item) => <ItemCard item={item} />)}
```

## How It Works

When you place a pattern result in the vdom, the runtime:
1. Extracts the `[UI]: VNode` property from the pattern result
2. Renders that VNode in place

This is why sub-patterns **must include `[UI]` in their Output type** - see [Pattern Types](../concepts/pattern.md#output-types-for-sub-patterns).

## Example

```tsx
import { pattern, NAME, UI, VNode, Writable } from "commonfabric";

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
- **Linked Pieces**: Independent deployments that communicate

## Keep External Data Contracts Narrow

A pattern schema is a runtime projection and binding contract, not only a
TypeScript annotation. When a pattern receives externally owned data through a
link, wish result, registry entry, or other cell, declare only the fields it
reads and only the live-cell or stream bindings it uses. Extra optional fields
can make the runtime traverse more linked data. An extra required field whose
value is absent or incompatible and whose schema does not accept `undefined`
invalidates the containing object; if that object is an array element, one
invalid element voids the entire array read. See
`packages/runner/test/traverse-required-links.test.ts`.

The consumer normally owns this structural type:

```typescript
// Shown at module scope.
type NotePreview = {
  title?: string;
  summary?: string;
};

interface PreviewInput {
  note: NotePreview;
}
```

Do not import another pattern's entire `FooInput` or `FooOutput`, or derive a
`Pick`/`Omit` from it, merely because it contains the needed fields. Spelling
the minimal local shape is intentional duplication: the producer can evolve
unrelated state, UI, and mutation streams without changing this consumer's
contract.

An output type must be exported so TypeScript can name the default pattern
factory's return contract. That visibility requirement is not an invitation for
external consumers to reuse the whole type as their input schema.

`Writable<T>` and `Cell<T>` are the same cell type and runtime interface;
choosing between those names does not grant or restrict authority. The
meaningful consumer-side choice is branded versus plain: a branded result
projection preserves a live cell binding, while a plain field projects its
reactive value. Request the brand only when the relationship needs cell
identity or the cell API. See
[Reactivity and Write Access](../concepts/reactivity.md#results-mirror-the-rule-writable-in-a-result-type-grants-write-access)
and [Writable](../concepts/types-and-schemas/writable.md).

When a producer intentionally supports a stable role used by several
independent consumers, export a shallow model for that role, such as a
`MentionablePiece` or `SummarizablePiece`, rather than asking consumers to
reuse its full input or output schema. Keep that model limited to the role's
semantic core. A consumer with extra needs should usually extend its own local
projection instead of widening the shared model for everyone. For a concrete
example, see `MentionablePiece` in
`packages/patterns/system/backlinks-index.tsx`.

Reusing a shared type is still appropriate when it is itself the intended
protocol: for example, a stream event, an enum, or a cohesive domain model
co-owned by one pattern family. A wrapper that deliberately forwards a complete
contract may also use that complete contract. The test is whether every named
field and capability belongs to the relationship, not whether centralizing the
type removes duplicate TypeScript.

## Merging Complex Objects from Pattern Inputs

Pattern inputs are cellified — they become cell proxies, not plain objects. You **cannot** spread a pattern input directly into an object literal, because the spread operates on the proxy's own properties (which are empty) rather than the underlying value.

```tsx
// Shown inside a pattern body.
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
// Shown inside a pattern body.
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

## See Also

- [Pattern Primitives](./primitives.md) — the contract for embedding reusable
  logic and model state
- [View Switching](./view-switching.md) — dynamically switching between sub-patterns
- [Navigation](./navigation.md) — `navigateTo()` for drill-down to detail views
- [Self-Reference](../concepts/self-reference.md) — tree/parent-child structures where a pattern composes itself
