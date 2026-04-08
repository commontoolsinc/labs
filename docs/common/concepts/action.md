# Handling Events

Use `action()` to handle user events like button clicks, form submissions, and other interactions. Actions close over variables in your pattern, making them simple to write and easy to understand.

## Basic Usage

```tsx
import { action, pattern, Writable, UI } from 'commonfabric';

export default pattern(() => {
  const count = Writable.of(0);

  // action() closes over `count` - no binding needed
  const increment = action(() => {
    count.set(count.get() + 1);
  });

  const decrement = action(() => {
    count.set(count.get() - 1);
  });

  return {
    [UI]: (
      <div>
        <div>Count: {count}</div>
        <cf-button onClick={decrement}>-</cf-button>
        <cf-button onClick={increment}>+</cf-button>
      </div>
    ),
  };
});
```

Actions are defined inside your pattern body and naturally close over any cells or state you need to modify. This is the most common and straightforward way to handle events.

## Actions with Event Data

When you need data from the event (like form input), the action receives it as a parameter:

```tsx
const items = Writable.of<string[]>([]);

const addItem = action((event: { title: string }) => {
  items.push(event.title);
});

// In JSX - pass data when calling
<cf-button onClick={() => addItem.send({ title: "New Item" })}>
  Add Item
</cf-button>
```

## Multiple Operations in One Action

Actions can perform multiple mutations in a single handler:

```tsx
const resetGame = action(() => {
  score.set(0);
  lives.set(3);
  level.set(1);
  gameState.set("ready");
});
```

## SES Notes

Actions are still the default place for event-driven mutations, timestamps, and
one-off IDs.

- Keep action bodies simple and straight-line. Prefer `const` plus direct cell
  operations over `let`, `var`, reassignment, or loops.
- If the logic starts becoming imperative, move the heavy lifting into
  `computed()`, `derive()`, or a module-scope helper and keep the action as the
  trigger.
- Use `safeDateNow()` and `nonPrivateRandom()` instead of `Date.now()` and
  `Math.random()` in authored pattern code.
- Prefer capturing time/random snapshots in the action itself rather than
  inside a `computed()` that may re-run many times.

## When to Use `handler()` Instead

Use `action()` for most cases. Switch to `handler()` when you need to:

1. **Reuse the same logic with different state bindings**
2. **Export the handler for other patterns to call via linking**

```tsx
// If you need the SAME logic bound to DIFFERENT state:
const increment = handler<void, { count: Writable<number> }>(
  (_, { count }) => count.set(count.get() + 1)
);

// Now you can bind it to different counters
const incrementA = increment({ count: counterA });
const incrementB = increment({ count: counterB });
```

See [Reusable Handlers](./handler.md) for the full `handler()` API.

## Inline Arrow Functions

For very simple one-liners, you can use arrow functions directly in JSX:

```tsx
<cf-button onClick={() => count.set(count.get() + 1)}>+</cf-button>
```

However, `action()` is preferred for:
- Multiple statements
- Better readability
- Giving the action a descriptive name
- Reusing the same action in multiple places

## Summary

| Approach | Use When |
|----------|----------|
| `action()` | Default choice - closes over pattern state |
| Arrow function | Simple one-liners in JSX |
| `handler()` | Reusable logic with different state bindings |
