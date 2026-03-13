# Style Object Reference Gotcha

## What the bug is

When multiple sibling elements share the same style object *reference*, only the
first sibling gets the styles applied. The remaining siblings render without
styling (no background, no border-radius, no box-shadow, etc.).

## Why it happens

The Common Fabric runtime uses reference equality to optimize style application.
When it encounters the same object reference on a second element, it assumes the
style has already been processed and skips re-applying it. This is an
optimization that works correctly when a single element's style doesn't change
between renders, but breaks when the same object is intentionally shared across
multiple sibling elements.

In short: **same reference = "no change" to the runtime**, even when the style
needs to be applied to a different DOM node.

## The fix

Use a factory function that returns a fresh object for each element:

```tsx
// BUG: shared reference -- only first sibling gets styled
const cardStyle = { background: "white", borderRadius: "8px", padding: "16px" };

items.map((item) => <div style={cardStyle}>...</div>)

// FIX: factory function -- every sibling gets a new object
function makeCardStyle() {
  return { background: "white", borderRadius: "8px", padding: "16px" };
}

items.map((item) => <div style={makeCardStyle()}>...</div>)
```

Each call to `makeCardStyle()` returns a new object with a distinct reference,
so the runtime treats each one as fresh and applies the styles correctly.

## When you'd encounter this

Any time you reuse a style object across sibling elements:

- Mapping over a list and applying the same style object to each item
- Rendering a fixed set of sibling divs that share a common style variable
- Extracting a "theme" object and applying it to multiple elements at the same
  level

This does NOT affect:
- String styles (`style="color: red"`) -- strings are compared by value
- Styles on elements that are NOT siblings (e.g., nested at different levels)
- Styles that are only used on a single element

## Reproduction

Run this pattern with `deno task ct check main.tsx` and observe:
- **Bug Demo** (blue left border): Only the first card is styled
- **Fix Demo** (green left border): All cards are styled correctly
