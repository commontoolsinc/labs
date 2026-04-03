# handler() or Function Inside Pattern

**Error:** `handler() should be defined at module scope, not inside a pattern` or `Function creation is not allowed in pattern context` or `lift() should not be immediately invoked inside a pattern`

**Cause:** The CTS transformer requires that `handler()`, `lift()`, and helper functions be defined at module scope (outside the pattern body). The transformer cannot process closures over pattern-scoped variables.

## Quick Fix: Use action() Instead

For most event handling, use `action()` which IS allowed inside patterns and automatically closes over pattern state:

```typescript
export default pattern<Input, Input>(({ items }) => {
  // action() works inside patterns - this is the recommended approach
  const addItem = action(() => {
    items.push({ title: "New" });
  });

  return {
    [UI]: <ct-button onClick={addItem}>Add</ct-button>,
    items,
  };
});
```

Only use `handler()` when you need to reuse the same logic with different state bindings, or export the handler for other patterns to call.

## Wrong - handler() Inside Pattern

```typescript
export default pattern<Input, Input>(({ items }) => {
  const addItem = handler((_, { items }) => {  // Error!
    items.push({ title: "New" });
  });

  const formatDate = (d: string) => new Date(d).toLocaleDateString();  // Error!

  return { ... };
});
```

## Correct - handler() at Module Scope

If you need `handler()` specifically (for reusability or exports), define it outside the pattern:

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
