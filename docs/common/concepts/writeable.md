Only declare `Writable<>` when you need to mutate.

Everything is reactive by default. `Writable<>` in type signatures indicates you'll call `.set()`, `.push()`, or `.update()`:

```typescript
interface Input {
  count: number;             // Read-only (still reactive!)
  items: Writable<Item[]>;   // Will mutate (call .push(), .set())
}
```

### Mental Model

Think of `Writable<>` as a permission declaration:

| Without Writable<> | With Writable<> |
|--------------------|-----------------|
| "I will only read this value" | "I need to write to this value" |
| Still reactive for display | Can call `.set()`, `.update()`, `.push()` |
| Can pass to `computed()` | Can mutate directly |
| Can use in JSX | Everything read-only can do, plus mutation |
