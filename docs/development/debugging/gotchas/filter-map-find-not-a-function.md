# filter/map/find is Not a Function

**Error:** `X.filter is not a function` (or `.map`, `.find`, `.reduce`, etc.)

**Tempting but wrong diagnosis:** "I need to unwrap with `.get()`"

**Actual cause:** The value isn't an array (yet). This usually means:
1. The array hasn't been initialized (missing `Default<T[], []>`)
2. You're accessing a nested property that doesn't exist
3. A computed is returning the wrong type

```typescript
// CORRECT - Ensure array has a default value
interface Input {
  items: Default<Item[], []>;  // Defaults to empty array
}

// CORRECT - Inside computed(), just use the value directly
const activeItems = computed(() => items.filter(item => !item.done));

// CORRECT - Writable<T[]> requires .get() to access the array
const handleClear = handler<never, { items: Writable<Item[]> }>(
  (_, { items }) => {
    const done = items.get().filter(item => item.done);  // .get() because items is Writable<>
    // ...
  }
);
```

**Diagnostic questions:**
1. Is the source a `Writable<>`? -> Use `.get()` to read the value
2. Is it a `computed()` or `lift()` result? -> Access directly, no `.get()`
3. Is the value possibly undefined? -> Add `Default<T[], []>` to the interface

## See Also

- @common/concepts/types-and-schemas.md - Type system, `Default<>`, and `Writable<>` explained
- @common/concepts/reactivity.md - Reactivity system
