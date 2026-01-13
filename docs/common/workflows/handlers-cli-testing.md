# Testing Handlers via CLI

Export handlers in your pattern's return object to test them via CLI before building UI.

## Why Export Handlers?

During development, CLI testing lets you verify handler logic without touching the browser:
- Faster iteration cycle
- Easier to test edge cases with specific payloads
- Clear visibility into state changes

## Setup

1. Define handler event types in `schemas.tsx`:

```tsx
// schemas.tsx
import type { Stream } from "commontools";

export interface AddItemEvent {
  title: string;
  category?: string;
}

export interface Output {
  items: Item[];
  addItem: Stream<AddItemEvent>;  // Stream<T> for handler types
}
```

2. Export the bound handler in your pattern:

```tsx
// main.tsx
const addItem = handler<AddItemEvent, { items: Writable<Item[]> }>(
  (event, { items }) => {
    items.push({ title: event.title, category: event.category || "default" });
  }
);

export default pattern<Input, Output>(({ items }) => {
  return {
    [UI]: <div>...</div>,
    items,
    addItem: addItem({ items }),  // Export the bound handler
  };
});
```

## CLI Commands

```bash
# Deploy or update the pattern
deno task ct charm new ... pattern.tsx
deno task ct charm setsrc ... pattern.tsx

# Call a handler with JSON payload
deno task ct charm call ... addItem '{"title": "Test Item", "category": "demo"}'

# Run a step to process the handler
deno task ct charm step ...

# Verify state changed
deno task ct charm inspect ...
```

## Workflow

1. Deploy pattern: `ct charm new`
2. Call handler: `ct charm call ... handlerName '{...}'`
3. Step to process: `ct charm step ...`
4. Inspect state: `ct charm inspect ...`
5. Iterate until handler works correctly
6. Then build UI that uses the verified handler
