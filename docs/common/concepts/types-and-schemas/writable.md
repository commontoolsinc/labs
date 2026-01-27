
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
| `.push(...items)` | Add to array |
| `.remove(item)` | Remove first `item` from array |
| `.removeAll(item)` | Remove all `item` from array |
| `.key(...keys)` | Navigate nested data, e.g. `.key("property")` |

Without `Writable<>`, you can still display values in JSX, pass to `computed()`, and map over arrays - all reactively. Note: Outside of JSX, filtering and transformations must be done in `computed()`.

### Passing Values to Pattern Inputs

When calling a pattern, you have two options for providing input values:

**Plain values** create independent state for each pattern instance:

```typescript
const counter1 = Counter({ count: 0 });
const counter2 = Counter({ count: 0 });
// counter1 and counter2 have separate state - incrementing one doesn't affect the other
```

**Cell references** share state across pattern instances:

```typescript
const sharedCount = Writable.of(0);
const counter1 = Counter({ count: sharedCount });
const counter2 = Counter({ count: sharedCount });
// counter1 and counter2 share state - incrementing one affects both
```

For most cases, pass plain values. Use `Writable.of()` when you intentionally want multiple patterns to share the same underlying state.

Note: The `Writable<T>` annotation in a pattern's type signature indicates write intent within that pattern, but doesn't affect how input values are coerced. Plain values always become owned state that the pattern can modify—the pattern can pass these to handlers with `Writable<>` inputs, making them effectively writable regardless of the signature.

### Storing References to Cells

When storing a "pointer" to a Cell (e.g., tracking which item is selected), **box the reference** in an object:

```typescript
// ✅ Correct - Boxed reference
interface Input {
  selected: Writable<{ item: Item }>;
}
selected.set({ item });
const { item } = selected.get();
```

Why: When you store a Cell directly, link chain resolution means `.set()` writes to the *target* instead of changing which item is referenced. Boxing breaks the chain.

See [Cell Reference Overwrite](../../../development/debugging/gotchas/cell-reference-overwrite.md) for details.
