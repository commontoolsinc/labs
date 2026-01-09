
### Never Nest computed()

There is never a reason to nest `computed()` calls. The inner `computed()` returns a cell reference, not a value, which breaks reactivity:

```typescript
// ❌ WRONG - never nest computed()
const value = computed(() => 123 + computed(() => myCell.get() * 2));

// ✅ CORRECT - declare separately
const doubled = computed(() => myCell.get() * 2);
const value = computed(() => 123 + doubled);
```
