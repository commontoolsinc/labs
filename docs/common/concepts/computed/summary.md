```typescript
const summary = computed(() => {
  // Direct access - automatically tracked as dependencies
  const total = items.length;
  const done = items.filter(item => item.done).length;
  return `${done} of ${total} complete`;
});
```
