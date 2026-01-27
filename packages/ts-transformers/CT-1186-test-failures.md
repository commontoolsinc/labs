# CT-1186 Transformer Fix - Test Failure Analysis

## Context

We're implementing a fix for CT-1186: inside `computed`/`derive` callbacks,
`OpaqueRef<T>` gets auto-unwrapped to plain `T`, so we should NOT transform
`.map()` to `.mapWithPattern()` for OpaqueRef types in those contexts. Cell and
Stream do NOT get auto-unwrapped, so we should still transform those.

**The fix**: In `shouldTransformMap()`, when inside a "safe wrapper" (computed,
derive, action, lift, handler), only transform if
`cellKind === "cell" || cellKind === "stream"`, not if `cellKind === "opaque"`.

This fix causes 5 test failures. Below are the input snippets and what the tests
currently expect.

## Debug Output

For `handler-nested-map`, the transformer sees:

```
target="state.items"
type="OpaqueCell<{ value: number; }[]> & (OpaqueCell<{ value: number; }> & { value: OpaqueCell<number> & number; })[]"
isOpaque=true
cellKind=opaque
insideSafeWrapper=true
```

Key observation: The type is `OpaqueCell`, not `OpaqueRef`. `OpaqueCell` has
brand `"opaque"`, so `getCellKind()` returns `"opaque"`.

## Important Question About Runtime Behavior

The "safe wrapper" concept in the transformer has two different meanings:

1. **Validation context**: Where you CAN read opaques without error (derive,
   computed, handler, etc.)
2. **Auto-unwrap context**: Where OpaqueRef gets auto-unwrapped to plain values

**Are these the same?** Looking at the runtime:

- `handler` passes `props.$ctx` directly to the callback (no unwrapping visible)
- The handler schema marks captured values with `asOpaque: true` (but you
  mentioned this is ignored?)
- The values passed are whatever was in the binding:
  `{ state: { items: state.items, ... } }`

**Core question**: At runtime, when inside a handler/derive/computed callback,
are the captured OpaqueCell/OpaqueRef values:

- Still cells (meaning `.map()` needs to be transformed to `.mapWithPattern()`)
- Or plain unwrapped values (meaning plain `.map()` would work)?

---

## Failure 1: `handler-nested-map`

### Input

```tsx
interface State {
  items: Array<{ value: number }>; // items is OpaqueRef<Array<...>> at runtime
  multiplier: number;
}

export default recipe<State>("NestedMap", (state) => {
  return {
    [UI]: (
      <button
        onClick={() => {
          // onClick becomes handler() - a "safe wrapper"
          const scaled = state.items.map((item) =>
            item.value * state.multiplier
          );
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

Inside a `handler()` callback, should `state.items.map()` (where `state.items`
is `OpaqueRef<T[]>`) be transformed to `mapWithPattern`?

---

## Failure 2: `pattern-nested-jsx-map`

### Input

```tsx
interface Tag {
  name: string;
}

interface Item {
  label: string;
  tags: Tag[]; // Plain array in TypeScript type
  selectedIndex: number;
}

interface PatternInput {
  items?: Cell<Default<Item[], []>>; // Cell<Item[]>, NOT OpaqueRef
}

export default pattern<PatternInput>(({ items }) => {
  const hasItems = computed(() => items.get().length > 0);

  return {
    [UI]: (
      <div>
        {hasItems
          ? (
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
          )
          : <p>No items</p>}
      </div>
    ),
  };
});
```

### Current Expected Output (relevant snippet)

```tsx
// The outer items.map becomes:
items.mapWithPattern(
  __ctHelpers.recipe({/* schema */}, ({ element: item, params: {} }) => (
    <div>
      <ul>
        {item.tags.mapWithPattern(
          __ctHelpers.recipe(
            {
              // Inner map is ALSO transformed to mapWithPattern
            },
            ({ element: tag, index: i, params: { item } }) => (
              <li>{tag.name}</li>
            ),
          ),
          { item: { selectedIndex: item.selectedIndex } },
        )}
      </ul>
    </div>
  )),
  {},
);
```

### Question

When `item` comes from an outer `mapWithPattern` callback element, the
TypeScript type of `item.tags` is `Tag[]` (plain array), but at runtime it's
actually `OpaqueRef<Tag[]>`. Should the transformer:

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
  tags: Tag[]; // Plain array in TypeScript type
}

interface PatternInput {
  items?: Cell<Default<Item[], []>>;
}

export default pattern<PatternInput>(({ items, showInactive }) => {
  const hasItems = computed(() => items.get().length > 0);

  return {
    [UI]: (
      <div>
        {hasItems
          ? (
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
          )
          : <p>No items</p>}
      </div>
    ),
  };
});
```

