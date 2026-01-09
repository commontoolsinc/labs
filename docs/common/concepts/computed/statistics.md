```tsx
import { pattern, computed, UI, VNode } from 'commontools';

interface Input {
  items: Array<{ done: boolean, title: string }>
}

interface Output {
  [UI]: VNode
}

export default pattern<Input, Output>(({ items }) => {
  const stats = computed(() => ({
    total: items.length,
    completed: items.filter(item => item.done).length,
    pending: items.filter(item => !item.done).length,
    completionRate: items.length > 0
      ? (items.filter(item => item.done).length / items.length) * 100
      : 0,
  }));
  
  return {
    [UI]: <div>
      <div>Total: {stats.total}</div>
      <div>Done: {stats.completed}</div>
      <div>Remaining: {stats.pending}</div>
      <div>Progress: {stats.completionRate.toFixed(1)}%</div>
    </div>
  }
})
```
