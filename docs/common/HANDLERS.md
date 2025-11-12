# CommonTools Handler Patterns Guide

## Inline Handlers (Preferred for Simple Cases)

**New in CommonTools**: You can now write event handlers directly inline without the `handler()` wrapper!

```typescript
interface Input {
  count: Cell<number>;
  title: Cell<string>;
}

export default recipe<Input>(({ count, title }) => {
  return {
    [UI]: (
      <div>
        {/* Simple click handler */}
        <ct-button onClick={() => count.set(count.get() + 1)}>
          Increment
        </ct-button>

        {/* Handler with event */}
        <ct-input
          value={title}
          onct-input={(e) => title.set(e.detail.value)}
        />

        {/* Multi-line handler */}
        <ct-button onClick={() => {
          const current = count.get();
          if (current < 10) {
            count.set(current + 1);
          }
        }}>
          Increment (max 10)
        </ct-button>
      </div>
    ),
  };
});
```

**Key points:**
- Declare cells as `Cell<T>` in your recipe input types
- Write arrow functions directly: `onClick={() => ...}` or `onClick={(e) => ...}`
- No `handler()` wrapper needed for simple cases
- Can still use `handler()` for complex/reusable logic

## When Do You Need Handlers?

**Important:** Many UI updates don't need handlers at all! CommonTools components support **bidirectional binding** with the `$` prefix, which automatically updates cells when users interact with components.

### Quick Decision Guide

| Task | Solution | Example |
|------|----------|---------|
| Update checkbox | ✅ Bidirectional binding | `<ct-checkbox $checked={item.done} />` |
| Update text input | ✅ Bidirectional binding | `<ct-input $value={item.title} />` |
| Update dropdown | ✅ Bidirectional binding | `<ct-select $value={item.category} items={...} />` |
| Add item to list | ✅ Inline handler | `onClick={() => items.push({ title: "New" })}` |
| Remove item from list | ✅ Inline handler | `onClick={() => items.set(items.get().filter(i => i !== item))}` |
| Simple counter | ✅ Inline handler | `onClick={() => count.set(count.get() + 1)}` |
| Validate input | ✅ Inline handler or computed | Inline handler or `computed()` |
| Call API on change | ✅ Inline handler or `handler()` | For complex logic, use `handler()` |
| Complex reusable logic | ✅ `handler()` function | Module-level `handler()` |

**Rule of thumb:**
1. **Bidirectional binding** for simple UI ↔ cell sync (no logic needed)
2. **Inline handlers** for simple one-off operations
3. **`handler()` function** for complex or reusable logic

See `COMPONENTS.md` for detailed bidirectional binding examples.

## Handler Function Structure

**Note:** This section describes the `handler()` function for complex/reusable handlers. For simple cases, prefer inline handlers (see above).

Handlers in CommonTools follow a specific pattern that creates a factory function:

```typescript
type EventSchema = ...
type StateSchema = ...
const myHandler = handler<EventSchema, StateSchema>(handlerFunction);
```

### Handler Factory Calling Pattern

**Important:** Handler factories are called with a **single object** containing all the context they need. This is partial application of the state.

```typescript
// ✅ CORRECT - Single object with all context
const removeItem = handler(
  (_event, { items, item }: { items: Cell<Item[]>; item: Cell<Item> }) => {
    const currentItems = items.get();
    const index = currentItems.findIndex((el) => item.equals(el as any));
    if (index >= 0) {
      items.set(currentItems.toSpliced(index, 1));
    }
  }
);

// Called with single context object
<ct-button onClick={removeItem({ items, item })}>Remove</ct-button>

// ❌ INCORRECT - Multiple parameters
<ct-button onClick={removeItem({ items }, { item })}>Remove</ct-button>
```

The handler receives the event from the UI as the first parameter, and your bound state as the second parameter. This allows you to merge discrete UI events with reactive cells that are always changing.

## Common Handler Patterns

### 1. Simple Click Handler (No Event Data)

