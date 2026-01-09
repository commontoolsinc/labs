# Performance Issues

For lists with 100+ items that feel slow, apply these optimizations.

## Don't Create Handlers in .map()

```typescript
// Creates handler per item per render
{items.map(item => {
  const remove = handler(() => { ... });
  return <ct-button onClick={remove}>x</ct-button>;
})}

// Create once, reuse
const removeItem = handler((_, { items, item }) => { ... });
{items.map(item => <ct-button onClick={removeItem({ items, item })}>x</ct-button>)}
```

## Pre-compute Outside Loops

```typescript
// Expensive in loop
{items.map(item => <div>{computed(() => expensive(item))}</div>)}

// Compute once
const processed = computed(() => items.map(expensive));
{processed.map(result => <div>{result}</div>)}
```

## See Also

- @common/concepts/reactivity.md - Reactivity and computed patterns
