`handler` constructs a `Stream` that exposes `.send()` to trigger it. When binding in JSX, handlers 

```typescript
const myHandler = handler<EventType, StateType>((event, state) => { ... });
//                        ^^^^^^^^^  ^^^^^^^^^
//                        1st param  2nd param (passed at invocation)
```

**Type annotations are required** - without them, handler parameters become `any`.

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
