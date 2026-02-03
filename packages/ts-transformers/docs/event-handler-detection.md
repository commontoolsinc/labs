# Event Handler Detection Logic

## Summary

Detects whether a JSX attribute is an event handler using two strategies:

1. **Name-based** (fast path): Attribute starts with `on` (e.g., `onClick`,
   `onSubmit`)
2. **Type-based**: Function with 0-1 parameters

## The Heuristic

```
Handler = function with 0 or 1 parameter
```

### Why This Criterion?

In Common Tools JSX, any function passed to an element is treated as an
action/handler. We don't need complex heuristics about return types because you
can't pass arbitrary data-transformer functions to elements - if you could,
they'd be patterns.

**Arity (0-1 params):**

- 0 params: `callback: () => void` - simple notification
- 1 param: `onClick: (e: Event) => void` - standard event handler

In Common Tools, the `handler()` function wraps 2-param callbacks
`(event, state) => ...` and produces 0-param functions for JSX. So JSX event
handlers themselves never need more than 1 parameter.

### What Gets Excluded

Functions with 2+ parameters:

- `twoParamHandler: (event, ctx) => void` - 2 params, not a handler
- `reducer: (acc, item, idx) => acc` - 3 params, data aggregation

## Known Limitations

### False Positives (incorrectly detected as handler)

| Pattern                        | Why Detected | Actual Use            |
| ------------------------------ | ------------ | --------------------- |
| `filter: (item: T) => boolean` | 1 param      | Data filter predicate |
| `mapper: (x: T) => Y`          | 1 param      | Data transformation   |

These could cause unnecessary wrapping if encountered, but in Common Tools JSX
any function is intended to be an action anyway.

### False Negatives (real handlers missed)

| Pattern                          | Why Missed | Notes                                 |
| -------------------------------- | ---------- | ------------------------------------- |
| `onComplexEvent: (a, b) => void` | 2+ params  | Rare; use `handler()` wrapper instead |

## Alternatives Considered

1. **Return type checking**: Original implementation checked for void/boolean
   returns. Removed because it's not necessary in Common Tools JSX where all
   functions are actions.

2. **Higher arity (0-2 params)**: Considered but unnecessary for Common Tools
   where `handler()` abstracts multi-param callbacks.

3. **Any function**: Simplest approach but would incorrectly capture 2+ param
   data transformers like reducers.

## Testing

See `test/ast/event-handlers.test.ts` for test cases covering:

- 0, 1, 2, and 3 parameter functions
- Name-based vs type-based detection
- Non-function props
