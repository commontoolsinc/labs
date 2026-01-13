### cell.sample() - Non-Reactive Reads

Use `.sample()` to read a cell's value **without creating a reactive dependency**:

```typescript
// In a computed() - normally .get() would cause re-runs when the cell changes
const result = computed(() => {
  const currentUser = userCell.get();      // Creates dependency - result re-runs when userCell changes
  const initialValue = configCell.sample(); // NO dependency - result won't re-run when configCell changes
  return doSomething(currentUser, initialValue);
});
```

**When to use `.sample()`:**
- Reading configuration or initial values that shouldn't trigger updates
- Breaking intentional reactive loops
- Performance optimization when you want a "snapshot" of a value

**Caution:** Overusing `.sample()` can lead to stale data. Only use it when you specifically want to avoid reactivity.
