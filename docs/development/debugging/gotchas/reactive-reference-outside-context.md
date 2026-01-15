# Reactive Reference Outside Context

**Error:** `Tried to access a reactive reference outside a reactive context`

**Cause:** Accessing a reactive value at pattern initialization time, outside of a reactive context like `computed()`, `lift()`, or JSX expressions.

This commonly happens in these scenarios:

## Scenario 1: Using reactive input props in `[NAME]`

When a pattern receives input props, accessing their properties in the return statement's `[NAME]` field happens at initialization time.

```tsx
// WRONG - accesses reactive value at init time
export default pattern<Input>(({ deck }) => {
  return {
    [NAME]: deck.name,  // ERROR
    [NAME]: `Study: ${deck.name}`,  // ERROR - same problem
    ...
  };
});

// CORRECT - wrap in computed()
export default pattern<Input>(({ deck }) => {
  return {
    [NAME]: computed(() => deck.name),
    [NAME]: computed(() => `Study: ${deck.name}`),
    ...
  };
});
```

## Scenario 2: Initializing Writable with reactive values

You cannot pass a reactive value to `Writable.of()` because initialization happens outside a reactive context.

```tsx
// WRONG - deck.name is reactive
export default pattern<Input>(({ deck }) => {
  const editedName = Writable.of(deck.name);  // ERROR
  ...
});

// CORRECT - initialize empty, set in event handler
export default pattern<Input>(({ deck }) => {
  const editedName = Writable.of("");

  // Event handlers run at click time, not init time
  const startEditing = action(() => {
    editedName.set(deck.name);  // OK - inside event handler
    editingMode.set(true);
  });
  ...
});
```

## Scenario 3: Using reactive values to index plain objects in `.map()`

```typescript
const STYLES = {
  pending: { color: "#92400e" },
  active: { color: "#1e40af" },
};

// WRONG - item.status is reactive
items.map((item) => (
  <div style={{ color: STYLES[item.status].color }}>  // ERROR
    {item.title}
  </div>
));

// CORRECT - Use lift() for object indexing
const getStyleColor = lift((status: Status): string => STYLES[status].color);

items.map((item) => (
  <div style={{ color: getStyleColor(item.status) }}>
    {item.title}
  </div>
));
```

**Why this happens:** The pattern body executes once at initialization to build the reactive graph. Reactive values (input props, cell contents) can only be accessed inside reactive contexts: `computed()`, `lift()`, JSX expressions, or event handlers. Accessing them directly at init time tries to read a reactive reference before the reactive system is active.

## See Also

- @common/concepts/reactivity.md - Using reactive values to index objects in map
