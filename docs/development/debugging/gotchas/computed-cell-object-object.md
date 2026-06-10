# [object Object] in computed() String

**Symptom:** Pattern NAME or computed string shows `[object Object]` instead of actual value.

**Cause:** Interpolating a whole reactive object into a template string where a single field was meant. The object gets coerced to string instead of the field value being extracted.

```tsx
interface Place {
  name: string;
  city: string;
}

interface Input {
  places: Place[];
  selectedIndex: number;
}

const selectedPlace = computed(() =>
  places[selectedIndex] ?? null
);

// WRONG - selectedPlace is an object, not a string
[NAME]: computed(() => `Location: ${selectedPlace}`),  // Shows "Location: [object Object]"

// CORRECT - interpolate the field, not the object
[NAME]: computed(() => `Location: ${selectedPlace?.name ?? "Unknown"}`),
```

The same coercion happens when rendering the object in JSX text position or
passing it to a string-typed component attribute — anywhere a string is
expected, an object value stringifies to `[object Object]`.

**Diagnosis:** Find the template string (or string-position render) and check
what each interpolated expression actually is. If it's an object — a whole
input, a computed that returns an object, an array element — you need a field
access, not the value itself.

**Fix shape:**
- Derive the display string in a `computed()` that reads the specific fields
  (`?.` guards for nullable values)
- If the object can legitimately be absent, provide a string fallback
  (`?? "Unknown"`) so the fallback path is also a string

## See Also

- @common/concepts/computed/computed.md - When to use computed()
- @common/concepts/types-and-schemas/writable.md - Writable type system
