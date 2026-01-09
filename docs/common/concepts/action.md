### action() - Simplified Handlers

For inline handlers where all data is in scope at definition time:

```tsx
// action - data bound at definition (closes over count)
action(() => count.set(count.get() + 1))

// handler - data bound at invocation (row, col passed per-call)
handler<unknown, { row: number; col: number; game: Cell<Game> }>(...)
```

Use `handler()` when you need to pass data at invocation time (e.g., loop variables). Use `action()` for simple inline mutations where everything needed is already in scope.
