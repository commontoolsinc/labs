## Default<T, Value>

**Use `Default<>` for any field that will be displayed in UI or used in computations.** Without a default, fields are `undefined` at runtime until data is explicitly set—causing errors like `Cannot read properties of undefined` when your pattern tries to render or compute.

Specify default values in schemas:

```typescript
import { Default } from 'commontools';

interface TodoItem {
  title: string;                      // Required
  done: Default<boolean, false>;      // Defaults to false
  category: Default<string, "Other">; // Defaults to "Other"
}

interface Input {
  items: Default<TodoItem[], []>;     // Defaults to empty array
}
```

### Writable<> with Default<>

When you need **both** a default value **and** write access (`.push()`, `.set()`, `.get()`), wrap `Default<>` inside `Writable<>`:

```typescript
import { Default, Writable } from 'commontools';

interface Board {
  title: Default<string, "My Board">;
  // ❌ Writable<Column[]> - no default, will be undefined at runtime
  // ❌ Default<Column[], []> - has default but no .push()/.set() methods
  // ✅ Writable<Default<...>> - has both default AND write methods
  columns: Writable<Default<Column[], []>>;
}
```

This is the most common pattern for mutable arrays in schemas.
