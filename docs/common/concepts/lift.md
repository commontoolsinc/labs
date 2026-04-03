`lift()` is a foundational operation used to implement others built-in functions like `computed()`, `handler()` and `pattern()`.

This is lift in the sense of [lifted functions](https://en.wikipedia.org/wiki/Lift_(mathematics))

```tsx
import { lift, Writable, pattern } from 'commontools'

// Lifted functions will automatically be reactively re-computed based on their inputs
const addCells = lift(({ a, b }: { a: number, b: number }) => {
  return a + b
})

interface Props {
  a: Writable<number>;
  b: Writable<number>;
}

export default pattern<Props, { combined: number }>(({ 
  a, b,
}) => {
  return {
    combined: addCells({ a, b })
  }
})
```

Typically it's unusual to use `lift()` directly. It is almost always better to use `computed()`. Use `lift()` when declaring a re-usable computed function that you want to use in multiple patterns or call multiple times in the same pattern.

## Module Scope Requirement

Like `handler()`, the pattern transformer requires that `lift()` be defined **outside** the pattern body (at module scope) if you need to use it at all:

```typescript
// CORRECT - define at module scope
const getByDate = lift((args: { grouped: Record<string, Item[]>; date: string }) =>
  args.grouped[args.date]
);

// Then use inside pattern:
const result = getByDate({ grouped, date });

// WRONG - lift defined and immediately invoked inside pattern
const result = lift((args) => args.grouped[args.date])({ grouped, date });

// BETTER - use computed() instead of lift for inline use
const result = computed(() => grouped[date]);
```

**Why:** The CTS transformer processes patterns at compile time and cannot handle closures over pattern-scoped variables in lifted functions.
