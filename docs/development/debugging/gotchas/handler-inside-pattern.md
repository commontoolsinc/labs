# handler() or Function Inside Pattern

**Error:** `handler() should be defined at module scope, not inside a pattern` or `Function creation is not allowed in pattern context` or `lift() should not be immediately invoked inside a pattern`

**Cause:** The CTS transformer requires that `handler()`, `lift()`, and helper functions be defined at module scope (outside the pattern body). The transformer cannot process closures over pattern-scoped variables.

## Wrong

```typescript
export default pattern<Input, Input>(({ items }) => {
  const addItem = handler((_, { items }) => {  // Error!
    items.push({ title: "New" });
  });

  const formatDate = (d: string) => new Date(d).toLocaleDateString();  // Error!

  return { ... };
});
```

## Correct

```typescript
// Handler at module scope
const addItem = handler<unknown, { items: Writable<Item[]> }>(
  (_, { items }) => {
    items.push({ title: "New" });
  }
);

// Helper function at module scope
const formatDate = (d: string): string => new Date(d).toLocaleDateString();

export default pattern<Input, Input>(({ items }) => ({
  [UI]: <ct-button onClick={addItem({ items })}>Add</ct-button>,
  items,
}));
```

## For Immediately-Invoked lift()

```typescript
// WRONG - lift defined and invoked inside pattern
const result = lift((args) => args.grouped[args.date])({ grouped, date });

// CORRECT - use computed() instead
const result = computed(() => grouped[date]);

// OR define lift at module scope
const getByDate = lift((args: { grouped: Record<string, Item[]>; date: string }) =>
  args.grouped[args.date]
);
// Then use inside pattern:
const result = getByDate({ grouped, date });
```

## Allowed Inside Patterns

These are fine inside pattern context:
- `computed()` callbacks
- `action()` callbacks
- `.map()` callbacks on cells/opaques
- JSX event handlers (e.g., `onClick={() => ...}`)

## See Also

- [@handler](../../../common/concepts/handler.md) - Handler basics and module scope
- [@lift](../../../common/concepts/lift.md) - Lift basics and module scope
