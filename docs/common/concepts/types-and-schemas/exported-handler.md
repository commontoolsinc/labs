## Handler Types in Output Interfaces

Handlers exposed in Output interfaces must be typed as `Stream<T>`.

```typescript
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
// ❌ WRONG - Stream.of() and .subscribe() don't exist
const addItem: Stream<{ title: string }> = Stream.of();
addItem.subscribe(({ title }) => { ... });  // Error!

// ✅ CORRECT - Define handler, bind with state
const addItemHandler = handler<
  { title: string },          // Event type
  { items: Writable<Item[]> } // State type
>(({ title }, { items }) => {
  items.push({ title });
});

// Binding returns Stream<{ title: string }>
const addItem = addItemHandler({ items });

// Export in return
return {
  addItem,  // This IS Stream<{ title: string }>
};
```

The bound handler is the stream. Other patterns or charms can send events to it via linking.
