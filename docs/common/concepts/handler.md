`handler` constructs a `Stream` that exposes `.send()` to trigger it.

```typescript
import { pattern, UI, Stream, handler, Cell, Writable } from "commontools";

interface EventType {}
interface StateType {}

const myHandler = handler<EventType, StateType>((event, state) => {
  return;
});
//                        ^^^^^^^^^  ^^^^^^^^^
//                        1st param  2nd param (passed at invocation)
```

**Type annotations are required** - without them, handler parameters become `any`.

## Module Scope Requirement

The pattern transformer requires that `handler()` be defined **outside** the pattern body (at module scope). Only the *binding* (passing state) happens inside the pattern:

```typescript
// CORRECT - Define at module scope, bind inside pattern
const addItem = handler<{ title: string }, { items: Writable<Item[]> }>(
  ({ title }, { items }) => items.push({ title, done: false })
);

export default pattern<Input, Input>(({ items }) => ({
  [UI]: (
    <div>
      <ct-button onClick={addItem({ items })}>Add</ct-button>  {/* Bind here */}
    </div>
  ),
  items,
}));

// WRONG - Defined inside pattern body (will cause transformer error)
export default pattern<Input, Input>(({ items }) => {
  const addItem = handler(...);  // Error: handler() must be at module scope
  return { ... };
});
```

**Why:** The CTS transformer processes patterns at compile time and cannot handle closures over pattern-scoped variables in handlers.

```tsx
import { pattern, UI, Stream, handler, Cell, Writable } from "commontools";

interface Input { 
  items: Array<{ title: string, done: boolean }>;
}

interface Output {
  addItem: Stream<{ title: string }>;
}

// The first parameter is the event payload, the second is the pre-bound context 
const addItem = handler(({ title }: { title: string }, { items }: { items: Writable<Array<{ title: string, done: boolean }>> }) => {
  items.push({ title, done: false });
});

// Sometimes, we do not care about the event payload
const addHardCodedItem = handler((_, { items }: { items: Writable<Array<{ title: string, done: boolean }>> }) => {
  items.push({ title: "Hard Coded Item", done: false });
});

export default pattern<Input, Output>(({ items }) => {
  return {
    [UI]: <div>
      <button onClick={() => addItem({ items }).send({title: "Test Item"})}>Add Test Item (uses event)</button>
      <button onClick={addHardCodedItem({ items })}>Add Test Item (ignores event)</button>
    </div>,
    // The context for a handler is pre-bound before export
    addItem: addItem({ items })
  }
});
```
