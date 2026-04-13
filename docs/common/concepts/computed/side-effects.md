
### Side Effects in computed()

If your `computed()` has side effects (like setting another cell), they should be idempotent. Non-idempotent side effects cause the scheduler to re-run repeatedly until it hits the 101-iteration limit.

```typescript
import { computed, pattern, safeDateNow, Writable } from 'commonfabric';

interface Props {}

export default pattern<Props, Props>((_) => {
  const logArray = Writable.of<Array<{ timestamp: number }>>([]);
  const cacheMap = Writable.of<Record<string, number>>({});
    
  // ❌ Non-idempotent - appends on every run
  const badComputed = computed(() => {
    const current = logArray.get();
    logArray.set([...current, { timestamp: safeDateNow() }]);  // Grows forever
    return logArray.get().length;
  });
  
  // ✅ Idempotent - check-before-write with deterministic key
  const goodComputed = computed(() => {
    const current = cacheMap.get();
    const key = `items-${Object.keys(current).length}`;
    if (!(key in current)) {
      cacheMap.set({ ...current, [key]: safeDateNow() });
    }
    return Object.values(cacheMap.get()).length;
  });
  
  return {};
})

```

These examples use `safeDateNow()` to stay within authored APIs. The problem is
still the side effect inside `computed()`, not the time helper itself.

The scheduler re-runs computations when their dependencies change. If a computation modifies a cell it depends on, it triggers itself. With idempotent operations, the second run produces no change, so the system settles.

Prefer using handlers for mutations instead of side effects in `computed()`.
