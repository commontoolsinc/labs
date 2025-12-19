<!-- @reviewed 2025-12-11 docs-rationalization -->

# Types and Schemas

CommonTools type system: when to use `Cell<>`, type contexts, and CTS.

## Cell<> = Write Intent

`Cell<>` in type signatures indicates **write intent**, not reactivity. Everything is reactive by default.

```typescript
// Read-only (still reactive!)
interface ReadOnlyInput {
  count: number;
  items: Item[];
}

// Write access needed
interface WritableInput {
  count: Cell<number>;    // Will call .set()
  items: Cell<Item[]>;    // Will call .push()
}
```

### Cell Methods

With `Cell<T>` in your signature:

| Method | Purpose |
|--------|---------|
| `.get()` | Read current value |
| `.set(value)` | Replace entire value |
| `.update({ key: value })` | Partial update (objects) |
| `.push(item)` | Add to array |
| `.key("property")` | Navigate nested data |

Without `Cell<>`, you can still display values in JSX, pass to `computed()`, and map over arrays - all reactively. Note: filtering and transformations must be done in `computed()` outside JSX, then the result can be mapped inside JSX.

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

// Context 2: Pattern parameter (with Cell<> for write access)
interface WritableInput {
  items: Cell<ShoppingItem[]>;
}

export default pattern<WritableInput>(({ items }) => {
  // Context 3: items is Cell<ShoppingItem[]>

  return {
    [UI]: (
      <div>
        {/* Context 4: In .map() - item is OpaqueRef<ShoppingItem> */}
        {items.map((item) => (
          <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
        ))}
      </div>
    ),
  };
});
```

---

## Cell<T[]> vs Cell<Array<Cell<T>>>

**Use `Cell<T[]>` by default:**

```typescript
const addItem = handler<unknown, { items: Cell<Item[]> }>(
  (_, { items }) => {
    items.push({ title: "New", done: false });
    items.set(items.get().filter(x => !x.done));
  }
);
```

**Use `Cell<Array<Cell<T>>>` only when you need `.equals()` on elements:**

```typescript
const removeItem = handler<
  unknown,
  { items: Cell<Array<Cell<Item>>>; item: Cell<Item> }
>((_, { items, item }) => {
  const index = items.get().findIndex(el => el.equals(item));
  if (index >= 0) items.set(items.get().toSpliced(index, 1));
});
```

---

## Handler Types in Output Interfaces

Handlers exposed in Output interfaces must be typed as `Stream<T>`, NOT `OpaqueRef<T>`.

```typescript
// ✅ CORRECT - Use Stream<T> for handlers in Output
interface Output {
  count: number;
  increment: Stream<void>;           // Handler with no parameters
  setCount: Stream<{ value: number }>; // Handler with parameters
}

// ❌ WRONG - OpaqueRef in Output interface
interface Output {
  increment: OpaqueRef<void>;        // Wrong!
}
```

**Why Stream<T>?**
- `Stream<T>` represents a write-only channel for triggering actions
- Other charms can call these handlers via `.send()` when linked
- `OpaqueRef<T>` is for reactive references in `.map()` contexts, not handlers

### Creating Streams (Bound Handlers)

A bound handler IS a `Stream<EventType>`. Don't try to create streams directly:

```typescript
// ❌ WRONG - Stream.of() and .subscribe() don't exist
const addItem: Stream<{ title: string }> = Stream.of();
addItem.subscribe(({ title }) => { ... });  // Error!

// ✅ CORRECT - Define handler, bind with state
const addItemHandler = handler<
  { title: string },      // Event type
  { items: Cell<Item[]> } // State type
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

## Anti-Pattern: Manual OpaqueRef Casting

Don't manually cast to/from `OpaqueRef`. The framework handles this automatically.

```typescript
// ❌ WRONG - Don't cast
myHandler({ items: itemsCell as unknown as OpaqueRef<Item[]> })

// ✅ CORRECT - Pass directly
myHandler({ items: itemsCell })

// ❌ WRONG - Don't use OpaqueRef in handler types
handler<Event, { items: Cell<OpaqueRef<Item>[]> }>(...)

// ✅ CORRECT - Use plain array type
handler<Event, { items: Cell<Item[]> }>((_, { items }) => {
  items.push({ title: "New" });
})
```

**Why casting breaks things:**
- Strips reactive proxy wrapper
- Bypasses TypeScript guidance
- Framework already does this automatically

---

## Summary

| Concept | Usage |
|---------|-------|
| `Cell<T>` | Write access (`.set()`, `.push()`) |
| `Default<T, V>` | Schema default values |
| `OpaqueRef<T>` | Auto-wrapped in `.map()` - don't use manually |
| `Stream<T>` | Handlers in Output interfaces |
| `/// <cts-enable />` | Enable CTS type processing |
| `Cell<T[]>` | Standard array (default) |
| `Cell<Array<Cell<T>>>` | When you need `.equals()` on elements |
