<!-- @reviewed 2025-12-11 docs-rationalization -->

# Types and Schemas

CommonTools type system: when to use `Writable<>`, type contexts, and CTS.

## Writable<> = Write Intent

`Writable<>` in type signatures indicates **write intent**, not reactivity. Everything is reactive by default.

```typescript
// Read-only (still reactive!)
interface ReadOnlyInput {
  count: number;
  items: Item[];
}

// Write access needed
interface WritableInput {
  count: Writable<number>;    // Will call .set()
  items: Writable<Item[]>;    // Will call .push()
}
```

### Writable Methods

With `Writable<T>` in your signature:

| Method | Purpose |
|--------|---------|
| `.get()` | Read current value |
| `.set(value)` | Replace entire value |
| `.update({ key: value })` | Partial update (objects) |
| `.push(item)` | Add to array |
| `.key("property")` | Navigate nested data |

Without `Writable<>`, you can still display values in JSX, pass to `computed()`, and map over arrays - all reactively. Note: filtering and transformations must be done in `computed()` outside JSX, then the result can be mapped inside JSX.

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

---

## Type Contexts

Four contexts where types appear differently:

```typescript
interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
}

// Context 1: Schema definition
interface Input {
  items: Default<ShoppingItem[], []>;
}

// Context 2: Pattern parameter (with Writable<> for write access)
interface WritableInput {
  items: Writable<ShoppingItem[]>;
}

export default pattern<WritableInput>(({ items }) => {
  // Context 3: items is Writable<ShoppingItem[]>

  return {
    [UI]: (
      <div>
        {items.map((item) => (
          <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
        ))}
      </div>
    ),
  };
});
```

---

## Writable<T[]> vs Writable<Array<Writable<T>>>

**Use `Writable<T[]>` by default:**

```typescript
const addItem = handler<unknown, { items: Writable<Item[]> }>(
  (_, { items }) => {
    items.push({ title: "New", done: false });
    items.set(items.get().filter(x => !x.done));
  }
);
```

**Use `Writable<Array<Writable<T>>>` only when you need `.equals()` on elements:**

```typescript
const removeItem = handler<
  unknown,
  { items: Writable<Array<Writable<Item>>>; item: Writable<Item> }
>((_, { items, item }) => {
  const index = items.get().findIndex(el => el.equals(item));
  if (index >= 0) items.set(items.get().toSpliced(index, 1));
});
```

---

## Handler Types in Output Interfaces

Handlers exposed in Output interfaces must be typed as `Stream<T>`.

```typescript
interface Output {
  count: number;
  increment: Stream<void>;           // Handler with no parameters
  setCount: Stream<{ value: number }>; // Handler with parameters
}
```

**Why Stream<T>?**
- `Stream<T>` represents a write-only channel for triggering actions
- Other charms can call these handlers via `.send()` when linked

### Creating Streams (Bound Handlers)

A bound handler IS a `Stream<EventType>`. Don't try to create streams directly:

```typescript
// ❌ WRONG - Stream.of() and .subscribe() don't exist
const addItem: Stream<{ title: string }> = Stream.of();
addItem.subscribe(({ title }) => { ... });  // Error!

// ✅ CORRECT - Define handler, bind with state
const addItemHandler = handler<
  { title: string },          // Event type
  { items: Writable<Item[]> } // State type
>(({ title }, { items }) => {
  items.push({ title });
});

// Binding returns Stream<{ title: string }>
const addItem = addItemHandler({ items });

// Export in return
return {
  addItem,  // This IS Stream<{ title: string }>
};
```

The bound handler is the stream. Other patterns or charms can send events to it via linking.

---

## CTS (CommonTools TypeScript)

TypeScript types are automatically processed at runtime. Enable with:

```typescript
/// <cts-enable />
import { pattern, UI, NAME } from "commontools";
```

CTS provides:
- Runtime type validation
- Automatic schema generation (for `generateObject<T>`)
- Serialization support

---

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

---

## Type Patterns

**Union types for enums:**

```typescript
type Status = "pending" | "active" | "deleted";
// or
const StatusValues = ["pending", "active", "deleted"] as const;
type Status = typeof StatusValues[number];
```

**Composition:**

```typescript
type Timestamps = { createdAt: Date; updatedAt: Date };
type WithId = { id: string };
type TodoItem = WithId & Timestamps & { title: string; done: boolean };
```

**Shared types:**

```typescript
// schemas.ts
export interface TodoItem { title: string; done: Default<boolean, false>; }

// pattern.tsx
import type { TodoItem } from "./schemas.ts";
```

---

## Summary

| Concept | Usage |
|---------|-------|
| `Writable<T>` | Write access (`.set()`, `.push()`) |
| `Default<T, V>` | Schema default values |
| `Stream<T>` | Handlers in Output interfaces |
| `/// <cts-enable />` | Enable CTS type processing |
| `Writable<T[]>` | Standard array (default) |
| `Writable<Array<Writable<T>>>` | When you need `.equals()` on elements |
