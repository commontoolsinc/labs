# Reactivity and Write Access

## How Reactivity Works

Everything a pattern receives as input or derives with `computed()` is
reactive: when a value changes, everything that reads it updates
automatically. JSX references subscribe automatically — `{count}` re-renders
when `count` changes, with no wrapper needed. Inside `computed()`, `lift()`,
`action()`, and `handler()` bodies, read current values with `.get()`; those
reads are tracked as dependencies (in computed/lift). Derive data with
[computed()](./computed/computed.md) and gate UI with plain ternaries
([Conditional Rendering](../patterns/conditional.md)).

## Core Principle: Writable<> is About Write Access, Not Reactivity

**The most important thing to understand:** Everything in Common Fabric is reactive by default. The `Writable<>` wrapper in type signatures doesn't enable reactivity—it indicates **write intent**.

### The Rule

- **Use `Writable<T>`** in signatures ONLY when you need write access (`.set()`, `.update()`, `.push()`, `.key()`)
- **Omit `Writable<>`** for read-only access - the framework automatically provides reactive values

```tsx
import { action, Default, Writable, UI, pattern } from 'commonfabric'

interface Item {}

// ✅ Read-only - No Writable<> needed (still reactive!)
interface ReadOnlyInput {
  count: number | Default<0>;         // Just display it (defaults to 0)
  items: Item[];                     // Just map/display
  userName: string;                  // Just show it
}

export const ReadOnly = pattern<ReadOnlyInput>(({ count, items, userName }) => {
  return {
    [UI]: (
      <div>
        <div>Count: {count}</div>              {/* Reactive! */}
        <div>User: {userName}</div>            {/* Reactive! */}
        {items.map(item => <div>{item}</div>)} {/* Reactive! */}
      </div>
    ),
  };
});

// ✅ Write access - Writable<> required
interface WritableInput {
  count: Writable<number | Default<0>>;  // Will call count.set()
  items: Writable<Item[]>;              // Will call items.push()
  title: Writable<string>;              // Will call title.set()
}

export default pattern<WritableInput>(({ count, items, title }) => {
  // action() closes over pattern state - the preferred way to mutate
  const increment = action(() => {
    count.set(count.get() + 1);
  });

  const addItem = action(() => {
    items.push({ title: "New" });
  });

  return {
    [UI]: (
      <div>
        {/* Display is still reactive */}
        <div>Count: {count}</div>

        {/* Can also mutate */}
        <cf-button onClick={increment}>Increment</cf-button>

        {/* Bidirectional binding */}
        <cf-input $value={title} />

        {/* Can also mutate */}
        <cf-button onClick={addItem}>Add Item</cf-button>
      </div>
    ),
  };
});
```