### Current Expected Output

Same pattern as Failure 2 - `item.tags.map()` is expected to become
`item.tags.mapWithPattern()`.

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
  return emails.mapWithPattern(
    __ctHelpers.recipe({
      // ... recipe schema
    }, ({ element: email, params: {} }) => {
      const result = { id: email.id, type: "processed" as T };
      return result;
    }),
    {},
  );
}
```

### Question

Inside a standalone function (not a callback), should `emails.map()` be
transformed?

Note: The current `isInsideSafeCallbackWrapper` returns `true` for standalone
functions because "we can't know where they're called from." But this causes the
fix to skip transformation even when the parameter is explicitly typed as
`OpaqueRef<Email[]>`.

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
      })));

    // ... rest of code
  },
);
```

### Current Expected Output (relevant snippet)

```tsx
const itemsWithAisles = derive(
  {
    // ... input schema with asOpaque: true for items
  },
  { items },
  ({ items }) =>
    items.mapWithPattern(
      __ctHelpers.recipe({
        // ... recipe schema for map callback
      }, ({ element: item, index: idx, params: {} }) => ({
        aisle: `Aisle ${(idx % 3) + 1}`,
        item: item,
      })),
      {},
    ),
);
```

### Question

Inside a `derive()` callback, should `items.map()` (where `items` is captured as
`OpaqueRef<Item[]>`) be transformed to `mapWithPattern`?

This is the core question: derive auto-unwraps OpaqueRef, so at runtime `items`
is a plain array. But the test expects transformation.

---

## Summary Table

| Test                          | Code pattern                                                       | My fix result | Test expects |
| ----------------------------- | ------------------------------------------------------------------ | ------------- | ------------ |
| handler-nested-map            | `state.items.map()` inside onClick handler                         | NOT transform | Transform    |
| pattern-nested-jsx-map        | `item.tags.map()` where item from outer mapWithPattern             | NOT transform | Transform    |
| map-ternary-inside-nested-map | Same as above                                                      | NOT transform | Transform    |
| map-generic-type-parameter    | `emails.map()` in standalone function with explicit OpaqueRef type | NOT transform | Transform    |
| derived-property-access       | `items.map()` inside derive callback                               | NOT transform | Transform    |

## Investigation Findings (Updated)

### (1) handler-nested-map

- `state.items` type: `OpaqueCell<{ value: number; }[]>`
- `cellKind=opaque`, `insideSafeWrapper=true`
- **Berni says**: Correct to NOT transform. Testing at runtime to verify.

**Runtime Test Result**: FAILS with error:

```
Error: Tried to access a reactive reference outside a reactive context.
```

**Root Cause Analysis**: The handler callback code runs at TWO different times:

1. **Definition time** (during recipe execution): The handler IIFE is evaluated
2. **Fire time** (when user clicks): The handler callback is invoked with
   resolved arguments

At **definition time**, `state.items.map(...)` is executed. At this point:

- `state.items` IS an OpaqueCell (not yet resolved to plain array)
- `OpaqueCell.map()` internally calls `recipe(...)` which creates a reactive
  context
- Inside that recipe, `item` becomes `OpaqueRef<{value: number}>`
- The callback `(item) => item.value * state.multiplier` tries to multiply
  OpaqueRefs
- Multiplication triggers `Symbol.toPrimitive`, which throws the error

**Key Insight**: The "safe wrapper" concept was designed for cases where the
callback runs INSIDE a reactive context (like derive/computed). But handler
callbacks run at definition time, NOT inside a reactive context. The
auto-unwrapping only happens at handler **fire** time when arguments are
resolved.

**Conclusion**: Handler callbacks NEED `.map()` to be transformed to
`.mapWithPattern()` because the code runs at definition time when variables are
still OpaqueCell/OpaqueRef.

**This contradicts Berni's initial assessment** - we need to discuss this
finding.

