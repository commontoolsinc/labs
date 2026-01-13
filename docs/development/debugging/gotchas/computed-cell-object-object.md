# [object Object] in computed() String

**Symptom:** Pattern NAME or computed string shows `[object Object]` instead of actual value.

**Cause:** Using a Cell property directly in a template string inside `computed()`. The Cell object gets coerced to string instead of its value being extracted.

```tsx
// Given Cellified input:
interface Input {
  place: Cellify<Place>;  // place.name is Writable<string>
}

// WRONG - place.name is a Cell, not a string
[NAME]: computed(() => `Location: ${place.name}`),  // Shows "Location: [object Object]"

// CORRECT - Use lift() which auto-unwraps Cells
const formatName = lift((name: string) => `Location: ${name}`);
[NAME]: formatName(place.name),  // Shows "Location: Blue Bottle Coffee"

// Also correct - call .get() explicitly in computed
[NAME]: computed(() => `Location: ${place.name.get()}`),
```

**Why lift() is preferred:**
- `lift()` automatically unwraps Cell values - you write pure functions
- `computed()` requires manual `.get()` calls on Cell properties
- `lift()` makes the reactive dependency explicit in the function signature

## See Also

- @common/concepts/lift.md - How lift() unwraps Cells
- @common/concepts/computed/computed.md - When to use computed()
- @common/concepts/types-and-schemas/writable.md - Writable and Cellify types
