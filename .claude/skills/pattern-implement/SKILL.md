---
name: pattern-implement
description: Build sub-patterns with minimal UI
context: fork
user-invocable: false
---

# Implement Sub-Pattern

## Core Rule
Write ONE sub-pattern with minimal stub UI. No styling, just basic inputs/buttons to verify data flow.

## Order
1. Leaf patterns first (no dependencies on other patterns)
2. Container patterns (compose leaf patterns)
3. main.tsx last (composes everything)

## Read First
- `docs/common/concepts/action.md` - action() for local state
- `docs/common/concepts/handler.md` - handler() for reusable logic
- `docs/common/concepts/reactivity.md` - Cell behavior, .get()/.set()
- `docs/common/concepts/identity.md` - equals() for object comparison

## Key Patterns

**action()** - Closes over local state in pattern body:
```tsx
const inputValue = Cell.of("");
const submit = action(() => {
  items.push({ text: inputValue.get() });
  inputValue.set("");
});
```

**handler()** - Reused with different bindings:
```tsx
const deleteItem = handler<unknown, { items: Writable<Item[]>; index: number }>(
  (_, { items, index }) => items.set(items.get().toSpliced(index, 1))
);
// In JSX: onClick={deleteItem({ items, index })}
```

## Done When
- Pattern compiles: `deno task ct dev pattern.tsx --no-run`
- Minimal UI renders inputs/buttons
- Ready for testing
