### action() vs handler()

**Use `action()`** for inline handlers where all data is in scope (closes over variables):

```tsx
import { action, handler, pattern, Cell, UI, Stream } from 'commontools';

interface Output {
  increment: Stream<void>;  // Only handlers can be exported
}

export default pattern<Record<string, never>, Output>(_ => {
  const count = Cell.of(0);

  // action() - closes over count, used inline in JSX
  const incrementAction = action(() => count.set(count.get() + 1));

  // handler() with binding - can be exported as Stream
  const incrementHandler = handler<void, { count: Cell<number> }>(
    (_, { count }) => count.set(count.get() + 1)
  );

  return {
    increment: incrementHandler({ count }), // Bound handler IS the Stream
    [UI]: (
      <div>
        <div>Count: {count}</div>
        {/* action() used inline - not exported */}
        <ct-button onClick={incrementAction}>+1 (action)</ct-button>
        {/* Or use handler bound inline */}
        <ct-button onClick={incrementHandler({ count })}>+1 (handler)</ct-button>
      </div>
    ),
  };
});
```

**Key difference:**
- `action()` returns a function for inline use (onClick, etc.) - **cannot be exported**
- `handler()` bound with state returns `Stream<T>` - **can be exported** for other charms to call via linking