```typescript
const increment = handler<Record<string, never>, { count: Cell<number> }>(
  (_event, { count }) => {
    count.set(count.get() + 1);
  }
);

// Usage in UI
<ct-button onClick={increment({ count: myCount })}>
  +1
</ct-button>
```

### 2. Event Data Handler (Form Input, etc.)

```typescript
const updateTitle = handler<
  { detail: { value: string } }, 
  { title: Cell<string> }
>(
  ({ detail }, { title }) => {
    title.set(detail.value);
  }
);

// Usage in UI
<ct-input
  value={title}
  onct-input={updateTitle({ title })}
/>

// OR, bind directly to cell (see component docs for when this is available)

<ct-input $value={title} />
```

## Common TypeScript Issues & Fixes

### Handler Function Parameters

- **First parameter**: Event data (from UI interactions)
- **Second parameter**: State data (destructured from state schema)
- **Parameter naming**: Use descriptive names or `_` prefix for unused parameters

Notice how handlers are bound to the cell from the input schema _in_ the VDOM declaration? That's partial application of the state, the rest of the state (the actual event) comes through as `e` in the handler. This way you can merge the discrete updates from events with the reactive cells that are always changing values.

### Handler Parameter Type Patterns

Understanding when to use `Cell<T[]>` vs `Cell<Array<Cell<T>>>` is crucial for avoiding type errors. **The simple rule: always use `Cell<T[]>` in handler parameters.**

## Critical Rule: Cell<T[]> for Arrays

In handler type signatures, the Cell wraps the **entire array**, not individual elements:

```typescript
// ✅ CORRECT - Cell wraps the entire array
const addItem = handler<
  unknown,
  { items: Cell<ShoppingItem[]> }  // ← Cell<ShoppingItem[]>
>((_event, { items }) => {
  const currentItems = items.get();  // Returns ShoppingItem[]
  items.set([...currentItems, { title: "New", done: false }]);
});

// ✅ CORRECT - Nested cell types to access cell methods in sub-items
const removeItem = handler<
  unknown,
  { items: Cell<Array<Cell<ShoppingItem>>>, item: Cell<ShoppingItem> }
>(
  const currentItems = items.get();
  // Calls Cell.equals on the individual cell in the list:
  const index = currentItems.findIndex((el) => el.equals(item));
  if (index !== -1) {
    items.set(currentItems.toSpliced(index, 1));
  }
);

// ❌ WRONG - Don't use OpaqueRef in handler parameters
const addItem = handler<
  unknown,
  { items: Cell<OpaqueRef<ShoppingItem>[]> }  // ← Wrong!
>(/* ... */);
```

## Understanding the Type Contexts

There are **four different contexts** where array types appear differently:

```typescript
interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
}

// Context 1: In recipe input/output types
interface Input {
  items: Default<ShoppingItem[], []>;  // Plain type in schema
}

// Context 2: In handler parameters - Cell<ShoppingItem[]>
const addItem = handler<
  unknown,
  { items: Cell<ShoppingItem[]> }
>((_event, { items }) => {
  items.push({ title: "New", done: false });
});

export default recipe<Input, Input>(
  "Shopping List",
  ({ items }) => {  // Context 3: items is OpaqueRef<ShoppingItem[]>

    return {
      [UI]: (
        <div>
          {/* Context 4: In .map() - item is OpaqueRef<ShoppingItem> */}
          {items.map((item) => (
            <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
          ))}
          <ct-button onClick={addItem({ items })}>Add</ct-button>
        </div>
      ),
      items,  // Context 2 again: OpaqueRef<ShoppingItem[]>
    };
  },
);
```

## Mental Model: The Box Analogy

Think of types this way:

| Type | Mental Model | Where Used | Example |
|------|--------------|------------|---------|
| `Cell<T[]>` | A **box** containing an array | Handler params, sometimes lift params, returns | `items: Cell<ShoppingItem[]>` |
| `T[]` | The **plain array** inside the box | Result of `.get()` | `const arr = items.get()` returns `ShoppingItem[]` |
| `OpaqueRef<T>` | A **cell-like reference** to each item | Recipe params, in `.map()` | `items.map((item) => ...)` |
| `T` | A **plain object** | Inside plain arrays | `{ title: "Milk", done: false }` |

