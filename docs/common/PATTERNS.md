# Common Recipe Patterns

This guide demonstrates common patterns for building recipes, organized by complexity. Each pattern builds on concepts from previous sections.

## Level 1: Basic List with Bidirectional Binding

The simplest and most common pattern: a list where users can check items and edit properties.

**Key Concepts:**
- Bidirectional binding with `$checked` and `$value`
- `OpaqueRef<T>` type annotation in `.map()`
- Simple add/remove operations with handlers

```typescript
/// <cts-enable />
import { Cell, Default, handler, NAME, OpaqueRef, recipe, UI } from "commontools";

interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
}

interface ShoppingListInput {
  items: Default<ShoppingItem[], []>;
}

interface ShoppingListOutput extends ShoppingListInput {}

const addItem = handler<
  { detail: { message: string } },
  { items: Cell<ShoppingItem[]> }
>(({ detail }, { items }) => {
  const itemName = detail?.message?.trim();
  if (!itemName) return;

  const currentItems = items.get();
  items.set([...currentItems, { title: itemName, done: false }]);
});

const removeItem = handler<
  unknown,
  { items: Cell<ShoppingItem[]>; index: number }
>((_event, { items, index }) => {
  const currentItems = items.get();
  items.set(currentItems.toSpliced(index, 1));
});

export default recipe<ShoppingListInput, ShoppingListOutput>(
  "Shopping List",
  ({ items }) => {
    return {
      [NAME]: "Shopping List",
      [UI]: (
        <div>
          <h2>Shopping List</h2>
          <div>
            {items.map((item: OpaqueRef<ShoppingItem>, index) => (
              <div style="display: flex; gap: 8px; align-items: center;">
                <ct-checkbox $checked={item.done}>
                  <span style={item.done ? "text-decoration: line-through;" : ""}>
                    {item.title}
                  </span>
                </ct-checkbox>
                <ct-button onClick={removeItem({ items, index })}>×</ct-button>
              </div>
            ))}
          </div>

          <ct-message-input
            placeholder="Add item..."
            onct-send={addItem({ items })}
          />
        </div>
      ),
      items,
    };
  },
);
```

**What to notice:**
- ✅ `$checked` automatically updates `item.done` - no handler needed
- ✅ Ternary operator in `style` attribute works fine
- ✅ `OpaqueRef<ShoppingItem>` type annotation on map parameter
- ✅ Handlers only for structural changes (add/remove)

## Level 2: Filtered and Grouped Views

Adding derived data transformations to create multiple views of the same data.

**Key Concepts:**
- Using `derive()` for data transformations
- Direct property access on derived objects with `groupedItems[category]`
- Inline expressions like `(array ?? []).map(...)`

```typescript
/// <cts-enable />
import { Default, derive, NAME, OpaqueRef, recipe, UI } from "commontools";

interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
  category: Default<string, "Uncategorized">;
}

interface CategorizedListInput {
  items: Default<ShoppingItem[], []>;
}

interface CategorizedListOutput extends CategorizedListInput {}

export default recipe<CategorizedListInput, CategorizedListOutput>(
  "Shopping List (Categorized)",
  ({ items }) => {
    // Group items by category using derive
    const groupedItems = derive(items, (itemsList) => {
      const groups: Record<string, ShoppingItem[]> = {};

      for (const item of itemsList) {
        const category = item.category || "Uncategorized";
        if (!groups[category]) {
          groups[category] = [];
        }
        groups[category].push(item);
      }

      return groups;
    });

    // Get sorted category names
    const categories = derive(groupedItems, (groups) => {
      return Object.keys(groups).sort();
    });

    return {
      [NAME]: "Shopping List (by Category)",
      [UI]: (
        <div>
          <h2>Shopping List by Category</h2>
          {categories.map((category) => (
            <div style="margin-bottom: 1rem;">
              <h3>{category}</h3>
              {(groupedItems[category] ?? []).map((item: OpaqueRef<ShoppingItem>) => (
                <ct-checkbox $checked={item.done}>
                  <span style={item.done ? "text-decoration: line-through;" : ""}>
                    {item.title}
                  </span>
                </ct-checkbox>
              ))}
            </div>
          ))}
        </div>
      ),
      items,
    };
  },
);
```

**What to notice:**
- ✅ `derive()` creates reactive transformations
- ✅ `groupedItems[category]` - direct property access on derived object
- ✅ `(groupedItems[category] ?? [])` - inline null coalescing instead of intermediate variable
- ✅ Multiple views of same data (categories derived from groupedItems)

## Level 3: Linked Charms (Master-Detail Pattern)

