
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
