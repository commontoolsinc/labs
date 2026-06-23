# Eager Ternary Branch Evaluation

**Symptom:** `Cannot read properties of null (reading '...')` (or
`undefined`) crashes — or `[object Object]`/`undefined` renders — exactly when
a conditional section should be showing its *fallback* branch.

**Cause:** The compiler lowers JSX ternaries to
`ifElse(cond, branchA, branchB)`. Both branch expressions are evaluated as
**arguments** before the call — there is no short-circuiting. Every JS
instinct says the untaken branch never runs; here it does.

Verified with `cf check --show-transformed`: the authored ternary

```tsx
// Shown inside a pattern body.
{selectedItem ? selectedItem.label : "Nothing selected"}
```

lowers to

```ts
// Shown as JSX element children.
__cfHelpers.ifElse(/* schemas */, selectedItem, selectedItem.key("label"), "Nothing selected")
```

`selectedItem.key("label")` is built eagerly even when `selectedItem` is
`null` — so the property access happens regardless of the condition.

```tsx
// Shown inside a pattern body.
// WRONG - selectedItem.label is dereferenced even when selectedItem is null
const selectedItem = computed(() =>
  selectedIndex < items.length ? items[selectedIndex] : null
);
{selectedItem ? selectedItem.label : "Nothing selected"}

// CORRECT - defer the property access inside a computed()
const selectedLabel = computed(() => selectedItem?.label ?? "Nothing selected");
{selectedLabel}

// Also correct - keep the ternary, wrap only the truthy branch
{selectedItem
  ? computed(() => selectedItem?.label ?? "")
  : "Nothing selected"}
```

Inside a `computed()` body, code is plain JavaScript again, so `?.` and
ordinary short-circuiting work as expected.

**Do NOT "clean up" protective `computed()` wrappers around conditional
branches** — they look redundant but are load-bearing: they defer the branch
expression so it only resolves against a live value. This bug class survives
the type checker, renders fine in the happy path, and only crashes when the
fallback branch is active.

## See Also

- [Conditional Rendering](../../../common/patterns/conditional.md) - ternaries are the idiom
- [ifElse with Composed Pattern Cells](ifelse-composed-pattern-cells.md) - related ifElse hang
