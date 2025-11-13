# Cells and Reactivity Guide

This guide explains CommonTools' reactive system: how cells work, when reactivity is automatic, and how to work with reactive data effectively.

## Core Principle: Cell\<\> is About Write Access, Not Reactivity

**The most important thing to understand:** Everything in CommonTools is reactive by default. The `Cell<>` wrapper in type signatures doesn't enable reactivity—it indicates **write intent**.

### The Rule

- **Use `Cell<T>`** in signatures ONLY when you need write access (`.set()`, `.update()`, `.push()`, `.key()`)
- **Omit `Cell<>`** for read-only access - the framework automatically provides reactive values

```typescript
// ✅ Read-only - No Cell<> needed (still reactive!)
interface ReadOnlyInput {
  count: number;        // Just display it
  items: Item[];        // Just map/display
  userName: string;     // Just show it
}

export default recipe<ReadOnlyInput>(({ count, items, userName }) => {
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

// ✅ Write access - Cell<> required
interface WritableInput {
  count: Cell<number>;  // Will call count.set()
  items: Cell<Item[]>;  // Will call items.push()
  title: Cell<string>;  // Will call title.set()
}

export default recipe<WritableInput>(({ count, items, title }) => {
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

Think of `Cell<>` as a permission declaration:

| Without Cell<> | With Cell<> |
|----------------|-------------|
| "I will only read this value" | "I need to write to this value" |
| Still reactive for display | Can call `.set()`, `.update()`, `.push()` |
| Can pass to `computed()` | Can mutate directly |
| Can use in JSX | Everything read-only can do, plus mutation |

## Cell Basics

### Creating Cells with Cell.of()

Use `Cell.of()` to create NEW reactive cells in your recipe body or return values.

This is rare. Generally prefer to add additional input parameters instead of
creating internal cells.

**When to use Cell.of():**

- Creating new cells inside a recipe that can't be input parameters.
- Creating local state that handlers will mutate

**When NOT to use Cell.of():**

- Input parameters (they're already cells if declared with `Cell<>`)
- Values you won't mutate

```typescript
// ✅ Creating new cells in recipe body
export default recipe(({ inputItems }) => {
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

### Cell Methods

When you have `Cell<>` in your signature (write access), you can use these methods:

```typescript
interface Input {
  count: Cell<number>;
  user: Cell<User>;
  items: Cell<Item[]>;
}

export default recipe<Input>(({ count, user, items }) => {
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
```

### Cell.equals()

Use `Cell.equals()` to compare cells or cell values:

```typescript
// Works with cells or plain values
const isSame = Cell.equals(cell1, cell2);
const isSame = Cell.equals(value1, value2);
const isSame = Cell.equals(cell, value);

// Useful in array operations
const removeItem = (items: Cell<Item[]>, item: Cell<Item>) => {
  const currentItems = items.get();
  const index = currentItems.findIndex(el => Cell.equals(item, el));
  if (index >= 0) {
    items.set(currentItems.toSpliced(index, 1));
  }
};
```

## Reactive Computations with computed()

`computed()` creates reactive derived values that update when their dependencies change.

**Note:** You may see `derive()` in some docs or error messages - it's the same thing as `computed()`. Use `computed()` in your code.

### Basic Usage

```typescript
const firstName = Cell.of("Alice");
const lastName = Cell.of("Smith");

// Automatically updates when firstName or lastName changes
const fullName = computed(() => `${firstName} ${lastName}`);

// Use in JSX
<div>Hello, {fullName}!</div>
```

### When to Use computed()

Use `computed()` **outside of JSX** for reactive transformations:

```typescript
// ✅ Use computed() outside JSX
const filteredItems = computed(() => {
  const query = searchQuery.toLowerCase();
  return items.filter(item => item.title.toLowerCase().includes(query));
});

const itemCount = computed(() => items.length);

const categories = computed(() => {
  return Object.keys(groupedItems).sort();
});

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
export default recipe(({ count, items, user }) => {
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

You need to explicitly get/set values:

```typescript
// ✅ Use .get() to read, .set() to write
<ct-button onClick={() => {
  const current = count.get();  // Read current value
  count.set(current + 1);       // Write new value
}}>
  Increment
</ct-button>

// ✅ For arrays
<ct-button onClick={() => {
  items.push({ title: "New", done: false });
}}>
  Add
</ct-button>
```

### 4. In handler() Functions

Same as inline handlers—explicit get/set:

```typescript
const increment = handler<never, { count: Cell<number> }>(
  (_, { count }) => {
    count.set(count.get() + 1);
  }
);
```

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

// Reactive filtered list
const filteredItems = computed(() => {
  const query = searchQuery.toLowerCase();
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

```typescript
// ❌ Direct filter doesn't create reactive node
{items.filter(item => !item.done).map(...)}

// ✅ Use computed outside JSX
const activeItems = computed(() => items.filter(item => !item.done));
{activeItems.map(...)}
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

1. **Cell<> = Write Permission** - Only use in signatures when you need `.set()`, `.update()`, `.push()`
2. **Everything is Reactive** - Whether you use `Cell<>` or not, values update automatically
3. **computed() Outside JSX** - Use for data transformations; inside JSX, reactivity is automatic
4. **Direct Property Access** - Works fine on computed objects
5. **Get/Set in Handlers** - Use `.get()` to read, `.set()` to write inside handlers
6. **ifElse for Conditionals** - Use instead of ternaries for conditional rendering/data transforms
