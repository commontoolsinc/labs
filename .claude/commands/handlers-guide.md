# CommonTools Handler Patterns Guide

## Handler Function Structure

Handlers in CommonTools follow a specific three-parameter pattern:

```typescript
const myHandler = handler(
  eventSchema,   // What data comes from UI events
  stateSchema,   // What data the handler needs to operate on
  handlerFunction // The actual function that executes
);
```

## Common Handler Patterns

### 1. Simple Click Handler (No Event Data)

```typescript
const increment = handler(
  Record<PropertyKey, never>,  // No event data needed
  {
    type: "object",
    properties: {
      count: { type: "number" }
    }
  },
  (_event, { count }) => {
    count.set(count.get() + 1);
  }
);

// Usage in UI
<button onClick={increment({ count: myCount })}>
  +1
</button>
```

### 2. Event Data Handler (Form Input, etc.)

```typescript
const updateTitle = handler(
  {
    type: "object",
    properties: {
      detail: {
        type: "object", 
        properties: { value: { type: "string" } }
      }
    }
  },
  {
    type: "object",
    properties: {
      title: { type: "string" }
    }
  },
  ({ detail }, { title }) => {
    title.set(detail.value);
  }
);

// Usage in UI
<ct-input 
  value={title} 
  onct-input={updateTitle({ title })}
/>
```

## Common TypeScript Issues & Fixes

### Empty Object Types
❌ **Don't use**: `{}`
✅ **Use instead**: `Record<PropertyKey, never>`

### Empty Parameter Destructuring
❌ **Don't use**: `({}, state) =>`
✅ **Use instead**: `(_event, state) =>` or `(_props, state) =>`

### Handler Function Parameters
- **First parameter**: Event data (from UI interactions)
- **Second parameter**: State data (destructured from state schema)
- **Parameter naming**: Use descriptive names or `_` prefix for unused parameters

## Handler Invocation Patterns

### State Passing
When invoking handlers in UI, pass an object that matches your state schema:

```typescript
// Handler definition state schema
{
  type: "object",
  properties: {
    items: { type: "array" },
    currentPage: { type: "string" }
  }
}

// Handler invocation - must match state schema
onClick={myHandler({ items: itemsArray, currentPage: currentPageString })}
```

### Event vs Props Confusion
- **Event schema**: Describes data coming FROM the UI event
- **State schema**: Describes data the handler needs to ACCESS
- **Invocation object**: Must match the state schema, NOT the event schema

## Debugging Handler Issues

### Type Mismatches
1. Check that handler invocation object matches state schema
2. Verify event schema matches actual UI event structure
3. Ensure destructuring in handler function matches schemas

### Runtime Issues
1. Use `console.log` in handler functions to debug
2. Check that state objects have expected properties
3. Verify UI events are firing correctly

## Best Practices

1. **Use meaningful parameter names**: `(formData, { items, title })` not `(event, state)`
2. **Keep event schemas minimal**: Often `Record<PropertyKey, never>` for simple clicks
3. **Make state schemas explicit**: Always define the exact properties needed
4. **Match invocation to state schema**: The object passed to handler() should match state schema exactly
5. **Prefer descriptive handler names**: `updateItemTitle` not `handleUpdate`

## Examples by Use Case

### Counter/Simple State
```typescript
const increment = handler(
  Record<PropertyKey, never>,
  { count: { asCell: true, type: "number" } },
  (_, { count }) => count.set(count.get() + 1)
);
```

### Form/Input Updates
```typescript
const updateField = handler(
  { detail: { value: { type: "string" } } },
  { fieldValue: { type: "string" } },
  ({ detail }, { fieldValue }) => fieldValue.set(detail.value)
);
```

### List/Array Operations
```typescript
const addItem = handler(
  { message: { type: "string" } },
  { items: { type: "array", asCell: true } },
  ({ message }, { items }) => items.push({ title: message, done: false })
);
```

### Complex State Updates
```typescript
const updatePageContent = handler(
  { detail: { value: { type: "string" } } },
  { 
    pages: { type: "object" },
    currentPage: { type: "string" }
  },
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

const addItemWithTimestamp = handler(
  { title: { type: "string" } },
  { items: { type: "array", asCell: true } },
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
const toggleItem = handler(
  Record<PropertyKey, never>,
  { 
    item: { type: "object" },
    items: { type: "array", asCell: true }
  },
  (_, { item, items }) => {
    const index = items.findIndex(i => i.id === item.id);
    if (index !== -1) {
      items[index].done = !items[index].done;
    }
  }
);
```

## Common Pitfalls

### 1. Schema Mismatch
```typescript
// ❌ Wrong: State schema doesn't match invocation
const handler = handler(
  Record<PropertyKey, never>,
  { count: { type: "number" } },
  (_, { count }) => { ... }
);

// Invocation passes wrong shape
onClick={handler({ value: 5 })} // Should be { count: 5 }
```

### 2. Event Schema Over-specification
```typescript
// ❌ Wrong: Over-complicated event schema for simple clicks
const handler = handler(
  { 
    type: "object",
    properties: {
      target: { type: "object" },
      currentTarget: { type: "object" }
    }
  },
  // ... rest
);

// ✅ Better: Simple clicks rarely need event data
const handler = handler(
  Record<PropertyKey, never>,
  // ... rest
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