### How They Transform

```typescript
const items: Cell<ShoppingItem[]>  // Handler receives this

// Open the box with .get()
const plainArray: ShoppingItem[] = items.get();

// In recipe, arguments, cells and map parameters are OpaqueRef<>
{items.map((item) => (
  // item's type is automatically inferred as OpaqueRef<ShoppingItem>
  <ct-checkbox $checked={item.done} />
))}
```

## Why This Matters

**Different contexts require different types:**

1. **Handler parameters need `Cell<T[]>`** - so you can call `.get()` and `.set()`
2. **JSX .map() has `OpaqueRef<T>`** - for bidirectional binding to work (automatically inferred!)
3. **Recipe schemas use plain `T[]`** - to define the data structure

**Common mistake:**

```typescript
// ❌ WRONG - Trying to use JSX type in handler
const addItem = handler<
  unknown,
  { items: Cell<OpaqueRef<ShoppingItem>[]> }  // Wrong!
>(/* ... */);

// ✅ CORRECT - Handler uses Cell<T[]>
const addItem = handler<
  unknown,
  { items: Cell<ShoppingItem[]> }  // Correct!
>(/* ... */);
```

## Complete Example with All Contexts

```typescript
/// <cts-enable />
interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
}

// Schema uses plain types
interface Input {
  items: Default<ShoppingItem[], []>;
}

// Handler parameter: Cell<T[]>
const addItem = handler<
  { detail: { message: string } },
  { items: Cell<ShoppingItem[]> }  // ← Cell<ShoppingItem[]>
>(({ detail }, { items }) => {
  const message = detail?.message?.trim();
  if (!message) return;

  // Prefer .push() to add items to ShoppingItem[]
  items.push({ title: message, done: false });
});

const removeItem = handler<
  unknown,
  { items: Cell<Array<Cell<ShoppingItem>>>; item: Cell<ShoppingItem> }
>((_event, { items, item }) => {
  const currentItems = items.get();
  const index = currentItems.findIndex((el) => el.equals(item));
  if (index >= 0) {
    items.set(currentItems.toSpliced(index, 1));
  }
});

export default recipe<Input, Input>(({ items }) => {
  // items here is OpaqueRef<ShoppingItem[]>

  return {
    [UI]: (
      <div>
        {/* Also in .map(), inferred as OpaqueRef<ShoppingItem> */}
        {items.map((item) => (
          <div>
            <ct-checkbox $checked={item.done}>
              {item.title}
            </ct-checkbox>
            <ct-button onClick={removeItem({ items, item })}>×</ct-button>
          </div>
        ))}
        <ct-message-input onct-send={addItem({ items })} />
      </div>
    ),
    items,  // Return OpaqueRef<ShoppingItem[]>
  };
});
```

## Quick Reference

**When writing handler type signatures:**

- ✅ DO: `{ items: Cell<ShoppingItem[]> }`
- ✅ DO: `{ items: Cell<Array<Cell<ShoppingItem>>> }`
- ✅ DO: `{ items: ShoppingItem[] }` (for read-only uses)
- ❌ DON'T: `{ items: Cell<OpaqueRef<ShoppingItem>[]> }`

**Rule of thumb:** In handler type signatures, use `Cell<T[]>` for array parameters. The Cell wraps the entire array, not individual elements.

### Event Parameter Patterns

You can handle the event parameter in different ways depending on your needs:

```typescript
// Option 1: Destructure specific event properties (most common)
const updateTitle = handler<
  { detail: { value: string } }, 
  { title: Cell<string> }
>(
  ({ detail }, { title }) => {
    title.set(detail.value);
  }
);

// Option 2: Use full event object when you need multiple properties
const handleComplexEvent = handler<
  { detail: { value: string } }, 
  { data: Cell<any> }
>(
  (e, { data }) => {
    data.set({ value: e.detail.value });
  }
);

// Option 3: Use underscore when event data isn't needed
const simpleIncrement = handler<Record<string, never>, { count: Cell<number> }>(
  (_, { count }) => {
    count.set(count.get() + 1);
  }
);
```

