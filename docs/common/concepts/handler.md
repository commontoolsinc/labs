# Reusable Handlers

Use `handler()` when you need to define event-handling logic once and bind it to different state at multiple call sites. For most cases, prefer [`action()`](./action.md) which is simpler and closes over pattern state directly.

## When to Use `handler()`

1. **Same logic, different state** - You want to reuse identical handler logic with different state
2. **Exported streams** - Other patterns need to call your handler via linking
3. **CLI testing** - You want to test handlers via `cf piece call` before building UI

## Basic Structure

```typescript
import { handler, Writable } from "commonfabric";

// Define at module scope (outside pattern body)
const increment = handler<EventType, StateType>((event, state) => {
  // event = data passed to .send()
  // state = state bound when handler is invoked
});
```

**Type annotations are required** - without them, parameters become `any`.

## Example: Reusable Counter Logic

```tsx
import { handler, pattern, Writable, UI } from "commonfabric";

// Define once at module scope
const increment = handler<void, { count: Writable<number> }>(
  (_, { count }) => count.set(count.get() + 1)
);

const decrement = handler<void, { count: Writable<number> }>(
  (_, { count }) => count.set(count.get() - 1)
);

export default pattern(() => {
  const counterA = Writable.of(0);
  const counterB = Writable.of(100);

  return {
    [UI]: (
      <div>
        {/* Same logic bound to different state */}
        <div>
          Counter A: {counterA}
          <cf-button onClick={increment({ count: counterA })}>+</cf-button>
          <cf-button onClick={decrement({ count: counterA })}>-</cf-button>
        </div>
        <div>
          Counter B: {counterB}
          <cf-button onClick={increment({ count: counterB })}>+</cf-button>
          <cf-button onClick={decrement({ count: counterB })}>-</cf-button>
        </div>
      </div>
    ),
  };
});
```

## Module Scope Requirement

The pattern transformer requires `handler()` to be defined **outside** the pattern body. Only the binding (passing state) happens inside:

```typescript
// CORRECT - Define at module scope, bind inside pattern
const addItem = handler<{ title: string }, { items: Writable<Item[]> }>(
  ({ title }, { items }) => items.push({ title, done: false })
);

export default pattern(({ items }) => ({
  [UI]: <cf-button onClick={addItem({ items })}>Add</cf-button>,
  items,
}));

// WRONG - Defined inside pattern body
export default pattern(({ items }) => {
  const addItem = handler(...);  // Error: must be at module scope
  return { ... };
});
```

**Why:** The CTS transformer processes patterns at compile time and cannot handle closures over pattern-scoped variables in handlers.

Handlers also live on the verified SES module-scope surface. Define them once
at the top level, then pass any changing state through the binding object
instead of hiding it in module-scoped mutable variables.

## SES-Friendly Handlers

- Bind changing state explicitly. Avoid top-level mutable caches, counters, or
  class instances.
- Keep the handler callback direct and readable. If the body becomes too
  imperative, push complex logic into a helper and keep the bound state
  explicit.
- Use `safeDateNow()` and `nonPrivateRandom()` instead of ambient
  `Date.now()` and `Math.random()` when a handler needs a timestamp or random
  ID.
- Timers are not exposed inside authored modules yet, so do not rely on
  `setTimeout()` or `setInterval()` in handler code.

## Exporting Handlers as Streams

Bound handlers become `Stream<T>` and can be exported for other patterns to call:

```tsx
import { handler, pattern, Stream, Writable, UI } from "commonfabric";

interface Output {
  addItem: Stream<{ title: string }>;  // Exported stream
}

const addItem = handler<{ title: string }, { items: Writable<Item[]> }>(
  ({ title }, { items }) => items.push({ title, done: false })
);

export default pattern<{}, Output>(({ items }) => ({
  [UI]: <div>...</div>,
  items,
  addItem: addItem({ items }),  // Export the bound handler
}));
```

Other patterns can then link to this pattern and call `linkedPattern.addItem.send({ title: "New" })`.

## Handlers with Event Data

The first parameter receives data passed to `.send()`:

```typescript
const addItem = handler<{ title: string }, { items: Writable<Item[]> }>(
  ({ title }, { items }) => {
    items.push({ title, done: false });
  }
);

// Call with event data
addItem({ items }).send({ title: "My Item" });
```

## Void Handlers

For handlers that don't need event data, use `void`:

```typescript
const clearAll = handler<void, { items: Writable<Item[]> }>(
  (_, { items }) => items.set([])
);

// Call without arguments
clearAll({ items }).send();
```

## CLI Testing

Export handlers to test them via CLI during development:

```bash
# Call a handler with JSON payload
deno task cf piece call addItem '{"title": "Test"}' --piece <ID>

# Step to process
deno task cf piece step --piece <ID>

# Verify state
deno task cf piece inspect --piece <ID>
```

See [Testing Handlers via CLI](../workflows/handlers-cli-testing.md) for the full workflow.

## Summary

| Feature | `action()` | `handler()` |
|---------|------------|-------------|
| Defined | Inside pattern | Module scope |
| State access | Closure | Explicit binding |
| Reusable with different state | No | Yes |
| Returns Stream | Yes | Yes |
| Simpler syntax | Yes | No |

Both `action()` and `handler()` return `Stream<T>` and can be exported in the Output type. **Default to `action()`** - only use `handler()` when you need to reuse the same logic with different state bindings.
