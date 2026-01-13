# Reactive Reference Outside Context

**Error:** `Tried to access a reactive reference outside a reactive context`

**Cause:** Using a reactive value (from `.map()` iteration) to index into a plain JavaScript object.

```typescript
const STYLES = {
  pending: { color: "#92400e" },
  active: { color: "#1e40af" },
};

// CORRECT - Use lift() for object indexing
const getStyleColor = lift((status: Status): string => STYLES[status].color);

items.map((item) => (
  <div style={{ color: getStyleColor(item.status) }}>
    {item.title}
  </div>
));
```

**Why this happens:** Inside `.map()`, each item's properties are reactive references. Using them to index plain objects (`STYLES[item.status]`) tries to access the reactive reference outside a reactive context. The `lift()` function creates a proper reactive context for the lookup.

## See Also

- @common/concepts/reactivity.md - Using reactive values to index objects in map
