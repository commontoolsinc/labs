
## Default<T, Value>

**Use `Default<>` for any field that will be displayed in UI or used in computations.** Without a default, fields are `undefined` at runtime until data is explicitly set—causing errors like `Cannot read properties of undefined` when your pattern tries to render or compute.

Specify default values in schemas:

```typescript
interface TodoItem {
  title: string;                      // Required
  done: Default<boolean, false>;      // Defaults to false
  category: Default<string, "Other">; // Defaults to "Other"
}

interface Input {
  items: Default<TodoItem[], []>;     // Defaults to empty array
}
```

### Cell<> with Default<>

When you need write access on a pattern input with a default value, wrap `Default<>` in `Cell<>`:

```typescript
// ❌ No write access - .get()/.set() won't work in handlers
interface Input {
  rating: Default<number | null, null>;
}

// ✅ Write access - .get()/.set() work in handlers
interface Input {
  rating: Cell<Default<number | null, null>>;
}
```