## Handler Invocation Patterns

### State Passing

When invoking handlers in UI, pass an object that matches your state schema:

```typescript
// Handler definition state schema
{
  items: any[],
  currentPage: string
}

// Handler invocation - must match state schema
onClick={myHandler({ items: itemsArray, currentPage: currentPageString })}
```

### Event vs Props Confusion

- **Event type**: Describes data coming FROM the UI event
- **State type**: Describes data the handler needs to ACCESS
- **Invocation object**: Must match the state type, NOT the event type

## Debugging Handler Issues

### Type Mismatches

1. Check that handler invocation object matches state type
2. Verify event type matches actual UI event structure
3. Ensure destructuring in handler function matches types

### Runtime Issues

1. Use `console.log` in handler functions to debug
2. Check that state objects have expected properties
3. Verify UI events are firing correctly

## Best Practices

1. **Use meaningful parameter names**: `(formData, { items, title })` not `(event, state)`
2. **Keep event types minimal**: Often `Record<string, never>` for simple clicks
3. **Make state types explicit**: Always define the exact properties needed
4. **Match invocation to state type**: The object passed to handler() should match state type exactly
5. **Prefer descriptive handler names**: `updateItemTitle` not `handleUpdate`

## Examples by Use Case

### Counter/Simple State

```typescript
const increment = handler<Record<string, never>, { count: Cell<number> }>(
  (_, { count }) => count.set(count.get() + 1)
);
```

### Form/Input Updates

```typescript
const updateField = handler<
  { detail: { value: string } }, 
  { fieldValue: Cell<string> }
>(
  ({ detail }, { fieldValue }) => fieldValue.set(detail.value)
);
```

### List/Array Operations

```typescript
const addItem = handler<
  { message: string }, 
  { items: Cell<Array<{ title: string, done: boolean }>> }
>(
  ({ message }, { items }) => 
    items.push({ title: message, done: false })
);
```

### Complex State Updates

```typescript
const updatePageContent = handler<
  { detail: { value: string } }, 
  { pages: Cell<Record<string, string>>, currentPage: string }
>(
  ({ detail }, { pages, currentPage }) => {
    pages.key(currentPage).set(detail.value);
  }
);
```

## Advanced Patterns

### Handler Composition

```typescript
// Base handlers for reuse
const createTimestamp = () => Date.now();

const addItemWithTimestamp = handler<
  { title: string }, 
  { items: Cell<Array<{ title: string, done: boolean, createdAt: string }>> }
>(
  ({ title }, { items }) => {
    items.push({
      title,
      done: false,
      createdAt: createTimestamp()
    });
  }
);
```

### Storing Pattern Instances in Cell Arrays

**⚠️ CRITICAL:** When storing pattern instances (recipes) in a `Cell` array, you must use a `lift` function to perform the `.push()` operation. Calling `.push()` directly in a handler will cause a stack overflow.

This pattern is commonly used to create "charm lists" or "pattern collections" (like a list of chat instances).

#### ❌ WRONG - Stack Overflow

```typescript
import { handler, Cell, ID } from "commontools";

type Entry = {
  [ID]: string;
  local_id: string;
  charm: any;
};

// ❌ This will cause: RangeError: Maximum call stack size exceeded
const createPattern = handler<
  unknown,
  { patternsList: Cell<Entry[]> }
>(
  (_, { patternsList }) => {
    const pattern = MyPattern({ title: "New" });

    // ❌ WRONG: Direct .push() in handler causes stack overflow
    patternsList.push({
      [ID]: randomId,
      local_id: randomId,
      charm: pattern
    });
  }
);
```

#### ✅ CORRECT - Use lift()

