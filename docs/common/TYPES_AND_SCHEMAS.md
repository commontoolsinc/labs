# Types and Schemas Guide

This guide explains CommonTools' type system, including when to use `Cell<>`, understanding `OpaqueRef<>`, working with the CTS (CommonTools TypeScript) system, and deciding when to use `[ID]`.

## When to Use Cell<> in Signatures

**The Golden Rule:** `Cell<>` in type signatures indicates **write intent**, not reactivity requirement.

### In Recipe/Handler/Lift Parameters

Use `Cell<>` when you need write operations:

```typescript
// ✅ Use Cell<> when you need write operations
interface WritableInput {
  count: Cell<number>;        // Will call count.set()
  items: Cell<Item[]>;        // Will call items.push()
  user: Cell<User>;           // Will call user.update()
}

export default recipe<WritableInput>(({ count, items, user }) => {
  // Can mutate
  count.set(count.get() + 1);
  items.push({ title: "New" });
  user.update({ name: "Alice" });

  return { ... };
});
```

Omit `Cell<>` for read-only usage:

```typescript
// ✅ Omit Cell<> for read-only
interface ReadOnlyInput {
  count: number;              // Just display
  items: Item[];              // Just map/filter
  user: User;                 // Just access properties
}

export default recipe<ReadOnlyInput>(({ count, items, user }) => {
  // All reactive! Just can't mutate
  return {
    [UI]: (
      <div>
        <div>Count: {count}</div>
        <div>User: {user.name}</div>
        {items.map(item => <div>{item.title}</div>)}
      </div>
    ),
  };
});
```

### Cell<> Provides These Methods

When you declare `Cell<T>` in your signature:

- `.get()` - Read current value
- `.set(newValue)` - Replace entire value
- `.update({ key: value })` - Partial update (for objects)
- `.push(item)` - Add to array (for arrays)
- `.key("property")` - Navigate and mutate nested data

Without `Cell<>`, you can still:
- Display values in JSX (reactive!)
- Use in `computed()` (reactive!)
- Pass to other functions (reactive!)
- Map/filter/reduce operations (reactive!)

### Examples

**Read-only pattern:**

```typescript
interface BlogPostInput {
  title: string;
  content: string;
  author: User;
  publishedAt: Date;
}

export default recipe<BlogPostInput>(({ title, content, author, publishedAt }) => {
  // Everything is reactive for display
  return {
    [UI]: (
      <article>
        <h1>{title}</h1>
        <div>By {author.name} on {publishedAt}</div>
        <div>{content}</div>
      </article>
    ),
  };
});
```

**Writable pattern:**

```typescript
interface TodoInput {
  items: Cell<TodoItem[]>;
  newItemTitle: Cell<string>;
}

export default recipe<TodoInput>(({ items, newItemTitle }) => {
  return {
    [UI]: (
      <div>
        {/* Display is reactive */}
        {items.map(item => <div>{item.title}</div>)}

        {/* Can also mutate */}
        <ct-input $value={newItemTitle} />
        <ct-button onClick={() => {
          if (newItemTitle.get().trim()) {
            items.push({ title: newItemTitle.get(), done: false });
            newItemTitle.set("");
          }
        }}>
          Add
        </ct-button>
      </div>
    ),
    items,
  };
});
```

## Understanding Type Contexts

There are **four different contexts** where array types appear:

```typescript
interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
}

// Context 1: In recipe input/output schemas
interface Input {
  items: Default<ShoppingItem[], []>;  // Plain type in schema
}

// Context 2: In recipe parameters (if need write access)
interface WritableInput {
  items: Cell<ShoppingItem[]>;  // Cell<> for write access
}

export default recipe<WritableInput>(
  ({ items }) => {  // Context 3: items is Cell<ShoppingItem[]> or reactive ref

    return {
      [UI]: (
        <div>
          {/* Context 4: In .map() - item is OpaqueRef<ShoppingItem> */}
          {items.map((item) => (
            <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
          ))}
        </div>
      ),
      items,
    };
  },
);
```

## OpaqueRef\<T\> - Cell-Like References

