<!-- @reviewed 2025-12-10 docs-rationalization -->

# Reactivity Guide

This guide explains CommonTools' reactive system: how cells work, when reactivity is automatic, and how to work with reactive data effectively.

## Core Principle: Writable\<\> is About Write Access, Not Reactivity

**The most important thing to understand:** Everything in CommonTools is reactive by default. The `Writable<>` wrapper in type signatures doesn't enable reactivity—it indicates **write intent**.

### The Rule

- **Use `Writable<T>`** in signatures ONLY when you need write access (`.set()`, `.update()`, `.push()`, `.key()`)
- **Omit `Writable<>`** for read-only access - the framework automatically provides reactive values

```typescript
// ✅ Read-only - No Writable<> needed (still reactive!)
interface ReadOnlyInput {
  count: number;        // Just display it
  items: Item[];        // Just map/display
  userName: string;     // Just show it
}

export default pattern<ReadOnlyInput>(({ count, items, userName }) => {
  return {
    [UI]: (
      <div>
        <div>Count: {count}</div>              {/* Reactive! */}
        <div>User: {userName}</div>            {/* Reactive! */}
        {items.map(item => <div>{item}</div>)} {/* Reactive! */}
      </div>
    ),
  };
});

// ✅ Write access - Writable<> required
interface WritableInput {
  count: Writable<number>;  // Will call count.set()
  items: Writable<Item[]>;  // Will call items.push()
  title: Writable<string>;  // Will call title.set()
}

export default pattern<WritableInput>(({ count, items, title }) => {
  return {
    [UI]: (
      <div>
        {/* Display is still reactive */}
        <div>Count: {count}</div>

        {/* Can also mutate */}
        <ct-button onClick={() => count.set(count.get() + 1)}>
          Increment
        </ct-button>

        <ct-input $value={title} />

        <ct-button onClick={() => items.push({ title: "New" })}>
          Add Item
        </ct-button>
      </div>
    ),
  };
});
```

### Mental Model

Think of `Writable<>` as a permission declaration:

| Without Writable<> | With Writable<> |
|--------------------|-----------------|
| "I will only read this value" | "I need to write to this value" |
| Still reactive for display | Can call `.set()`, `.update()`, `.push()` |
| Can pass to `computed()` | Can mutate directly |
| Can use in JSX | Everything read-only can do, plus mutation |

### Access Patterns Are Type-Based

How you access a value depends on its **type**, not where you're accessing it:

| Type | How to access | Created by |
|------|---------------|------------|
| `Writable<T>` | `.get()` to read, `.set()` to write | `Writable.of()`, `Writable<>` in type signature |
| `OpaqueRef<T>` | Direct property access | Pattern inputs without `Writable<>`, items in `.map()` |

**Important:** `Writable<T>` always requires `.get()`—this never changes regardless of context.

`OpaqueRef<T>` property access works anywhere using accessors (e.g., `user.name`). However, to **call methods or perform computation** on an OpaqueRef value, you must do so inside a `computed()` that captures it from the enclosing scope:

```typescript
export default pattern<{ user: { name: string } }>(({ user }) => {
  // ✅ Property access on OpaqueRef works anywhere
  const nameDisplay = user.name;  // Fine in pattern body, JSX, etc.

  // ✅ Computation on OpaqueRef must be inside computed() that captures it
  const upperName = computed(() => user.name.toUpperCase());

  // ❌ Can't call methods on OpaqueRef outside computed()
  // const broken = user.name.toUpperCase();  // Won't work

  return { [UI]: <div>{user.name} / {upperName}</div> };
});

// Writable<T> always needs .get(), regardless of context
const localCell = Writable.of("hello");
const upper = computed(() => localCell.get().toUpperCase());
```

## Writable Basics

Different reactive types have different access patterns:

| Type | How to access | Example |
|------|---------------|---------|
| Pattern inputs (no `Writable<>`) | Access directly | `items.filter(...)` |
| Pattern inputs with `Writable<>` | Use `.get()` to read | `items.get().filter(...)` |
| `Writable<>` with `.map()` | Exception: `.map()` works directly | `items.map(item => ...)` |
| `computed()` results | Access directly - no `.get()` | `filteredItems.length` |
| `lift()` results | Access directly - no `.get()` | `formattedDate` |
| Values inside `.map()` | Properties are reactive, use `lift()` for object indexing | See below |

### Pattern Input Access Patterns

Pattern inputs follow the same rules—`Writable<>` needs `.get()`, everything else is accessed directly:

