## Core Principle: Writable<> is About Write Access, Not Reactivity

**The most important thing to understand:** Everything in CommonTools is reactive by default. The `Writable<>` wrapper in type signatures doesn't enable reactivity—it indicates **write intent**.

### The Rule

- **Use `Writable<T>`** in signatures ONLY when you need write access (`.set()`, `.update()`, `.push()`, `.key()`)
- **Omit `Writable<>`** for read-only access - the framework automatically provides reactive values

```tsx
import { Writable, UI, pattern } from 'commontools'

interface Item {}

// ✅ Read-only - No Writable<> needed (still reactive!)
interface ReadOnlyInput {
  count: number;        // Just display it
  items: Item[];        // Just map/display
  userName: string;     // Just show it
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
  count: Writable<number>;  // Will call count.set()
  items: Writable<Item[]>;  // Will call items.push()
  title: Writable<string>;  // Will call title.set()
}

export default pattern<WritableInput>(({ count, items, title }) => {
  return {
    [UI]: (
      <div>
        {/* Display is still reactive */}
        <div>Count: {count}</div>

        {/* Can also mutate */}
        <ct-button onClick={() => count.set(count.get() + 1)}>
          Increment
        </ct-button>

        <ct-input $value={title} />

        <ct-button onClick={() => items.push({ title: "New" })}>
          Add Item
        </ct-button>
      </div>
    ),
  };
});
```
