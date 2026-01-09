`lift()` is a foundational operation used to implement others built-in functions like `computed()`, `handler()` and `pattern()`.

This is lift in the sense of [lifted functions](https://en.wikipedia.org/wiki/Lift_(mathematics))

```tsx
import { lift, Cell, pattern } from 'commontools'

// Lifted functions will automatically be reactively re-computed based on their inputs
const addCells = lift(({ a, b }: { a: Cell<number>, b: Cell<number> }) => {
  return a.get() + b.get()
})

interface Props {
  a: Cell<number>;
  b: Cell<number>;
}

export default pattern<Props, { combined: number }>(({ 
  a, b,
}) => {
  return {
    combined: addCells({ a, b })
  }
})
```

Typically it's unusual ot use `lift()` directly. It is almost always better to use `computed()`.
