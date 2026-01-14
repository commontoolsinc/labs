
## Writable<> = Write Intent

`Writable<>` in type signatures indicates **write intent**, not reactivity. Everything is reactive by default.

```typescript
import { Writable } from 'commontools';

interface Item {}

// Read-only (still reactive!)
interface ReadOnlyInput {
  count: number;
  items: Item[];
}

// Write access needed
interface WritableInput {
  count: Writable<number>;    // Will call .set()
  items: Writable<Item[]>;    // Will call .push()
}
```

### Writable Methods

With `Writable<T>` in your signature:

| Method | Purpose |
|--------|---------|
| `.get()` | Read current value |
| `.set(value)` | Replace entire value |
| `.update({ key: value })` | Partial update (objects) |
| `.push(item)` | Add to array |
| `.key("property")` | Navigate nested data |

Without `Writable<>`, you can still display values in JSX, pass to `computed()`, and map over arrays - all reactively. Note: filtering and transformations must be done in `computed()` outside JSX, then the result can be mapped inside JSX.

### Passing Values to Writable Inputs

When calling a pattern that expects `Writable<T>`, you have two options:

**Plain values** create independent state for each pattern instance:

```typescript
const counter1 = Counter({ count: 0 });
const counter2 = Counter({ count: 0 });
// counter1 and counter2 have separate state - incrementing one doesn't affect the other
```

**Cell references** share state across pattern instances:

```typescript
const sharedCount = Cell.of(0);
const counter1 = Counter({ count: sharedCount });
const counter2 = Counter({ count: sharedCount });
// counter1 and counter2 share state - incrementing one affects both
```

For most cases, pass plain values. Use `Cell.of()` when you intentionally want multiple patterns to share the same underlying state.
