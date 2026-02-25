```typescript
import { computed } from 'commontools';

interface Item { done: boolean; }
declare const items: Item[];

const summary = computed(() => {
  // Direct access - automatically tracked as dependencies
  const total = items.length;
  const done = items.filter(item => item.done).length;
  return `${done} of ${total} complete`;
});
```

See also: [Summary Convention](../../conventions/summary.md) for the hierarchical
summary pattern used by container patterns.