```typescript
interface Input {
  // Read-only inputs - access directly
  title: string;
  items: Item[];

  // Writable inputs - use .get() to read
  count: Writable<number>;
  todos: Writable<Todo[]>;
}

export default pattern<Input>(({ title, items, count, todos }) => {
  // Read-only inputs: access directly (like computed/lift results)
  const upperTitle = computed(() => title.toUpperCase());
  const activeItems = computed(() => items.filter(item => !item.done));

  // Writable inputs: use .get() to read the value
  const doubled = computed(() => count.get() * 2);
  const completedCount = computed(() => todos.get().filter(t => t.done).length);

  // Exception: .map() works directly on Writable<T[]>
  // The callback receives items that follow the same rules as pattern inputs
  const todoTitles = todos.map(todo => todo.title);  // No .get() needed

  return {
    [UI]: (
      <div>
        <h1>{title}</h1>
        <p>Count: {count}</p>
        {items.map(i => <div>{i.name}</div>)}
        {todos.map(todo => <div>{todo.title}</div>)}  {/* .map() on Writable works */}
      </div>
    ),
  };
});
```

**The rule:** If you declared it with `Writable<T>`, use `.get()` to read—except `.map()` which works directly. Inside `.map()` callbacks, items follow the same access rules as pattern inputs.

### Using Reactive Values to Index Objects in `.map()`

When iterating with `.map()`, each item's properties are reactive. To use a reactive value as an index into a plain object (like a lookup table), use `lift()`:

```typescript
const STYLES = {
  pending: { bgColor: "#fef3c7", color: "#92400e" },
  active: { bgColor: "#dbeafe", color: "#1e40af" },
  complete: { bgColor: "#dcfce7", color: "#166534" },
};

// Create lifted helpers for each property you need
const getStyleBgColor = lift((status: Status): string => STYLES[status].bgColor);
const getStyleColor = lift((status: Status): string => STYLES[status].color);

// Use the lifted functions in .map()
items.map((item) => (
  <div style={{ backgroundColor: getStyleBgColor(item.status), color: getStyleColor(item.status) }}>
    {item.title}
  </div>
));
```

## Writable Basics

### Creating Writable Cells with Cell.of()

Use `Cell.of()` to create NEW writable cells in your pattern body or return values.

This is rare. Generally prefer to add additional input parameters instead of
creating internal cells.

**When to use Cell.of():**

- Creating new cells inside a pattern that can't be input parameters.
- Creating local state that handlers will mutate

**When NOT to use Cell.of():**