### (2/3) pattern-nested-jsx-map and map-ternary-inside-nested-map

Debug output:

```
target="items" type="Cell<Item[]>" cellKind=cell insideSafeWrapper=true -> transforms ✓
target="item.tags" type="OpaqueCell<Tag[]>" cellKind=opaque insideSafeWrapper=true -> does NOT transform ✗
```

**Issue**: `item.tags` is inside a `mapWithPattern` callback where `item` is the
element parameter. Inside mapWithPattern callbacks, the element is opaque, so
`item.tags` should also be opaque and SHOULD be transformed.

But my fix sees `insideSafeWrapper=true` (from the outer ifElse/derive) and
`cellKind=opaque`, so it skips transformation.

**Key insight**: The "safe wrapper" (derive) unwraps _captured_ variables, but
the mapWithPattern callback's element parameter is NOT unwrapped. We need to
distinguish between:

- Captured variables inside derive → unwrapped → don't transform
- mapWithPattern element properties → still opaque → DO transform

### (4) map-generic-type-parameter

The standalone function error is NOT yet implemented. We have validation for
casts and pattern context (from PR #2454), but no compile-time error for
standalone functions using reactive primitives.

### (5) derived-property-access-with-derived-key

Debug output:

```
target="items" type="OpaqueCell<Item[]>" cellKind=opaque insideSafeWrapper=true -> does NOT transform
target="aisleNames" type="OpaqueCell<string[]>" cellKind=opaque insideSafeWrapper=false -> transforms ✓
```

**Berni says**: Correct to NOT transform `items.map()` inside derive (it's a
captured variable that gets unwrapped).

The `aisleNames.map()` is outside derive (in JSX), so it correctly transforms.

**Needs Verification**: Does derive actually auto-unwrap captured OpaqueRef
values at runtime? Or does the same definition-time vs fire-time issue apply as
with handlers?

Looking at `derive()` implementation:

```js
export function derive<In, Out>(...args: any[]): OpaqueRef<any> {
  // ...
  return lift(f)(input);
}
```

And `lift()` internally uses `recipe()`. So the callback to `derive` runs inside
a reactive context created by `recipe()`. This is DIFFERENT from handlers -
derive callbacks DO run in a reactive context.

**Conclusion**: Derive callbacks are genuinely "safe" - the captured OpaqueRef
values ARE auto-unwrapped inside the lift/recipe context. So NOT transforming is
correct for derive.

## Core Questions

1. **How to distinguish captured variables (unwrapped) from mapWithPattern
   element properties (not unwrapped)?**
   - `preRegisterCaptureTypes` only handles direct identifier captures, not
     property accesses
   - For (2/3), `item.tags` comes from the mapWithPattern element, not a derive
     capture
   - Need a way to detect "we're inside a mapWithPattern callback" separately
     from "we're inside a derive"

2. **Proposed approach**: Check if we're inside a mapWithPattern callback. If
   so, element properties should still be transformed even if we're also inside
   a derive. The derive only unwraps its _captured_ variables, not the map
   element.

3. **For standalone functions (4)**: Separate task to add compile-time error
   when standalone function uses reactive primitives

## Updated Analysis Summary

After runtime testing and code tracing:

| Test                    | Berni's Assessment | Runtime Result            | Correct Behavior                        |
| ----------------------- | ------------------ | ------------------------- | --------------------------------------- |
| (1) handler-nested-map  | Don't transform    | **FAILS** (runtime error) | **MUST transform**                      |
| (2/3) nested maps       | Should transform   | N/A                       | Must transform (map element properties) |
| (4) standalone function | Separate task      | N/A                       | Separate task for compile-time error    |
| (5) derive              | Don't transform    | N/A                       | **Correct - derive auto-unwraps**       |

**Key Finding**: Handlers are NOT "safe wrappers" in the same sense as
derive/computed. Handler callbacks run at definition time (during recipe
execution), not inside a reactive context. The auto-unwrapping only happens at
handler fire time when arguments are resolved.

**Recommended Fix**:

1. **Remove handler from SAFE_WRAPPER_BUILDERS** - handlers are NOT safe
   contexts for skipping .map() transformation
2. Keep derive, computed, lift in SAFE_WRAPPER_BUILDERS - these DO auto-unwrap
3. For (2/3), need separate logic to handle mapWithPattern element properties