Two separate recipes sharing the same data through charm linking.

**Charm 1: Shopping List Editor**

```typescript
/// <cts-enable />
import { Cell, Default, handler, NAME, OpaqueRef, recipe, UI } from "commontools";

interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
  category: Default<string, "Uncategorized">;
}

interface EditorInput {
  items: Default<ShoppingItem[], []>;
}

interface EditorOutput extends EditorInput {}

const addItem = handler<
  { detail: { message: string } },
  { items: Cell<ShoppingItem[]>; newCategory: Cell<string> }
>(({ detail }, { items, newCategory }) => {
  const itemName = detail?.message?.trim();
  if (!itemName) return;

  const currentItems = items.get();
  items.set([...currentItems, {
    title: itemName,
    done: false,
    category: newCategory.get(),
  }]);
});

export default recipe<EditorInput, EditorOutput>(
  "Shopping List Editor",
  ({ items }) => {
    const newCategory = cell("Uncategorized");

    return {
      [NAME]: "Editor",
      [UI]: (
        <div>
          <h2>Add Items</h2>
          <ct-select
            $value={newCategory}
            items={[
              { label: "Produce", value: "Produce" },
              { label: "Dairy", value: "Dairy" },
              { label: "Meat", value: "Meat" },
              { label: "Other", value: "Uncategorized" },
            ]}
          />
          <ct-message-input
            placeholder="Add item..."
            onct-send={addItem({ items, newCategory })}
          />
        </div>
      ),
      items,
    };
  },
);
```

**Charm 2: Shopping List Viewer (Categorized)**

This would be the Level 2 categorized view from above. When you link them:

```bash
# Deploy both charms
./dist/ct charm new --identity key.json --api-url ... --space myspace editor.tsx
# Returns: editor-charm-id

./dist/ct charm new --identity key.json --api-url ... --space myspace viewer.tsx
# Returns: viewer-charm-id

# Link the items from editor to viewer
./dist/ct charm link --identity key.json --api-url ... --space myspace \
  editor-charm-id/items viewer-charm-id/items
```

**What to notice:**
- ✅ Both charms export `items` in their output
- ✅ Changes in the editor automatically appear in the viewer
- ✅ Charms can be developed and tested independently
- ✅ Data flows through the link connection

## Common Pattern: Search/Filter with Inline Logic

Filtering a list without creating intermediate variables.

```typescript
const searchQuery = cell("");

// Filter items inline
{items
  .filter((item) => {
    const query = searchQuery.get().toLowerCase();
    return item.title.toLowerCase().includes(query);
  })
  .map((item: OpaqueRef<Item>) => (
    <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
  ))
}

// Search input
<ct-input $value={searchQuery} placeholder="Search..." />
```

**Wait, this looks wrong!** The `.filter()` will execute during recipe definition, not reactively. Here's the **correct** way:

```typescript
const searchQuery = cell("");

// ✅ CORRECT - Use derive for reactive filtering
const filteredItems = derive({ items, searchQuery }, ({ items, searchQuery }) => {
  const query = searchQuery.toLowerCase();
  return items.filter((item) => item.title.toLowerCase().includes(query));
});

// Now map over filteredItems
{filteredItems.map((item: OpaqueRef<Item>) => (
  <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
))}

<ct-input $value={searchQuery} placeholder="Search..." />
```

**What to notice:**
- ❌ Can't use `.filter()` directly on cells in JSX
- ✅ Must use `derive()` to create reactive filtered list
- ✅ The derived list updates when `searchQuery` or `items` changes

## Decision Matrix: When to Use What

### Handlers vs Bidirectional Binding

| Scenario | Use |
|----------|-----|
| Toggle checkbox | `$checked` |
| Edit text field | `$value` |
| Select dropdown option | `$value` |
| Add item to array | `handler` |
| Remove item from array | `handler` |
| Reorder items | `handler` |
| Validate input | `handler` or `derive` |
| Call API on change | `handler` |

### derive() vs lift()

| Scenario | Use |
|----------|-----|
| Single transformation of specific cells | `derive(items, fn)` |
| Reusable transformation function | `lift(fn)` |
| Need to call with different inputs | `lift(fn)` |
| Simple one-off calculation | `derive(cells, fn)` |

### Intermediate Variables vs Inline

| Scenario | Use |
|----------|-----|
| Simple property access | Inline: `obj[prop]` |
| Null coalescing | Inline: `(arr ?? [])` |
| Used multiple times | Variable |
| Complex transformation | Variable with `derive` or `lift` |

## Performance Tips

### When to Optimize

