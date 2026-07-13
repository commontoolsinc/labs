# Reusable Handlers

Use `handler()` when you need to define event-handling logic once and bind it to different state at multiple call sites. **Default to [`action()`](./action.md)** — see that doc for the full decision guide.

## When to Use `handler()`

1. **Same logic, different state** - You want to reuse identical handler logic with different state
2. **Exported streams** - Other patterns need to call your handler via linking
3. **CLI testing** - You want to test handlers via `cf piece call` before building UI

## Basic Structure

```typescript
// Shown at module scope.
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
  const counterA = new Writable(0);
  const counterB = new Writable(100);

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
// Shown for illustration only.
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

Handlers exposed in Output interfaces must be typed as `Stream<T>` — a
write-only channel that other pieces can trigger via `.send()` when linked.
Don't try to create streams directly: a bound handler **is** a
`Stream<EventType>`. Binding state to a module-scope handler produces the
stream, which you export in the return object:

```tsx
// Shown for illustration only.
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

## Event Data and Void Handlers

The first type parameter is the event payload passed to `.send()`; use `void`
when the handler needs no event data:

```typescript
// Shown inside a pattern body.
// With event data
addItem({ items }).send({ title: "My Item" });

// Void handler - call .send() without arguments
const clearAll = handler<void, { items: Writable<Item[]> }>(
  (_, { items }) => items.set([])
);
clearAll({ items }).send();
```

## Unavailable Bound Inputs

A handler bound to plain reactive values waits when a captured input is
temporarily unavailable. For `pending` and `syncing`, the original event stays
at the head of the global FIFO queue; the handler body, event receipt, and
`onCommit` callback do not run. When a captured dependency changes, the same
event is checked again and dispatches once its inputs are usable.

Terminal `error` and `schema-mismatch` inputs do not park the queue: they pass
through ordinary argument validation, suppress the handler as an invalid
invocation, and settle that event as a no-op. A malformed event payload follows
the same settle-and-continue rule because queued immutable data cannot become
valid later.

An input-parked queue is considered scheduler-quiescent, so `runtime.idle()`
can resolve while the handler waits. This is required for fetch and generation
producers which await idle before publishing the value that wakes the event.
When event-preflight telemetry is enabled, a parked preflight marker includes
the unavailable reason and current queue depth.

Binding a `Writable<T>` or other Cell capability is intentionally different.
The handle itself is a usable capability, so the scheduler does not gate the
handler on the pointed-to value. Read it in the handler with `.get()` and allow
for its current value to be unavailable if the handler's contract needs that
state. Bind a plain `T` when dispatch itself must wait for usable data.

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

**Default to `action()`** — only use `handler()` when you need to reuse the same logic with different state bindings or export it for other patterns. See [Handling Events](./action.md) for the decision table.
