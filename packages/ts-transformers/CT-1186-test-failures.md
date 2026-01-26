# CT-1186 Transformer Fix - Test Failure Analysis

## Context

We're implementing a fix for CT-1186: inside `computed`/`derive` callbacks, `OpaqueRef<T>` gets auto-unwrapped to plain `T`, so we should NOT transform `.map()` to `.mapWithPattern()` for OpaqueRef types in those contexts. Cell and Stream do NOT get auto-unwrapped, so we should still transform those.

**The fix**: In `shouldTransformMap()`, when inside a "safe wrapper" (computed, derive, action, lift, handler), only transform if `cellKind === "cell" || cellKind === "stream"`, not if `cellKind === "opaque"`.

This fix causes 5 test failures. Below are the input snippets and what the tests currently expect.

---

## Failure 1: `handler-nested-map`

### Input
```tsx
interface State {
  items: Array<{ value: number }>;  // items is OpaqueRef<Array<...>> at runtime
  multiplier: number;
}

export default recipe<State>("NestedMap", (state) => {
  return {
    [UI]: (
      <button
        onClick={() => {
          // onClick becomes handler() - a "safe wrapper"
          const scaled = state.items.map((item) => item.value * state.multiplier);
          console.log(scaled);
        }}
      >
        Compute
      </button>
    ),
  };
});
```

### Current Expected Output (relevant snippet)
```tsx
onClick={__ctHelpers.handler(/* schemas */, (__ct_handler_event, { state }) => {
  const scaled = state.items.mapWithPattern(__ctHelpers.recipe({
    // ... recipe schema for map callback
  }, ({ element: item, params: { state } }) => item.value * state.multiplier), {
    state: { multiplier: state.multiplier }
  });
  console.log(scaled);
})}
```

### Question
Inside a `handler()` callback, should `state.items.map()` (where `state.items` is `OpaqueRef<T[]>`) be transformed to `mapWithPattern`?

---

## Failure 2: `pattern-nested-jsx-map`

### Input
```tsx
interface Tag {
  name: string;
}

interface Item {
  label: string;
  tags: Tag[];  // Plain array in TypeScript type
  selectedIndex: number;
}

interface PatternInput {
  items?: Cell<Default<Item[], []>>;  // Cell<Item[]>, NOT OpaqueRef
}

export default pattern<PatternInput>(({ items }) => {
  const hasItems = computed(() => items.get().length > 0);

  return {
    [UI]: (
      <div>
        {hasItems ? (
          // This ternary gets wrapped in ifElse -> derive
          items.map((item) => (
            // items is Cell<Item[]>, so this map SHOULD be transformed
            <div>
              <ul>
                {item.tags.map((tag, i) => (
                  // item.tags: TypeScript sees Tag[] (plain array)
                  // But at runtime, item is opaque, so item.tags is OpaqueRef<Tag[]>
                  <li>{tag.name}</li>
                ))}
              </ul>
            </div>
          ))
        ) : (
          <p>No items</p>
        )}
      </div>
    ),
  };
});
```

### Current Expected Output (relevant snippet)
```tsx
// The outer items.map becomes:
items.mapWithPattern(__ctHelpers.recipe({/* schema */}, ({ element: item, params: {} }) => (
  <div>
    <ul>
      {item.tags.mapWithPattern(__ctHelpers.recipe({
        // Inner map is ALSO transformed to mapWithPattern
      }, ({ element: tag, index: i, params: { item } }) => (
        <li>{tag.name}</li>
      )), { item: { selectedIndex: item.selectedIndex } })}
    </ul>
  </div>
)), {})
```

