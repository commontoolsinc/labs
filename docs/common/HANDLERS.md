# CommonTools Handler Patterns Guide

## Handler Function Structure

Handlers in CommonTools follow a specific pattern that creates a factory function:

```typescript
const myHandler = handler(
  eventSchema,   // What data comes from UI events
  stateSchema,   // What data the handler needs to operate on
  handlerFunction // The actual function that executes
);

// or

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
    const index = currentItems.findIndex((el) => items.key(el).equals(item));
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

Understanding when to use `Cell<T[]>` vs `Cell<Array<Cell<T>>>` is crucial:

```typescript
// ✅ CORRECT - In handler parameters, use Cell<T[]> where T is the plain type
const addItem = handler(
  (_event, { items }: { items: Cell<ShoppingItem[]> }) => {
    const itemsArray = items.get(); // ShoppingItem[]
    itemsArray.push({ name: "New Item", checked: false });
  }
);

// When you call .get() on Cell<ShoppingItem[]>, you get ShoppingItem[]
// This is the plain array of plain objects

// When iterating in JSX, items are wrapped as OpaqueRef
{items.map((item: OpaqueRef<ShoppingItem>) => (
  // item is a cell-like reference here
  <ct-checkbox $checked={item.checked} />
))}

// ❌ AVOID - Don't use Cell<Array<Cell<T>>> in handler signatures
const addItem = handler(
  (_event, { items }: { items: Cell<Array<Cell<ShoppingItem>>> }) => {
    // This is confusing and usually wrong
  }
);
```

**Rule of thumb:** In handler type signatures, use `Cell<T[]>` for array parameters. The Cell wraps the entire array, not individual elements.

#### Event Parameter Patterns

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
  { detail: { value: string }, target: HTMLElement, timestamp: number }, 
  { data: Cell<any> }
>(
  (e, { data }) => {
    // Access multiple event properties
    console.log('Event timestamp:', e.timestamp);
    console.log('Target element:', e.target);
    data.set({ value: e.detail.value, element: e.target.tagName });
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
  { pages: Record<string, string>, currentPage: string }
>(
  ({ detail }, { pages, currentPage }) => {
    pages[currentPage] = detail.value;
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

### Conditional State Updates
```typescript
const toggleItem = handler<
  Record<string, never>, 
  { item: { id: string }, items: Cell<Array<{ id: string, done: boolean }>> }
>(
  (_, { item, items }) => {
    const index = items.get().findIndex(i => i.id === item.id);
    if (index !== -1) {
      items.get()[index].done = !items.get()[index].done;
    }
  }
);
```

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
  (ev, state) => { ... }
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