`OpaqueRef<T>` represents a **cell-like reference** to data within the reactive graph. You'll encounter it primarily in `.map()` operations.

### Where OpaqueRef Appears

**In `.map()` over reactive arrays:**

```typescript
// item's type is automatically inferred as OpaqueRef<ShoppingItem>
{items.map((item) => (
  <div>
    {item.title}                           // Property access works
    <ct-checkbox $checked={item.done} />   // Bidirectional binding works
  </div>
))}
```

**Why it matters:**

`OpaqueRef<T>` maintains the connection to the Cell system, enabling:
- **Bidirectional binding** (`$checked`, `$value`)
- **Reactive updates** when the item changes
- **Type-safe property access**

### Type Annotation in .map()

When using bidirectional binding, TypeScript sometimes needs help with type inference:

```typescript
// ✅ CORRECT - Type annotation for bidirectional binding
{items.map((item: OpaqueRef<ShoppingItem>) => (
  <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
))}

// ❌ May cause type errors without annotation
{items.map((item) => (
  <ct-checkbox $checked={item.done} />  // Type error!
))}
```

**When to add the type annotation:**
- Using `$checked`, `$value`, or other bidirectional bindings
- TypeScript shows errors about property types
- Working with complex nested objects

**When you can skip it:**
- Simple display (no bidirectional binding)
- TypeScript infers correctly

### OpaqueRef in Handler Parameters

**Critical Rule:** Never use `OpaqueRef<>` in handler type signatures. Use `Cell<T[]>` instead:

```typescript
// ✅ CORRECT - Cell wraps the entire array
const addItem = handler<
  unknown,
  { items: Cell<ShoppingItem[]> }  // ← Cell<ShoppingItem[]>
>((_event, { items }) => {
  const currentItems = items.get();  // Returns ShoppingItem[]
  items.push({ title: "New", done: false });
});

// ❌ WRONG - Don't use OpaqueRef in handler parameters
const addItem = handler<
  unknown,
  { items: Cell<OpaqueRef<ShoppingItem>[]> }  // ← Wrong!
>(/* ... */);
```

## Cell\<T[]\> vs Cell\<Array\<Cell\<T\>\>\>

Understanding when to use which array type:

### Cell\<T[]\> - Most Common

Use for most array operations:

```typescript
// ✅ Standard pattern
const addItem = handler<
  unknown,
  { items: Cell<ShoppingItem[]> }
>((_event, { items }) => {
  items.push({ title: "New", done: false });
  items.set([...items.get(), newItem]);
  items.set(items.get().filter(item => !item.done));
});
```

### Cell\<Array\<Cell\<T\>\>\> - Advanced

Use when you need Cell methods on individual array elements:

```typescript
// ✅ When you need .equals() on elements
const removeItem = handler<
  unknown,
  { items: Cell<Array<Cell<ShoppingItem>>>; item: Cell<ShoppingItem> }
>((_event, { items, item }) => {
  const currentItems = items.get();
  // Call .equals() on individual cell in the array
  const index = currentItems.findIndex((el) => el.equals(item));
  if (index >= 0) {
    items.set(currentItems.toSpliced(index, 1));
  }
});
```

**Use `Cell<T[]>` by default.** Only use `Cell<Array<Cell<T>>>` when you specifically need Cell methods on array elements.

## The CTS (CommonTools TypeScript) System

CommonTools uses a TypeScript-first approach where your TypeScript types are automatically processed at runtime.

### Basic Usage

```typescript
// Define TypeScript types
interface Person {
  name: string;
  age?: number;
  email: string;
}

// The framework automatically processes this TypeScript type
// No manual schema definition needed - it's all handled by CTS reflection
```

### CTS Provides

1. **Runtime type validation** - Ensures data matches your types
2. **Self-documentation** - Types describe your data structure
3. **Serialization support** - Types guide data serialization
4. **IDE integration** - Full TypeScript tooling support

### Enable CTS Processing

Add this comment at the top of your pattern file:

```typescript
/// <cts-enable />
import { recipe, UI, NAME } from "commontools";
```