Don't optimize prematurely! Most patterns perform well without optimization. Consider optimizing when:

- Lists have 100+ items and feel sluggish
- You're doing expensive calculations on every render
- You notice UI lag during interactions

### Common Optimizations

1. **Limit derived calculations**: Only derive what you need

```typescript
// ❌ AVOID - Deriving entire sorted list when you only need count
const sortedItems = derive(items, (list) => {
  return list.sort((a, b) => a.priority - b.priority);
});
const itemCount = derive(sortedItems, (list) => list.length);

// ✅ BETTER - Derive just the count
const itemCount = derive(items, (list) => list.length);
```

2. **Use index-based removal when you have the index**

```typescript
// ✅ EFFICIENT - Already have the index from map
{items.map((item: OpaqueRef<Item>, index) => (
  <ct-button onClick={removeItem({ items, index })}>×</ct-button>
))}

const removeItem = handler((_, { items, index }) => {
  items.set(items.get().toSpliced(index, 1));
});
```

3. **Avoid creating handlers inside render**

```typescript
// ❌ AVOID - Creates new handler instance for each item
{items.map((item: OpaqueRef<Item>) => {
  const remove = handler(() => { /* ... */ });
  return <ct-button onClick={remove}>×</ct-button>;
})}

// ✅ CORRECT - Handler defined at module level
const removeItem = handler((_, { items, item }) => { /* ... */ });

{items.map((item: OpaqueRef<Item>) => (
  <ct-button onClick={removeItem({ items, item })}>×</ct-button>
))}
```

## Debugging Patterns

### Common Issues and Solutions

**Issue: Bidirectional binding not updating**

```typescript
// ❌ WRONG - Forgot $ prefix
<ct-checkbox checked={item.done} />

// ✅ CORRECT
<ct-checkbox $checked={item.done} />
```

**Issue: Type error with .map()**

```typescript
// ❌ WRONG - Missing type annotation
{items.map((item) => <ct-checkbox $checked={item.done} />)}

// ✅ CORRECT
{items.map((item: OpaqueRef<Item>) => <ct-checkbox $checked={item.done} />)}
```

**Issue: Filtering/sorting not updating**

```typescript
// ❌ WRONG - Direct filter doesn't create reactive node
{items.filter(item => !item.done).map(...)}

// ✅ CORRECT - Use derive
const activeItems = derive(items, (list) => list.filter(item => !item.done));
{activeItems.map(...)}
```

**Issue: Can't access variable from outer map**

```typescript
// ❌ WRONG - category from outer scope not accessible
{categories.map((category) => (
  <div>
    {derive(items, (list) =>
      list.filter(item => item.category === category) // category not accessible!
    )}
  </div>
))}

// ✅ CORRECT - Pre-group the data
const groupedItems = derive(items, (list) => {
  const groups = {};
  for (const item of list) {
    if (!groups[item.category]) groups[item.category] = [];
    groups[item.category].push(item);
  }
  return groups;
});

{categories.map((category) => (
  <div>
    {(groupedItems[category] ?? []).map(...)}
  </div>
))}
```

## Testing Patterns

When testing recipes with `ct dev`:

```bash
# Check syntax only (fast)
./dist/ct dev pattern.tsx --no-run

# Test execution locally
./dist/ct dev pattern.tsx

# Deploy and iterate
./dist/ct charm new --identity key.json --api-url ... --space test pattern.tsx

# Update existing charm (faster for iteration)
./dist/ct charm setsrc --identity key.json --api-url ... --space test \
  --charm charm-id pattern.tsx

# Inspect charm data
./dist/ct charm inspect --identity key.json --api-url ... --space test \
  --charm charm-id

# Get specific field
./dist/ct charm get --identity key.json --api-url ... --space test \
  --charm charm-id items/0/title

# Set test data
echo '{"title": "Test", "done": false}' | \
  ./dist/ct charm set --identity key.json --api-url ... --space test \
  --charm charm-id testItem
```

## Summary

**Level 1 patterns:**
- Bidirectional binding for simple UI updates
- Handlers for structural changes (add/remove)
- `OpaqueRef<T>` type annotations

**Level 2 patterns:**
- `derive()` for data transformations
- Inline expressions for simple operations
- Multiple views of same data

**Level 3 patterns:**
- Charm linking for data sharing
- Master-detail relationships
- Independent development and deployment

**Key principles:**
1. Use bidirectional binding when possible
2. Use handlers for side effects and structural changes
3. Use `derive()` for reactive transformations
4. Keep it simple - don't over-engineer
5. Test incrementally with `ct dev` and `charm setsrc`
