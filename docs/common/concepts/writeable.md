Only declare `Writable<>` when you need to mutate.

Everything is reactive by default. `Writable<>` in type signatures indicates you'll call `.set()`, `.push()`, or `.update()`:

```typescript
interface Input {
  count: number;             // Read-only (still reactive!)
  items: Writable<Item[]>;   // Will mutate (call .push(), .set())
}
```