This tells the CTS system to process TypeScript types in this file.

## Default\<T, DefaultValue\> - Providing Defaults

Use `Default<>` to specify default values in your schemas:

```typescript
interface UserSettings {
  theme: Default<"light" | "dark" | "system", "system">;
  fontSize: Default<number, 14>;
  notifications: Default<boolean, true>;
}

// When creating instances without these properties, defaults are used
const settings: UserSettings = {};  // All defaults applied
```

**Benefits:**
- Clear default values in type definition
- No need for manual initialization
- Self-documenting

**Common usage:**

```typescript
interface TodoItem {
  title: string;                      // Required
  done: Default<boolean, false>;      // Defaults to false
  priority: Default<number, 0>;       // Defaults to 0
  category: Default<string, "Other">; // Defaults to "Other"
}

interface TodoListInput {
  items: Default<TodoItem[], []>;     // Defaults to empty array
}
```

## When to Use [ID]

**Start without [ID].** Only add it if you encounter specific bugs or have one of the use cases below.

### The [ID] Symbol

```typescript
import { ID } from "commontools";

interface Item {
  [ID]: number;  // Only add this when you need it!
  title: string;
}
```

### When [ID] is NOT Needed (Most Cases)

✅ **Use simple interfaces without [ID] for:**

- Basic lists and CRUD operations
- Items only displayed, not referenced elsewhere
- Adding items to the end of arrays
- Removing items by button click
- Editing items in place
- Most todo lists, shopping lists, simple data displays

```typescript
// ✅ SIMPLE - No [ID] needed
interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
  category: Default<string, "Uncategorized">;
}

const removeItem = handler<
  unknown,
  { items: Cell<Array<Cell<ShoppingItem>>>; item: Cell<ShoppingItem> }
>((_event, { items, item }) => {
  const currentItems = items.get();
  const index = currentItems.findIndex((el) => el.equals(item));
  if (index >= 0) {
    items.set(currentItems.toSpliced(index, 1));
  }
});
```

This works perfectly without [ID] because:
- Items are added to the end
- Removal uses item references with `.equals()`
- No cross-reference tracking needed

### When [ID] IS Needed (Specific Cases)

❌ **Only add [ID] when you need:**

#### Creating Referenceable Items in Reactive Contexts

When creating items in `computed()` or handlers that need stable references:

```typescript
const generateItems = computed(() => {
  return Array.from({ length: count }, (_, i) => ({
    [ID]: i,  // Needed for stable references
    title: `Item ${i}`,
  }));
});
```

#### Complex Reordering or Front-Insertion

When inserting items at the beginning or complex drag-and-drop:

```typescript
interface ReorderableItem {
  [ID]: number;  // Needed for stable identity during reordering
  title: string;
  position: number;
}

const insertAtStart = handler<unknown, { items: Cell<ReorderableItem[]> }>(
  (_, { items }) => {
    const current = items.get();
    items.set([{ [ID]: Date.now(), title: "New", position: 0 }, ...current]);
  }
);
```

**Note:** Even for reordering, try without [ID] first. Many scenarios work fine without it.

### Decision Matrix: Do You Need [ID]?

| Use Case | Need [ID]? |
|----------|------------|
| Display list of items | ❌ No |
| Add items to end of array | ❌ No |
| Remove items by reference | ❌ No |
| Edit items in place | ❌ No |
| Simple sorting | ❌ No |
| Creating items in computed() | ✅ Maybe |
| Insert at beginning of array | ✅ Maybe |
| Complex drag-and-drop | ✅ Maybe |
| Cross-pattern references | ✅ Yes |

## Type Composition

Break down complex types into smaller, reusable parts:

```typescript
type Address = {
  street: string;
  city: string;
  zipCode: string;
};

type Contact = {
  phone?: string;
  email: string;
};

type User = {
  id: string;
  name: string;
  address: Address;      // Composed type
  contact: Contact;      // Composed type
};
```

**Benefits:**
- Reusable type definitions
- Clearer structure
- Easier to maintain
- Better for sharing between patterns

