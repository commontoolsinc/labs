# CommonTools Handler Patterns Guide

## Handler Function Structure

Handlers in CommonTools follow a specific three-parameter pattern:

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

## Testing Handlers

### Unit Testing Pattern
```typescript
// Test handler logic separately
const testState = { items: [], currentPage: "test" };
const testEvent = { detail: { value: "new content" } };

// Call handler function directly
handlerFunction(testEvent, testState);

// Assert expected changes
expect(testState.items).toHaveLength(1);
```

### Integration Testing
```typescript
// Test full handler including schemas
const handler = createHandler(...);
const testInvocation = { items: mockItems, currentPage: "test" };

// Test that handler can be invoked without errors
expect(() => handler(testInvocation)).not.toThrow();
```
