The `computed()` function is used for derived data:

```tsx
import { computed, Default, NAME, pattern, UI } from "commontools";

interface Item {
  title: string;
  done: Default<boolean, false>;
  category: Default<string, "Other">;
}

interface Input {
  items: Default<Item[], []>;
}

export default pattern<Input, Input>(({ items }) => {
  // Any values mentioned in a computed() are automatically closed-over.
  const grouped = computed(() => {
    const groups: Record<string, Item[]> = {};
    for (const item of items) {
      const cat = item.category || "Other";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(item);
    }
    return groups;
  });

  const categories = computed(() => Object.keys(grouped).sort());

  return {
    [NAME]: "By Category",
    [UI]: (
      <div>
        {categories.map((cat) => (
          <div>
            <h3>{cat}</h3>
            {(grouped[cat] ?? []).map((item) => (
              <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
            ))}
          </div>
        ))}
      </div>
    ),
    items,
  };
});
```

---


### When to Use computed()

Use `computed()` **outside of JSX** for reactive transformations.

**Use `computed()` for dynamic `[NAME]` values:** When deriving `[NAME]` from input props or other reactive values, wrap it in `computed()`:

```tsx
// WRONG - input props are reactive, can't access at init time
export default pattern<Input>(({ deck }) => ({
  [NAME]: `Study: ${deck.name}`,  // Error: reactive reference outside context
  ...
}));

// CORRECT - computed() creates a reactive context
export default pattern<Input>(({ deck }) => ({
  [NAME]: computed(() => `Study: ${deck.name}`),
  ...
}));
```

Static strings like `[NAME]: "My Pattern"` don't need `computed()`.

**Never wrap JSX in `computed()`** - the transformer automatically handles reactivity in JSX expressions. The compiler analyzes your JSX and wraps reactive expressions in `derive()` calls behind the scenes, so explicit `computed()` is unnecessary and can cause issues.

Similarly, ternaries in JSX are automatically converted to `ifElse()` - see `docs/common/patterns/conditional.md`.

```tsx
// ❌ WRONG - Don't wrap JSX in computed()
{computed(() => (
  <div style={{ background: headerColor }}>...</div>
))}

// ✅ RIGHT - Just use the value directly in JSX
<div style={{ background: headerColor }}>...</div>
```

Example of correct usage:

```tsx
import { computed, UI, Writable } from 'commontools';

interface Item { title: string; }
const searchQuery = Writable.of("");
declare const items: Item[];
declare const groupedItems: Record<string, Item[]>;

// ✅ Use computed() outside JSX
const filteredItems = computed(() => {
  const query = searchQuery.get().toLowerCase();
  return items.filter(item => item.title.toLowerCase().includes(query));
});

const itemCount = computed(() => items.length);

const categories = computed(() => {
  return Object.keys(groupedItems).sort();
});

// Then use the computed values in JSX
const result = {
  [UI]: (
    <div>
      <div>Total: {itemCount}</div>
      {filteredItems.map(item => <div>{item.title}</div>)}
      {categories.map(cat => <h3>{cat}</h3>)}
    </div>
  ),
};
```

### Side Effects in computed()

If your `computed()` has side effects (like setting another cell), they should be idempotent. Non-idempotent side effects cause the scheduler to re-run repeatedly until it hits the 101-iteration limit.

```typescript
import { computed, Writable } from 'commontools';

interface Item {}
declare const items: Item[];
const logArray = Writable.of<{ timestamp: number }[]>([]);
const cacheMap = Writable.of<Record<string, number>>({});

// ❌ Non-idempotent - appends on every run
const badComputed = computed(() => {
  const current = logArray.get();
  logArray.set([...current, { timestamp: Date.now() }]);  // Grows forever
  return items.length;
});

// ✅ Idempotent - check-before-write with deterministic key
const goodComputed = computed(() => {
  const current = cacheMap.get();
  const key = `items-${items.length}`;
  if (!(key in current)) {
    cacheMap.set({ ...current, [key]: Date.now() });
  }
  return items.length;
});
```

The scheduler re-runs computations when their dependencies change. If a computation modifies a cell it depends on, it triggers itself. With idempotent operations, the second run produces no change, so the system settles.

Prefer using handlers for mutations instead of side effects in `computed()`.