## Union Types for Enums

Define enums with union types and const assertions:

```typescript
const StatusValues = ["pending", "active", "suspended", "deleted"] as const;
type Status = typeof StatusValues[number];
// Type is: "pending" | "active" | "suspended" | "deleted"

interface User {
  id: string;
  name: string;
  status: Default<Status, "pending">;
}
```

## Optional vs Required Properties

Use TypeScript's optional properties (?) to indicate what's required:

```typescript
interface User {
  id: string;        // Required
  name: string;      // Required
  email?: string;    // Optional
  phone?: string;    // Optional
}
```

## Type Best Practices

### 1. Descriptive Names

```typescript
// ✅ DO THIS
type UserPreferences = {
  theme: "light" | "dark" | "system";
  fontSize: number;
  notifications: boolean;
};

// ❌ NOT THIS
type Config = { theme: string; size: number; alerts: boolean };
```

### 2. Document with JSDoc

```typescript
/** User's primary email address used for notifications */
type Email = string;

interface User {
  id: string;
  name: string;
  /** User's primary email address used for notifications */
  email?: Email;
}
```

### 3. Export Shared Types

```typescript
// schemas.ts
export interface TodoItem {
  title: string;
  done: Default<boolean, false>;
}

// pattern-a.tsx
import type { TodoItem } from "./schemas.ts";

// pattern-b.tsx
import type { TodoItem } from "./schemas.ts";
```

### 4. Use Type Composition

```typescript
// Base types
type Timestamps = {
  createdAt: Date;
  updatedAt: Date;
};

type WithId = {
  id: string;
};

// Composed type
type TodoItem = WithId & Timestamps & {
  title: string;
  done: boolean;
};
```

## Common Type Errors

### Error: "Property 'set' does not exist"

❌ **Problem:** Trying to mutate without `Cell<>` in signature

```typescript
interface Input {
  count: number;  // Read-only!
}

const recipe = ({ count }: Input) => {
  count.set(5);  // Error: set doesn't exist
};
```

✅ **Solution:** Add `Cell<>` to indicate write intent

```typescript
interface Input {
  count: Cell<number>;  // Write access
}

const recipe = ({ count }: Input) => {
  count.set(5);  // Works!
};
```

### Error: "Type 'OpaqueRef\<T\>' is not assignable to 'Cell\<T\>'"

❌ **Problem:** Trying to bind the whole item instead of a property

```typescript
// Problem: Trying to bind the whole item
<ct-checkbox $checked={item} />
```

✅ **Solution:** Bind the specific property

```typescript
<ct-checkbox $checked={item.done} />
```

### Error: "Property does not exist on type 'OpaqueRef\<unknown\>'"

❌ **Problem:** Missing type annotation in `.map()`

```typescript
{items.map((item) => (
  <ct-checkbox $checked={item.done} />  // Type error!
))}
```

✅ **Solution:** Add `OpaqueRef<T>` type annotation

```typescript
{items.map((item: OpaqueRef<ShoppingItem>) => (
  <ct-checkbox $checked={item.done} />
))}
```

### Error: Using OpaqueRef in handler signature

❌ **Problem:** Wrong type in handler parameters

```typescript
const handler = handler<unknown, { items: Cell<OpaqueRef<Item>[]> }>(
  // Wrong!
);
```

✅ **Solution:** Use `Cell<T[]>` instead

```typescript
const handler = handler<unknown, { items: Cell<Item[]> }>(
  // Correct!
);
```

## Summary

**Key Takeaways:**

1. **Cell<> = Write Permission** - Only in signatures when you need `.set()`, `.update()`, `.push()`
2. **OpaqueRef<T> in .map()** - Type annotation needed for bidirectional binding
3. **Never OpaqueRef in Handlers** - Always use `Cell<T[]>`
4. **CTS Handles Runtime** - Just write TypeScript types, validation is automatic
5. **[ID] is Rarely Needed** - Start without it, add only if you hit specific use cases
6. **Default<> for Defaults** - Clear, self-documenting default values
7. **Compose Types** - Build complex types from simple, reusable parts
