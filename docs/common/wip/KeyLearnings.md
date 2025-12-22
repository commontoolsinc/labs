# Key Learnings for Pattern Development

This document captures important learnings discovered during pattern development. These will be reviewed and edited for prompt engineering purposes.

---

## Getting Cell Access for Mutation

**Goal:** Mutate state from inline event handlers in JSX.

**Solution:** Declare `Cell<>` around the field in your Input interface. This gives you access to `.set()`, `.get()`, `.update()`, etc.

```typescript
// ✅ CORRECT: Declare Cell<> in Input to get mutation access
interface Input {
  count: Cell<Default<number, 0>>;  // Has .set(), .get(), .update()
}

export default recipe<Input, Output>(({ count }) => {
  return {
    [UI]: (
      <div>
        <div>{count}</div>
        {/* Inline mutation works! */}
        <ct-button onClick={() => count.set(count.get() + 1)}>
          +1
        </ct-button>
      </div>
    ),
    count,
  };
});
```

**Without Cell<>** - read-only (no mutation methods):

```typescript
// ❌ Without Cell<> wrapper - read-only
interface Input {
  count: Default<number, 0>;  // No .set(), .get() methods
}

// This will fail:
<ct-button onClick={() => count.set(count.get() + 1)}>  // ERROR!
```

**Error you'll see if you forget Cell<>:**
```
TypeError: count.set is not a function
```

**Key insight:** `Cell<>` in the Input interface indicates write intent. It tells the runtime to provide a Cell reference with mutation methods. Everything is reactive by default - `Cell<>` only signals that you'll call mutation methods like `.set()`, `.update()`, or `.push()`.

---

## Exposing Actions via Handlers (for Cross-Charm Calling)

**Goal:** Make a charm's actions callable by **other linked charms** (not just within the same charm).

**When to use `handler()` vs `Cell<>` in Input:**

| Need | Solution |
|------|----------|
| Mutate state within same charm | Declare `Cell<T>` in Input (see above) |
| Expose action for OTHER linked charms | Use `handler()` + return as Stream |

**Pattern for cross-charm actions:**
1. Define handlers at module level using `handler<EventType, StateType>()`
2. Return handlers bound to state in the recipe's return object
3. Cast to `Stream<T>` in the output interface

```typescript
import { Cell, Default, handler, NAME, recipe, Stream, UI } from "commontools";

interface Output {
  count: number;
  increment: Stream<void>;       // Action exposed as Stream
  decrement: Stream<void>;
  setCount: Stream<{ value: number }>;
}

// 1. Define handlers
const increment = handler<unknown, { count: Cell<number> }>(
  (_event, { count }) => {
    count.set(count.get() + 1);
  },
);

const setCount = handler<{ value: number }, { count: Cell<number> }>(
  (event, { count }) => {
    count.set(event?.value ?? 0);
  },
);

export default recipe<Input, Output>("Action Counter", ({ count }) => {
  return {
    [NAME]: "Action Counter",
    [UI]: (
      <div>
        <ct-button onClick={increment({ count })}>+1</ct-button>
      </div>
    ),
    count,
    // 2. Return handlers bound to state, cast to Stream
    increment: increment({ count }) as unknown as Stream<void>,
    setCount: setCount({ count }) as unknown as Stream<{ value: number }>,
  };
});
```

**Key insight:** Handlers become callable action streams when returned in the output. The `as unknown as Stream<T>` cast tells TypeScript that this bound handler will be used as a stream by consumers.

---

## Consuming Actions via Streams

**Goal:** Call actions exposed by a linked charm.

### Recommended: Whole Charm Linking (Declare Only What You Need)

Link the entire source charm to a single input field. In your type, **only declare the fields you actually use** - you don't need to mirror the entire source charm's interface.

```typescript
// Only declare what you need - not the full CounterCharm interface
interface LinkedCounter {
  count: number;              // Only if you need to display it
  increment: Stream<void>;    // Only the actions you'll call
  setCount: Stream<{ value: number }>;
}

interface Input {
  counter: Default<LinkedCounter | null, null>;
}

// Link with: ct charm link <counter-id> <this-id>/counter

// Usage in JSX - inline .send():
<ct-button onClick={() => counter.increment.send()}>+1</ct-button>
<ct-button onClick={() => counter.setCount.send({ value: 0 })}>Reset</ct-button>

// Can also read data:
<div>Count: {counter.count}</div>
```

**Advantages:**
- Single link gives access to data and actions
- Type documents your actual dependencies
- No need to maintain a full mirror of the source charm's interface

**Key insight:** `Stream<T>` types have only `.send()` - no `.get()` or `.set()`. They're write-only channels for triggering actions.

---