### Question
When `item` comes from an outer `mapWithPattern` callback element, the TypeScript type of `item.tags` is `Tag[]` (plain array), but at runtime it's actually `OpaqueRef<Tag[]>`. Should the transformer:
- Look at the TS type (plain array -> don't transform), or
- Somehow know about the runtime opaque wrapper and transform anyway?

---

## Failure 3: `map-ternary-inside-nested-map`

### Input
```tsx
interface Tag {
  name: string;
  active: boolean;
}

interface Item {
  label: string;
  tags: Tag[];  // Plain array in TypeScript type
}

interface PatternInput {
  items?: Cell<Default<Item[], []>>;
}

export default pattern<PatternInput>(({ items, showInactive }) => {
  const hasItems = computed(() => items.get().length > 0);

  return {
    [UI]: (
      <div>
        {hasItems ? (
          items.map((item) => (
            <div>
              <ul>
                {item.tags.map((tag) => (
                  // Same issue as Failure 2: item.tags is Tag[] in TS
                  // but OpaqueRef<Tag[]> at runtime
                  <li>{tag.active ? tag.name : ""}</li>
                ))}
              </ul>
            </div>
          ))
        ) : (
          <p>No items</p>
        )}
      </div>
    ),
  };
});
```

### Current Expected Output
Same pattern as Failure 2 - `item.tags.map()` is expected to become `item.tags.mapWithPattern()`.

### Question
Same as Failure 2.

---

## Failure 4: `map-generic-type-parameter`

### Input
```tsx
interface Email {
  id: string;
  content: string;
}

interface State {
  emails: OpaqueRef<Email[]>;
  prompt: string;
}

// Standalone function - not a callback to recipe/pattern/etc
function processWithType<T>(emails: OpaqueRef<Email[]>, _prompt: string) {
  return emails.map((email: Email) => {
    const result = { id: email.id, type: "processed" as T };
    return result;
  });
}

export default recipe<State>("GenericTypeParameter", (state) => {
  const results = processWithType<string>(state.emails, state.prompt);
  return { results };
});
```

### Current Expected Output (relevant snippet)
```tsx
function processWithType<T>(emails: OpaqueRef<Email[]>, _prompt: string) {
  return emails.mapWithPattern(__ctHelpers.recipe({
    // ... recipe schema
  }, ({ element: email, params: {} }) => {
    const result = { id: email.id, type: "processed" as T };
    return result;
  }), {});
}
```

### Question
Inside a standalone function (not a callback), should `emails.map()` be transformed?

Note: The current `isInsideSafeCallbackWrapper` returns `true` for standalone functions because "we can't know where they're called from." But this causes the fix to skip transformation even when the parameter is explicitly typed as `OpaqueRef<Email[]>`.

---

## Failure 5: `derived-property-access-with-derived-key`

### Input
```tsx
interface Item {
  name: string;
  done: Cell<boolean>;
}

export default recipe<{ items: Item[] }>(
  "Derived Property Access",
  ({ items }) => {
    // items is OpaqueRef<Item[]> (from recipe state)

    const itemsWithAisles = derive({ items }, ({ items }) =>
      // Inside derive callback, items is captured
      // The transformer knows it's OpaqueRef<Item[]> (asOpaque: true in schema)
      items.map((item, idx) => ({
        aisle: `Aisle ${(idx % 3) + 1}`,
        item: item,
      }))
    );

    // ... rest of code
  },
);
```

### Current Expected Output (relevant snippet)
```tsx
const itemsWithAisles = derive({
  // ... input schema with asOpaque: true for items
}, { items }, ({ items }) => items.mapWithPattern(__ctHelpers.recipe({
  // ... recipe schema for map callback
}, ({ element: item, index: idx, params: {} }) => ({
  aisle: `Aisle ${(idx % 3) + 1}`,
  item: item,
})), {}));
```

### Question
Inside a `derive()` callback, should `items.map()` (where `items` is captured as `OpaqueRef<Item[]>`) be transformed to `mapWithPattern`?

This is the core question: derive auto-unwraps OpaqueRef, so at runtime `items` is a plain array. But the test expects transformation.

---

## Summary Table

| Test | Code pattern | My fix result | Test expects |
|------|-------------|---------------|--------------|
| handler-nested-map | `state.items.map()` inside onClick handler | NOT transform | Transform |
| pattern-nested-jsx-map | `item.tags.map()` where item from outer mapWithPattern | NOT transform | Transform |
| map-ternary-inside-nested-map | Same as above | NOT transform | Transform |
| map-generic-type-parameter | `emails.map()` in standalone function with explicit OpaqueRef type | NOT transform | Transform |
| derived-property-access | `items.map()` inside derive callback | NOT transform | Transform |

## Core Questions

1. **Should we transform `.map()` on OpaqueRef inside derive/computed?**
   - The runtime auto-unwraps OpaqueRef to plain array
   - But if we don't transform, the plain array's `.map()` returns a plain array, not an opaque result

2. **What about nested maps where the inner target comes from mapWithPattern element?**
   - TypeScript sees plain types (e.g., `Tag[]`)
   - Runtime sees opaques (e.g., `OpaqueRef<Tag[]>`)
   - Currently we transform based on TS type

3. **What about standalone functions?**
   - Can't statically determine calling context
   - Currently treated as "safe wrapper" (skip transformation with my fix)
   - But explicit `OpaqueRef<T>` type annotation suggests intent to work with opaques
