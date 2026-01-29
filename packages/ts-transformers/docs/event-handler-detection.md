# Event Handler Detection Logic

## Summary

Detects whether a JSX attribute is an event handler using two strategies:

1. **Name-based** (fast path): Attribute starts with `on` (e.g., `onClick`,
   `onSubmit`)
2. **Type-based**: Function with 0-1 parameters returning void, boolean, or
   Promise<void|boolean>

## The Heuristic

```
Handler = function with <= 1 parameter
          AND returns void | undefined | boolean | Promise<void|boolean>
```

### Why These Criteria?

**Arity (0-1 params):**

- 0 params: `callback: () => void` - simple notification
- 1 param: `onClick: (e: Event) => void` - standard event handler

In Common Tools, the `handler()` function wraps 2-param callbacks
`(event, state) => ...` and produces 0-param functions for JSX. So JSX event
handlers themselves never need more than 1 parameter.

**Return type:**

- `void`/`undefined`: Classic handler, no return value needed
- `boolean`: Common for "handled" signaling (prevent default, stop propagation)
- `Promise<...>`: Async versions of the above

### What Gets Excluded

Data transformers that return values the component uses:

- `renderItem: (item: T) => ReactNode` - returns renderable content
- `keyExtractor: (item: T) => string` - returns key for list items
- `formatter: (value: number) => string` - returns formatted string
- `reducer: (acc, item, idx) => acc` - 3 params, data aggregation

## Known Limitations

### False Positives (incorrectly detected as handler)

| Pattern                                 | Why Detected             | Actual Use            |
| --------------------------------------- | ------------------------ | --------------------- |
| `filter: (item: T) => boolean`          | 1 param, returns boolean | Data filter predicate |
| `predicate: (x: T) => boolean`          | 1 param, returns boolean | Condition check       |
| `validator: (value: string) => boolean` | 1 param, returns boolean | Validation logic      |

These are rare as JSX props but could cause unnecessary wrapping if encountered.

### False Negatives (real handlers missed)

| Pattern                          | Why Missed | Notes                                 |
| -------------------------------- | ---------- | ------------------------------------- |
| `onComplexEvent: (a, b) => void` | 2+ params  | Rare; use `handler()` wrapper instead |

### Edge Cases

- Union types with mixed signatures: Uses first matching signature
- Overloaded functions: Any signature matching = handler
- Generic handlers: Works if contextual type resolves

## Alternatives Considered

1. **Void-only return**: Original implementation. Too strict—misses
   `() => boolean` handlers.

2. **Arity-only**: Would incorrectly capture `renderItem: (item) => Node`.

3. **Higher arity (0-2 params)**: Considered but unnecessary for Common Tools
   where `handler()` abstracts multi-param callbacks.

4. **Name-based exclusion list**: Could add `filter`, `predicate`, `validator`
   as exclusions. Adds complexity; not worth it unless false positives become a
   real problem.

## Testing

See `test/ast/event-handlers.test.ts` for test cases covering:

- Void, boolean, Promise<void>, Promise<boolean> returns
- 0, 1, 2, and 3 parameter functions
- Name-based vs type-based detection
- Non-function props
