### action() - Simplified Handlers

For inline handlers where all data is in scope at definition time:

```tsx
import { action, handler, pattern, Cell, Stream } from 'commontools';

interface Output {
  exportedAction: Stream<void>;
  exportedBoundHandler: Stream<void>;
}

export default pattern<Record<string, never>, Output>(_ => {
  const count = Cell.of(0);

  // action - data bound at definition (closes over count)
  const myAction = action(() => count.set(count.get() + 1))
  
  // handler - data bound at invocation (row, col passed per-call)
  const myHandler = handler<unknown, { count: Cell<number> }>((_ev, { count }) => {
    return count.set(count.get() + 1);
  })

  // TODO(bf): why does this fail typecheck?
  // we get: Type 'HandlerFactory<unknown, void>' is not assignable to type 'Opaque<Stream<void>>'. 
  return {
    exportedAction: myAction,
    exportedBoundHandler: myHandler({ count })
  }
})
```

Use `handler()` when you need to pass data at invocation time (e.g., loop variables). Use `action()` for simple inline mutations where everything needed is already in scope.
