# Testing Mounted Callables via CLI

Export handlers and tools in your pattern's return object to test them via CLI
before building UI.

## Why Export Handlers?

During development, CLI testing lets you verify callable logic without touching
the browser:
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
deno task ct piece new ... pattern.tsx
deno task ct piece setsrc ... pattern.tsx

# Call a handler directly with JSON payload
deno task ct piece call ... addItem '{"title": "Test Item", "category": "demo"}'

# Run a step to process the handler
deno task ct piece step ...

# Verify state changed
deno task ct piece inspect ...

# Or mount the space and execute the mounted callable file
deno task ct fuse mount /tmp/ct ...
head -n1 /tmp/ct/<space>/pieces/<piece>/result/addItem.handler
deno task ct exec /tmp/ct/<space>/pieces/<piece>/result/addItem.handler --title "Test Item"

# Mounted tools surface as .tool files and run through ct exec
head -n1 /tmp/ct/<space>/pieces/<piece>/result/search.tool
deno task ct exec /tmp/ct/<space>/pieces/<piece>/result/search.tool --query "demo"
```

## Workflow

1. Deploy pattern: `ct piece new`
2. Either call the handler directly with `ct piece call` or mount the space with `ct fuse mount`
3. Use `ct exec <mounted-callable-file> --help` to inspect the mounted schema-derived interface
4. Execute `*.handler` or `*.tool` via `ct exec`; legacy `echo ... > file.handler` still works for handlers
5. Inspect state with `ct piece inspect` or `ct piece get`
6. Iterate until the callable works correctly, then build UI on top
