### Never Nest computed()

There is never a reason to nest `computed()` calls. The inner `computed()` returns a cell reference, not a value, which breaks reactivity:

```typescript
import { computed, Writable } from 'commontools';

const myCell = Writable.of(10);

// ❌ WRONG - never nest computed()
const badValue = computed(() => 123 + computed(() => myCell.get() * 2));

// ✅ CORRECT - declare separately
const doubled = computed(() => myCell.get() * 2);
const goodValue = computed(() => 123 + doubled);
```
