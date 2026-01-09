`lift()` is a foundational operation used to implement others built-in functions like `computed()`, `handler()` and `pattern()`.

This is lift in the sense of [lifted functions](https://en.wikipedia.org/wiki/Lift_(mathematics))

```tsx
const result = lift((args) => args.g[args.d])({ g: grouped, d: date });
```