```typescript
import { handler, Cell, ID, lift, toSchema, cell, OpaqueRef } from "commontools";

type Entry = {
  [ID]: string;
  local_id: string;
  charm: any;
};

// ✅ CORRECT: Wrap the push operation in a lift function
const storePattern = lift<{
  charm: any;
  patternsList: Cell<Entry[]>;
  isInitialized: Cell<boolean>;
}, undefined>(
  ({ charm, patternsList, isInitialized }) => {
    if (!isInitialized.get()) {
      // ✅ CORRECT: .push() happens inside lift, not handler
      patternsList.push({
        // Note: Using a stable ID here - in real code use proper ID generation
        local_id: `pattern-${Date.now()}`,
        charm
      });
      isInitialized.set(true);
    }
  }
);

// Handler returns the lift call instead of pushing directly
const createPattern = handler<
  unknown,
  { patternsList: Cell<Entry[]> }
>(
  (_, { patternsList }) => {
    const isInitialized = cell(false);
    const pattern = MyPattern({ title: "New" });

    // ✅ CORRECT: Return the lift function call (no casting needed with modern types)
    return storePattern({
      charm: pattern,
      patternsList,
      isInitialized
    });
  }
);
```

**Why this matters:** The pattern instance storage workflow requires coordination between the handler (which creates the instance) and the lift (which stores it). This separation prevents the recursion detector in `recursivelyAddIDIfNeeded()` from encountering circular references.

**Reference:** See `packages/patterns/chatbot-list-view.tsx` for the canonical implementation of this pattern, particularly the `storeCharm` lift function and `createChatRecipe` handler.

#### Improving Event Typing

While `Record<string, never>` works for simple handlers that don't use event data, better event typing improves development experience and catches errors:

```typescript
// Better: Define specific event interfaces when you need event data
interface ClickEvent {
  target: HTMLElement;
  shiftKey?: boolean;
  metaKey?: boolean;
}

interface CustomEvent<T = any> {
  detail: T;
  target: HTMLElement;
}

// Use specific types for better IntelliSense and error catching
const handleItemClick = handler<
  ClickEvent,
  { items: Cell<Array<{ id: string, done: boolean }>> }
>(
  ({ target, shiftKey }, { items }) => {
    const itemId = target.getAttribute('data-item-id');
    if (itemId) {
      // Type-safe access to event properties
      const shouldSelectMultiple = shiftKey;
      // ... handler logic
    }
  }
);

// For custom events with specific detail shapes
const handleFormSubmit = handler<
  CustomEvent<{ formData: Record<string, string> }>,
  { submissions: Cell<any[]> }
>(
  ({ detail }, { submissions }) => {
    // detail.formData is properly typed
    submissions.push(detail.formData);
  }
);
```

## Common Pitfalls

### 1. Type Mismatch

```typescript
// ❌ Wrong: State type doesn't match invocation
const handler = handler<Record<string, never>, { count: number }>(
  (_, { count }) => { ... }
);

// Invocation passes wrong shape
onClick={handler({ value: 5 })} // Should be { count: 5 }
```

### 2. Event Type Over-specification

```typescript
// ❌ Wrong: Over-complicated event type for simple clicks
const handler = handler<{
  target: object,
  currentTarget: object
}, any>(
  (ev, state) => { ... }
);

// ✅ Better: Simple clicks rarely need event data
const handler = handler<Record<string, never>, any>(
  (_, state) => { ... }
);
```

### 3. Mutation vs Immutability

```typescript
// ❌ Wrong: Direct assignment to non-cell state
(_, { title }) => {
  title = newValue; // This won't work
}

// ✅ Right: Use cell methods for reactive state
(_, { title }) => {
  title.set(newValue); // For cells
}

// ✅ Right: Mutate arrays/objects directly for non-cell state
(_, { items }) => {
  items.push(newItem); // For regular arrays
}
```

## Debugging Handlers

### Console-based Debugging

```typescript
// In recipes, use console logging for debugging
const addItem = handler<
  { detail: { value: string } }, 
  { items: Cell<any[]> }
>(
  ({ detail }, { items }) => {
    console.log("Adding item:", detail.value);
    console.log("Current items:", items.get());
    items.push({ title: detail.value, done: false });
    console.log("Updated items:", items.get());
  }
);
```
