# lift() Returns Stale/Empty Data

**Symptom:** `lift()` returns 0, empty object, or stale values even when the source cell has data.

```typescript
// WRONG: Passing cell directly to lift()
const calcTotal = lift((expenses: Expense[]): number => {
  return expenses.reduce((sum, e) => sum + e.amount, 0);
});
const total = calcTotal(expenses);  // Returns 0!

// CORRECT: Use computed() instead
const total = computed(() => {
  const exp = expenses.get();
  return exp.reduce((sum, e) => sum + e.amount, 0);
});

// CORRECT: If using lift(), pass as object parameter
const calcTotal = lift((args: { expenses: Expense[] }): number => {
  return args.expenses.reduce((sum, e) => sum + e.amount, 0);
});
const total = calcTotal({ expenses });
```

**Why:** `lift()` creates a new frame, and cells cannot be accessed via closure across frames. `computed()` gets automatic closure extraction by the CTS transformer; `lift()` does not. Use `computed()` by default in patterns.

## See Also

- @common/concepts/reactivity.md - Reactivity system, lift() and closure limitations
