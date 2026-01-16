## Handler Types in Output Interfaces

Handlers exposed in Output interfaces must be typed as `Stream<T>`.

```typescript
import { Stream } from 'commontools';

interface Output {
  count: number;
  increment: Stream<void>;           // Handler with no parameters
  setCount: Stream<{ value: number }>; // Handler with parameters
}
```

**Why Stream<T>?**
- `Stream<T>` represents a write-only channel for triggering actions
- Other charms can call these handlers via `.send()` when linked

### Creating Streams (Bound Handlers)

A bound handler IS a `Stream<EventType>`. Don't try to create streams directly:

```typescript
import { handler, pattern, Writable, Stream } from 'commontools';

interface Item { title: string }

// ✅ CORRECT - Define handler, bind with state
const addItemHandler = handler<
  Item,          // Event type
  { items: Writable<Item[]> } // State type
>(({ title }, { items }) => {
  items.push({ title });
});

interface Output {
  addItem: Stream<{ title: string }>;
}

export default pattern<Record<string, never>, Output>(_ => {
  const items = Writable.of([] as Array<Item>)
  
  // Binding returns Stream<Item>
  const addItem = addItemHandler({ items });
  
  // Export in return
  return {
    addItem,  // This IS Stream<{ title: string }>
  };
})
```

The bound handler is the stream. Other patterns or charms can send events to it via linking.