- Input parameters (they're already writable if declared with `Writable<>`)
- Values you won't mutate

```typescript
// ✅ Creating new cells in pattern body
export default pattern(({ inputItems }) => {
  // Create new cells for local state
  const filteredItems = Cell.of<Item[]>([]);
  const searchQuery = Cell.of("");
  const selectedItem = Cell.of<Item | null>(null);

  return {
    [UI]: <div>...</div>,
    // Return cells so they're reactive and mutable
    filteredItems,
    searchQuery,
    selectedItem,
  };
});

// ✅ Common patterns
const count = Cell.of(0);                           // Number
const name = Cell.of("Alice");                      // String
const items = Cell.of<Item[]>([]);                  // Empty array with type
const user = Cell.of<User>();                       // Optional value
const config = Cell.of<Config>({ theme: "dark" });  // Object with initial value
```

**Common mistake:**

```typescript
// ❌ WRONG - Plain array, not a cell
return {
  outputData: [],  // Not reactive! Can't mutate!
};

// ✅ CORRECT - Use Cell.of()
return {
  outputData: Cell.of<Item[]>([]),  // Reactive and mutable!
};
```

### Writable Methods

When you have `Writable<>` in your signature (write access), you can use these methods in handlers or inline event handlers:

```typescript
// In a handler - this is where you typically use writable methods
const updateData = handler<
  { detail: { value: string } },
  { count: Writable<number>; user: Writable<User>; items: Writable<Item[]> }
>(({ detail }, { count, user, items }) => {
  // Read current value
  const currentCount = count.get();

  // Set new value (replaces entire value)
  count.set(42);

  // Update nested properties
  user.update({ name: "Bob" });  // Merges with existing user

  // Navigate to nested property
  user.key("profile").key("age").set(30);

  // Array operations
  items.push({ title: "New Item", done: false });

  // Array replacement
  items.set([...items.get(), newItem]);
  items.set(items.get().filter(item => !item.done));
  items.set(items.get().toSpliced(index, 1));  // Remove at index
});

// Or in inline handlers
<ct-button onClick={() => {
  count.set(count.get() + 1);
  items.push({ title: "New", done: false });
}}>
  Add
</ct-button>
```

### cell.sample() - Non-Reactive Reads

Use `.sample()` to read a cell's value **without creating a reactive dependency**:

```typescript
// In a computed() - normally .get() would cause re-runs when the cell changes
const result = computed(() => {
  const currentUser = userCell.get();      // Creates dependency - result re-runs when userCell changes
  const initialValue = configCell.sample(); // NO dependency - result won't re-run when configCell changes
  return doSomething(currentUser, initialValue);
});
```

**When to use `.sample()`:**
- Reading configuration or initial values that shouldn't trigger updates
- Breaking intentional reactive loops
- Performance optimization when you want a "snapshot" of a value

**Caution:** Overusing `.sample()` can lead to stale data. Only use it when you specifically want to avoid reactivity.

### Cell.equals()

Use `Cell.equals()` to compare cells or cell values:

```typescript
// Works with cells or plain values
const isSame = Cell.equals(cell1, cell2);
const isSame = Cell.equals(value1, value2);
const isSame = Cell.equals(cell, value);

// Useful in array operations
const removeItem = (items: Writable<Item[]>, item: Writable<Item>) => {
  const currentItems = items.get();
  const index = currentItems.findIndex(el => Cell.equals(item, el));
  if (index >= 0) {
    items.set(currentItems.toSpliced(index, 1));
  }
};
```

## Reactive Computations with computed()

`computed()` creates reactive derived values that update when their dependencies change.

**Note:** You may see `derive()` in some docs or error messages. While `derive()` works and can handle multiple inputs (arrays or objects of dependencies), **always prefer `computed()`** in patterns. The CTS transformer automatically handles closure extraction, making `computed()` the recommended API for all reactive computations.

### Basic Usage

```typescript
// With Cell.of() - use .get() to access the value
const firstName = Cell.of("Alice");
const lastName = Cell.of("Smith");
const fullName = computed(() => `${firstName.get()} ${lastName.get()}`);

// With pattern inputs (no Cell<> in type) - direct access works
// because pattern inputs are OpaqueRef, not Cell
export default pattern<{ user: { first: string; last: string } }>(({ user }) => {
  const greeting = computed(() => `Hello, ${user.first} ${user.last}!`);
  return { [UI]: <div>{greeting}</div> };
});
```

### Never Nest computed()

There is never a reason to nest `computed()` calls. The inner `computed()` returns a cell reference, not a value, which breaks reactivity:

```typescript
// ❌ WRONG - never nest computed()
const value = computed(() => 123 + computed(() => myCell.get() * 2));

// ✅ CORRECT - declare separately
const doubled = computed(() => myCell.get() * 2);
const value = computed(() => 123 + doubled);
```

### When to Use computed()

Use `computed()` **outside of JSX** for reactive transformations:

```typescript
// ✅ Use computed() outside JSX
// (assuming items, searchQuery, groupedItems are pattern inputs - OpaqueRef)
const filteredItems = computed(() => {
  return items.filter(item => item.title.toLowerCase().includes(searchQuery.toLowerCase()));
});

const itemCount = computed(() => items.length);

const categories = computed(() => Object.keys(groupedItems).sort());

// Then use the computed values in JSX
return {
  [UI]: (
    <div>
      <div>Total: {itemCount}</div>
      {filteredItems.map(item => <div>{item.title}</div>)}
      {categories.map(cat => <h3>{cat}</h3>)}
    </div>
  ),
};
```

### When NOT to Use computed()

**Within JSX, reactivity is automatic—you don't need `computed()`:**

```typescript
// ❌ Don't use computed() in JSX
<div>
  {computed(() => `Hello, ${userName}`)}  // Unnecessary!
</div>

// ✅ Just reference directly
<div>
  Hello, {userName}
</div>

// ❌ Don't use computed() for simple property access
<div>
  {computed(() => user.name)}  // Unnecessary!
</div>

// ✅ Direct access works fine
<div>
  {user.name}
</div>
```

### Side Effects in computed()

If your `computed()` has side effects (like setting another cell), they should be idempotent. Non-idempotent side effects cause the scheduler to re-run repeatedly until it hits the 101-iteration limit.

```typescript
// ❌ Non-idempotent - appends on every run
const badComputed = computed(() => {
  const current = logArray.get();
  logArray.set([...current, { timestamp: Date.now() }]);  // Grows forever
  return items.length;
});

// ✅ Idempotent - check-before-write with deterministic key
const goodComputed = computed(() => {
  const current = cacheMap.get();
  const key = `items-${items.length}`;
  if (!(key in current)) {
    cacheMap.set({ ...current, [key]: Date.now() });
  }
  return items.length;
});
```

The scheduler re-runs computations when their dependencies change. If a computation modifies a cell it depends on, it triggers itself. With idempotent operations, the second run produces no change, so the system settles.

Prefer using handlers for mutations instead of side effects in `computed()`.

### Complex Transformations

For complex data transformations, use `computed()` to avoid recomputing on every render:

```typescript
// Group items by category
const groupedItems = computed(() => {
  const groups: Record<string, Item[]> = {};

  for (const item of items) {
    const category = item.category || "Uncategorized";
    if (!groups[category]) {
      groups[category] = [];
    }
    groups[category].push(item);
  }

  return groups;
});

// Then use direct property access
{categories.map((category) => (
  <div>
    <h3>{category}</h3>
    {(groupedItems[category] ?? []).map((item) => (
      <div>{item.title}</div>
    ))}
  </div>
))}
```

### Direct Property Access on Computed Objects

You can access properties directly on computed objects:

```typescript
const data = computed(() => ({
  users: [...],
  posts: [...],
  config: {...}
}));

// ✅ Direct property access works
<div>{data.users.length} users</div>
<div>Theme: {data.config.theme}</div>

// ✅ Can nest property access
{data.users.map(user => (
  <div>{user.name}</div>
))}
```

## Reactivity in Different Contexts

### 1. In Recipe Bodies

Everything is reactive by default:

```typescript
export default pattern(({ count, items, user }) => {
  // These are all reactive references, not actual values
  const doubled = computed(() => count * 2);
  const userName = user.name;  // Reactive reference to user.name

  return {
    [UI]: (
      <div>
        {count}           {/* Updates automatically */}
        {doubled}         {/* Updates when count changes */}
        {userName}        {/* Updates when user.name changes */}
        {items.length}    {/* Updates when items change */}
      </div>
    ),
  };
});
```

### 2. In JSX

Reactivity is completely automatic:

```typescript
// ✅ All of these are reactive
<div>
  {count}
  {count > 10 ? "High" : "Low"}
  {items.length}
  {user.name}
  {items.map(item => <div>{item.title}</div>)}
</div>
```

### 3. In Inline Handlers

When working with `Writable<T>` types (whether passed as inputs or created with `Cell.of()`), you need to explicitly get/set values:

```typescript
// ✅ Use .get() to read, .set() to write when you have Writable<T>
<ct-button onClick={() => {
  const current = count.get();  // Read current value
  count.set(current + 1);       // Write new value
}}>
  Increment
</ct-button>

// ✅ For arrays - if items is Writable<T[]>
<ct-button onClick={() => {
  items.push({ title: "New", done: false });
}}>
  Add
</ct-button>
```

**Key point:** If the type is `Writable<T>` (whether from a pattern input parameter or created locally with `Cell.of()`), you need `.get()` to unwrap the value. The method of creation doesn't matter - what matters is the type.

### 4. In handler() Functions

Same as inline handlers—when the type is `Writable<T>`, use explicit get/set:

```typescript
const increment = handler<never, { count: Writable<number> }>(
  (_, { count }) => {
    // count is Writable<number>, so .get() is required
    count.set(count.get() + 1);
  }
);
```

**Remember:** Whether a cell was passed in as an input or created locally with `Writable.of()`, if the type is `Writable<T>`, you use `.get()` to read its value. This is true everywhere—in `computed()`, handlers, JSX, or any other context. Access patterns are determined by the **type**, not the calling context.

### 5. In computed() Functions

Read reactive values directly (they're tracked automatically):

```typescript
const summary = computed(() => {
  // Direct access - automatically tracked as dependencies
  const total = items.length;
  const done = items.filter(item => item.done).length;
  return `${done} of ${total} complete`;
});
```

## Common Reactive Patterns

### Pattern: Search/Filter

```typescript
const searchQuery = Cell.of("");

// searchQuery is Cell<string>, so use .get()
// items is a pattern input (OpaqueRef), so direct access works
const filteredItems = computed(() => {
  const query = searchQuery.get().toLowerCase();
  return items.filter(item =>
    item.title.toLowerCase().includes(query)
  );
});

return {
  [UI]: (
    <div>
      <ct-input $value={searchQuery} placeholder="Search..." />
      {filteredItems.map(item => <div>{item.title}</div>)}
    </div>
  ),
};
```

### Pattern: Derived Statistics

```typescript
const stats = computed(() => ({
  total: items.length,
  completed: items.filter(item => item.done).length,
  pending: items.filter(item => !item.done).length,
  completionRate: items.length > 0
    ? (items.filter(item => item.done).length / items.length) * 100
    : 0,
}));

<div>
  <div>Total: {stats.total}</div>
  <div>Done: {stats.completed}</div>
  <div>Remaining: {stats.pending}</div>
  <div>Progress: {stats.completionRate.toFixed(1)}%</div>
</div>
```

### Pattern: Grouped/Categorized Views

```typescript
const groupedItems = computed(() => {
  const groups: Record<string, Item[]> = {};
  for (const item of items) {
    const cat = item.category || "Uncategorized";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(item);
  }
  return groups;
});

const categories = computed(() => Object.keys(groupedItems).sort());

{categories.map(category => (
  <div>
    <h3>{category}</h3>
    {(groupedItems[category] ?? []).map(item => (
      <div>{item.title}</div>
    ))}
  </div>
))}
```

### Pattern: Conditional Values

Use `ifElse()` for conditional logic in reactive contexts:

```typescript
// ✅ Use ifElse for conditional rendering
const message = ifElse(
  user.isLoggedIn,
  str`Welcome back, ${user.name}!`,
  "Please log in"
);

<div>{message}</div>

// ✅ Use ifElse in data transformations
const processedItems = items.map(item =>
  ifElse(
    item.isValid,
    () => processItem(item),
    () => ({ ...item, error: "Invalid" })
  )
);
```

## Variable Scoping in Reactive Contexts

### The Scoping Limitation

Variables from outer scopes don't work inside nested reactive contexts like `computed()`:

```typescript
// ❌ DOESN'T WORK - Can't access `category` from outer scope
{categories.map((category) => (
  <div>
    {computed(() =>
      items.filter(i => i.category === category)  // category not accessible!
    )}
  </div>
))}

// ✅ WORKS - Pre-compute grouped data
const groupedItems = computed(() => {
  const groups: Record<string, Item[]> = {};
  for (const item of items) {
    if (!groups[item.category]) groups[item.category] = [];
    groups[item.category].push(item);
  }
  return groups;
});

{categories.map((category) => (
  <div>
    {(groupedItems[category] ?? []).map(item => (
      <div>{item.title}</div>
    ))}
  </div>
))}
```

### lift() and Closure Limitations

While `computed()` handles closures automatically through CTS transformation, the lower-level `lift()` function requires explicit parameter passing for all reactive dependencies.

**Note on terminology:** You may see "opaque ref" in error messages or low-level code. This is an implementation detail (JavaScript Proxy objects used for reactive tracking). As a pattern developer, think "reactive reference" - values that automatically track dependencies and update when changed.

**Why this matters:** The reactive graph builder uses frame-based execution contexts. Each `lift()` creates a new frame, and cells from different frames cannot be accessed via closure.

**Common mistake - passing cells directly:**

```typescript
// ❌ WRONG - Passing cell as direct argument (returns stale/empty data!)
const calcTotal = lift((expenses: Expense[]): number => {
  return expenses.reduce((sum, e) => sum + e.amount, 0);
});
const total = calcTotal(expenses);  // Returns 0 even when expenses has data

// ✅ CORRECT - Always use object parameter pattern
const calcTotal = lift((args: { expenses: Expense[] }): number => {
  return args.expenses.reduce((sum, e) => sum + e.amount, 0);
});
const total = calcTotal({ expenses });  // Works correctly
```

**Closure over reactive values also fails:**

```typescript
// ❌ WRONG - Closing over reactive value from outer scope
const date = Cell.of("2024-01-15");
const grouped = computed(() => { /* ... */ });

// This FAILS at runtime: "Reactive reference from outer scope cannot be accessed via closure"
const result = lift((g) => g[date])(grouped);

// ✅ CORRECT - Pass all reactive dependencies as parameters
const result = lift((args) => args.g[args.d])({ g: grouped, d: date });
```

**When you see these symptoms:**
- **Stale/empty data:** `lift()` returns 0, `{}`, or old values → Pass cells via object parameter
- **Error:** `"Reactive reference from outer scope cannot be accessed via closure"` → Pass closed-over cells as parameters
- **Fix for both:** Use `lift((args: { ... }) => ...)({ cell1, cell2 })` pattern

**Why computed() doesn't have this issue:**

The `/// <cts-enable />` transformer automatically extracts closures from `computed()` functions and rewrites them with explicit parameter passing. This is why `computed()` is the recommended API for patterns.

```typescript
// computed() handles this automatically
const result = computed(() => grouped[date]);  // Just works!

// lift() requires manual parameter passing
const result = lift((args) => args.g[args.d])({ g: grouped, d: date });
```

**Best practice:** Use `computed()` in patterns. Only use `lift()` if you're working with lower-level reactive graph construction where you need explicit control over the computation structure.

## Cell.for() - Advanced Cell Creation

`Cell.for(cause)` is for creating cells in reactive contexts (rarely needed):

```typescript
// Typically used as Cell.for(cause).set(value)
// Sets the cell to that value on EVERY reactive change
// Different from .of(): .of() sets only the initial value
```

This is an advanced feature primarily used internally. Most patterns should use `Cell.of()`.

## Reactive String Templates

Use the `str` template literal to create reactive strings:

```typescript
const greeting = str`Hello, ${user.name}! You have ${notifications.count} new messages.`;

// Updates automatically when user.name or notifications.count changes
<div>{greeting}</div>
```

## Performance Considerations

### When to Optimize

Don't optimize prematurely! Most patterns perform well without optimization. Consider optimizing when:

- Lists have 100+ items and feel sluggish
- Expensive calculations on every render
- Notice UI lag during interactions

### Common Optimizations

**1. Compute only what you need:**

```typescript
// ❌ AVOID - Computing entire sorted list when you only need count
const sortedItems = computed(() => items.toSorted((a, b) => a.priority - b.priority));
const itemCount = computed(() => sortedItems.length);

// ✅ BETTER - Compute just the count
const itemCount = computed(() => items.length);
```

**2. Inline expressions for simple operations:**

```typescript
// ✅ PREFERRED - Inline is clear and concise
{(groupedItems[category] ?? []).map(item => ...)}

// ❌ AVOID - Unnecessary intermediate variable
const categoryItems = computed(() => groupedItems[category] ?? []);
{categoryItems.map(item => ...)}
```

**3. Reuse computed values:**

```typescript
// ✅ GOOD - Compute once, use multiple times
const sortedItems = computed(() =>
  items.toSorted((a, b) => a.priority - b.priority)
);

<div>Count: {sortedItems.length}</div>
<div>{sortedItems.map(...)}</div>
```

## Debugging Reactivity Issues

### Issue: Value Not Updating

**Check 1: Is it wrapped in computed() outside JSX?**

The limitation: **inline filtering/transformations in JSX won't update reactively**. You CAN and SHOULD map over `computed()` results - this is the recommended pattern.

```typescript
// ❌ WRONG: Inline filtering in JSX doesn't create reactive dependency
{items.filter(item => !item.done).map(...)}

// ✅ CORRECT: Use computed() outside JSX, then map over the result
const activeItems = computed(() => items.filter(item => !item.done));
{activeItems.map(...)}  // Mapping over computed() works perfectly!
```

**Check 2: Using ternary in JSX (attributes are fine)?**

```typescript
// ✅ Ternaries work in attributes
<span style={item.done ? { textDecoration: "line-through" } : {}}>

// ❌ Don't use for conditional rendering
{showDetails ? <div>Details</div> : null}

// ✅ Use ifElse for conditional rendering
{ifElse(showDetails, <div>Details</div>, null)}
```

**Check 3: Missing $ prefix for bidirectional binding?**

```typescript
// ❌ Missing $ - not bidirectional
<ct-checkbox checked={item.done} />

// ✅ With $ - bidirectional
<ct-checkbox $checked={item.done} />
```

## Summary

**Key Takeaways:**

1. **Writable<> = Write Permission** - Only use in signatures when you need `.set()`, `.update()`, `.push()`
2. **Everything is Reactive** - Whether you use `Writable<>` or not, values update automatically
3. **computed() Outside JSX** - Use for data transformations; inside JSX, reactivity is automatic
4. **Direct Property Access** - Works fine on computed objects
5. **Get/Set in Handlers** - Use `.get()` to read, `.set()` to write inside handlers
6. **ifElse for Conditionals** - Use instead of ternaries for conditional rendering/data transforms
