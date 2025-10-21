# Common Recipe Patterns

This guide demonstrates common patterns for building recipes, organized by complexity. Each pattern builds on concepts from previous sections.

## 🌟 Golden Rule: Prefer Bidirectional Binding

**Before writing any handler, ask yourself**: "Am I just syncing UI ↔ data with no additional logic?"

If yes, use bidirectional binding:

```typescript
// ✅ SIMPLE - Just syncing UI and data (no handler needed!)
<ct-checkbox $checked={item.done} />
<ct-input $value={item.name} />
<ct-select $value={item.category} items={[...]} />
```

Only use handlers when you need:
- **Side effects** (logging, API calls)
- **Validation logic**
- **Structural changes** (add/remove from arrays)

**This is the most important pattern to learn.** Most of your UI updates will use bidirectional binding, not handlers.

### Quick Decision Guide

```typescript
// Simple checkbox toggle?
<ct-checkbox $checked={item.done} />  // ✅ Bidirectional binding

// Simple text input?
<ct-input $value={item.title} />  // ✅ Bidirectional binding

// Add item to array?
const addItem = handler(/* ... */);  // ❌ Need handler
<ct-button onClick={addItem({ items })}>Add</ct-button>

// Need validation or API call?
const saveWithValidation = handler(/* ... */);  // ❌ Need handler
<ct-button onClick={saveWithValidation({ item })}>Save</ct-button>
```

See `COMPONENTS.md` for detailed bidirectional binding documentation.

---

## Level 1: Basic List with Bidirectional Binding

The simplest and most common pattern: a list where users can check items and edit properties.

**Key Concepts:**
- Bidirectional binding with `$checked` and `$value`
- `OpaqueRef<T>` type annotation in `.map()`
- Simple add/remove operations with handlers

```typescript
/// <cts-enable />
import { Cell, Default, handler, NAME, OpaqueRef, recipe, UI, cell } from "commontools";

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

## Level 4: Pattern Composition with ct-render

When you want to display multiple patterns together that share the same data **within a single recipe** (without deploying separate charms), use pattern composition.

**Key Concept**: Use `$cell={pattern}` not `charm={pattern}` to render composed patterns.

```typescript
/// <cts-enable />
import { recipe, UI, NAME, Default, OpaqueRef } from "commontools";
import ShoppingList from "./shopping-list.tsx";
import ShoppingListByCategory from "./shopping-list-by-category.tsx";

interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
  category: Default<string, "Uncategorized">;
}

interface ComposedInput {
  items: Default<ShoppingItem[], []>;
}

export default recipe<ComposedInput, ComposedInput>(
  "Shopping List - Both Views",
  ({ items }) => {
    // Create pattern instances that share the same items cell
    const basicView = ShoppingList({ items });
    const categoryView = ShoppingListByCategory({ items });

    return {
      [NAME]: "Shopping List - Both Views",
      [UI]: (
        <div style={{ display: "flex", gap: "2rem" }}>
          {/* ✅ CORRECT - Use $cell not charm */}
          <div style={{ flex: 1 }}>
            <h3>Basic View</h3>
            <ct-render $cell={basicView} />
          </div>
          <div style={{ flex: 1 }}>
            <h3>By Category</h3>
            <ct-render $cell={categoryView} />
          </div>
        </div>
      ),
      items, // Export shared data
    };
  },
);
```

**What to notice:**
- ✅ `ShoppingList({ items })` creates a pattern instance (a cell containing the pattern's output)
- ✅ Both patterns receive the same `items` cell reference
- ✅ `<ct-render $cell={basicView} />` - note the `$cell` attribute
- ✅ Changes in one view automatically update the other (they share the same cell)
- ✅ No charm deployment needed - all composed within one recipe
- ❌ Don't use `charm={...}` or `pattern={...}` - use `$cell={...}`

**Common mistakes:**

```typescript
// ❌ WRONG - Using charm attribute doesn't work
<ct-render charm={basicView} />

// ❌ WRONG - Using pattern attribute doesn't work
<ct-render pattern={basicView} />

// ✅ CORRECT - Use $cell for bidirectional binding
<ct-render $cell={basicView} />
```

**When to use Pattern Composition vs Linked Charms:**

| Scenario | Use |
|----------|-----|
| Multiple views of same data in one UI | Pattern Composition (Level 4) |
| Independent charms with data flow | Linked Charms (Level 3) |
| Reusable components within a recipe | Pattern Composition (Level 4) |
| Separate deployments that communicate | Linked Charms (Level 3) |

See `packages/patterns/ct-render.tsx` for a working example and `COMPONENTS.md` for ct-render API details.

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

### Common Pitfalls from Pattern Development

These are the most frequent mistakes developers make when building patterns:

#### 1. Using `charm` Instead of `$cell` with ct-render

**This is the #1 most common mistake with pattern composition.**

```typescript
// ❌ WRONG - Using charm attribute doesn't work
<ct-render charm={myPattern} />

// ❌ WRONG - Using pattern attribute doesn't work
<ct-render pattern={myPattern} />

// ✅ CORRECT - Use $cell attribute
<ct-render $cell={myPattern} />
```

**Why this happens:** The `ct-render` component requires the `$cell` attribute for bidirectional binding with pattern instances. Without it, the pattern won't render or update properly.

**When you'll see this:** When composing multiple patterns together in a single recipe.

#### 2. Forgetting Type Annotations in .map()

```typescript
// ❌ WRONG - Missing type annotation
{items.map((item) => (
  <ct-checkbox $checked={item.done} />
  // Error: Property 'done' does not exist on type 'OpaqueRef<unknown>'
))}

// ✅ CORRECT - Add type annotation
{items.map((item: OpaqueRef<ShoppingItem>) => (
  <ct-checkbox $checked={item.done} />
))}
```

**Why this happens:** TypeScript can't infer the type of items in a Cell array. You must explicitly annotate the parameter with `OpaqueRef<YourType>`.

**When to add it:** Always, in every `.map()` call on a Cell array in JSX.

#### 3. Mixing Style Syntax (String vs Object)

```typescript
// ❌ WRONG - String style on HTML element
<div style="flex: 1;">
  {/* TypeScript error: Type 'string' not assignable to 'CSSProperties' */}
</div>

// ✅ CORRECT - Object style on HTML element
<div style={{ flex: 1 }}>
  {/* Works! */}
</div>

// ❌ WRONG - Object style on custom element
<common-hstack style={{ flex: 1 }}>
  {/* Error */}
</common-hstack>

// ✅ CORRECT - String style on custom element
<common-hstack style="flex: 1;">
  {/* Works! */}
</common-hstack>
```

**Rule:** HTML elements use object styles, custom elements use string styles. See "Styling: String vs Object Syntax" in `COMPONENTS.md` for details.

#### 4. Using Handlers Instead of Bidirectional Binding

```typescript
// ❌ AVOID - Unnecessary handler for simple toggle
const toggleDone = handler<unknown, { item: Cell<Item> }>(
  (_, { item }) => {
    const current = item.get();
    item.set({ ...current, done: !current.done });
  }
);
<ct-checkbox checked={item.done} onChange={toggleDone({ item })} />

// ✅ PREFERRED - Bidirectional binding handles it
<ct-checkbox $checked={item.done} />
```

**Why this is a pitfall:** Writing unnecessary code that the framework handles automatically.

**Remember:** If you're just syncing UI ↔ data, use `$` binding. Only use handlers for side effects, validation, or structural changes.

#### 5. Trying to Use [ID] When You Don't Need It

```typescript
// ❌ UNNECESSARY - [ID] not needed for basic lists
import { ID } from "commontools";

interface TodoItem {
  [ID]: number;  // Don't add this unless you actually need it
  title: string;
  done: boolean;
}

// ✅ CORRECT - Simple items don't need [ID]
interface TodoItem {
  title: string;
  done: boolean;
}
```

**When you DON'T need [ID]:**
- Simple arrays of objects in your recipe
- Items only displayed, not referenced elsewhere
- Most basic CRUD operations

**When you DO need [ID]:**
- Creating data URIs for items (stable references across network)
- Creating referenceable data from within a `lift` function
- Stable identity for items that might be modified

See RECIPES.md for detailed [ID] guidance.

#### 6. Incorrect Handler Type Parameters

```typescript
// ❌ WRONG - Nested Cell types
const addItem = handler<
  unknown,
  { items: Cell<Array<Cell<ShoppingItem>>> }
>(/* ... */);

// ❌ WRONG - OpaqueRef in handler parameters
const addItem = handler<
  unknown,
  { items: Cell<OpaqueRef<ShoppingItem>[]> }
>(/* ... */);

// ✅ CORRECT - Cell<T[]>
const addItem = handler<
  unknown,
  { items: Cell<ShoppingItem[]> }
>((_event, { items }) => {
  const arr = items.get();  // arr is ShoppingItem[]
  items.set([...arr, { title: "New", done: false }]);
});
```

**Rule:** Always use `Cell<T[]>` in handler parameters. The Cell wraps the entire array.

## Testing Patterns and Development Workflow

### Quick Development Workflow

When developing patterns, follow this efficient iteration cycle:

**1. Start Simple (5-10 minutes)**
```typescript
// Begin with minimal viable pattern
interface ShoppingItem {
  title: string;
}

export default recipe<{ items: Default<ShoppingItem[], []> }, any>(
  "Shopping List",
  ({ items }) => ({
    [NAME]: "Shopping List",
    [UI]: (
      <div>
        {items.map((item: OpaqueRef<ShoppingItem>) => (
          <div>{item.title}</div>
        ))}
      </div>
    ),
    items,
  })
);
```

**2. Test Locally (2 minutes)**
```bash
./dist/ct dev my-pattern.tsx
```

Fix any syntax errors before continuing.

**3. Add Interactivity (10-15 minutes)**

Add one feature at a time:
```typescript
// First: Add bidirectional binding
<ct-checkbox $checked={item.done}>

// Then: Add handlers for structural changes
const removeItem = handler(/* ... */);
```

**4. Deploy and Test (3-5 minutes)**
```bash
# Deploy
./dist/ct charm new --identity key.json --api-url ... --space test pattern.tsx
# Returns: pattern-charm-id

# Test with real data
echo '{"title": "Test", "done": false}' | \
  ./dist/ct charm set --identity key.json --api-url ... \
  --space test --charm pattern-charm-id testItem
```

**5. Iterate Quickly (1-2 minutes per iteration)**
```bash
# Update existing charm (much faster than creating new)
./dist/ct charm setsrc --identity key.json --api-url ... \
  --space test --charm pattern-charm-id pattern.tsx
```

### Testing Commands Reference

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

### Tips for Fast Iteration

- ✅ Use `ct dev` first to catch TypeScript errors
- ✅ Deploy once, then use `setsrc` for updates
- ✅ Test one feature at a time
- ✅ Use `charm inspect` to debug data issues
- ❌ Don't deploy a new charm for every change
- ❌ Don't add multiple features before testing

### Debugging Checklist

When something doesn't work:

1. **Check the console** - Look for TypeScript errors
2. **Inspect the data** - Use `charm inspect` to see current state
3. **Simplify** - Comment out code until it works, then add back gradually
4. **Check types** - Most errors are type-related (OpaqueRef, Cell, style syntax)
5. **Verify bindings** - Did you use `$` prefix for bidirectional binding?
6. **Review common pitfalls** - Check the list above

## TypeScript Quick Reference

Understanding TypeScript typing in patterns is crucial for avoiding common errors.

### Type Annotations in .map()

**The Rule**: Always annotate the item parameter when using `.map()` on a Cell array in JSX.

```typescript
interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
}

// ❌ WRONG - TypeScript can't infer the type
{items.map((item) => (
  <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
  // Error: Property 'done' does not exist on type 'OpaqueRef<unknown>'
))}

// ✅ CORRECT - Explicit type annotation
{items.map((item: OpaqueRef<ShoppingItem>) => (
  <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
))}

// ✅ CORRECT - With index parameter
{items.map((item: OpaqueRef<ShoppingItem>, index: number) => (
  <div>
    <span>{index + 1}. {item.title}</span>
    <ct-button onClick={removeItem({ items, index })}>Remove</ct-button>
  </div>
))}
```

### Why OpaqueRef?

Items in `.map()` are wrapped as `OpaqueRef<T>` to maintain their connection to the Cell system. This enables:
- **Bidirectional binding** (`$checked`, `$value`)
- **Reactive updates** when the item changes
- **Type-safe property access**

### Common Type Errors and Solutions

**Error**: "Property 'X' does not exist on type 'OpaqueRef<unknown>'"

```typescript
// ❌ Problem: Missing type annotation
{items.map((item) => <span>{item.name}</span>)}

// ✅ Solution: Add OpaqueRef<YourType>
{items.map((item: OpaqueRef<ShoppingItem>) => <span>{item.title}</span>)}
```

**Error**: "Type 'OpaqueRef<ShoppingItem>' is not assignable to type 'Cell<boolean>'"

```typescript
// ❌ Problem: Trying to bind the whole item
<ct-checkbox $checked={item} />

// ✅ Solution: Bind the specific property
<ct-checkbox $checked={item.done} />
```

### Handler Type Parameters

**Critical Rule**: In handler type signatures, always use `Cell<T[]>` for array parameters, never `Cell<Array<Cell<T>>>`.

```typescript
// ✅ CORRECT - Cell wraps the entire array
const addItem = handler<
  unknown,
  { items: Cell<ShoppingItem[]> }  // ← Cell<ShoppingItem[]>
>((_event, { items }) => {
  const currentItems = items.get();  // Returns ShoppingItem[]
  items.set([...currentItems, { title: "New", done: false }]);
});

// ❌ WRONG - Don't use nested Cell types
const addItem = handler<
  unknown,
  { items: Cell<Array<Cell<ShoppingItem>>> }  // ← Confusing and wrong!
>(/* ... */);

// ❌ WRONG - Don't use OpaqueRef in handler parameters
const addItem = handler<
  unknown,
  { items: Cell<OpaqueRef<ShoppingItem>[]> }  // ← Wrong!
>(/* ... */);
```

### Understanding the Type Contexts

There are three different contexts where types appear:

```typescript
interface ShoppingItem {
  title: string;
  done: Default<boolean, false>;
}

// 1. In recipe parameters: Cell<ShoppingItem[]>
export default recipe<{ items: Default<ShoppingItem[], []> }, any>(
  "Shopping List",
  ({ items }) => {  // items is Cell<ShoppingItem[]>

    // 2. In handler parameters: Cell<ShoppingItem[]>
    const addItem = handler<
      unknown,
      { items: Cell<ShoppingItem[]> }  // ← Cell<ShoppingItem[]>
    >((_event, { items }) => {
      const arr = items.get();  // arr is ShoppingItem[]
      items.set([...arr, { title: "New", done: false }]);
    });

    return {
      [UI]: (
        <div>
          {/* 3. In JSX .map(): OpaqueRef<ShoppingItem> */}
          {items.map((item: OpaqueRef<ShoppingItem>) => (
            <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
          ))}
        </div>
      ),
      items,  // 4. In recipe returns: Cell<ShoppingItem[]>
    };
  },
);
```

### Mental Model

Think of it this way:
- **Cell<T[]>**: A box containing an array (handler params, recipe params, returns)
- **T[]**: The plain array inside the box (result of `.get()`)
- **OpaqueRef<T>**: A cell-like reference to each item (in JSX `.map()`)

### Style Attribute Types

Remember: HTML elements use object syntax, custom elements use string syntax.

```typescript
// ✅ HTML elements - Object syntax
<div style={{ flex: 1, padding: "1rem" }} />
<span style={{ color: "red", fontWeight: "bold" }} />

// ✅ Custom elements - String syntax
<common-hstack style="flex: 1; padding: 1rem;" />
<ct-card style="border: 1px solid #ccc;" />

// ❌ Common mistake
<div style="flex: 1;" />  // Error: Type 'string' not assignable to 'CSSProperties'
```

See "Styling: String vs Object Syntax" in `COMPONENTS.md` for details.

### Direct Property Access on Derived Objects

When you derive an object (not an array), you can access its properties directly:

```typescript
const groupedItems = derive(items, (list) => {
  const groups: Record<string, ShoppingItem[]> = {};
  for (const item of list) {
    const category = item.category || "Uncategorized";
    if (!groups[category]) groups[category] = [];
    groups[category].push(item);
  }
  return groups;
});

const categories = derive(groupedItems, (groups) => Object.keys(groups).sort());

// ✅ Direct property access with inline null coalescing
{categories.map((category) => (
  <div>
    <h3>{category}</h3>
    {(groupedItems[category] ?? []).map((item: OpaqueRef<ShoppingItem>) => (
      <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
    ))}
  </div>
))}
```

**What to notice:**
- ✅ `groupedItems[category]` - direct property access works on derived objects
- ✅ `(groupedItems[category] ?? [])` - inline null coalescing for safety
- ✅ No intermediate `derive` needed for simple property access
- ✅ Type annotation `OpaqueRef<ShoppingItem>` required in inner map

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

**Level 4 patterns:**
- Pattern composition with ct-render
- Multiple views in single recipe
- Shared cell references between patterns

**Key principles:**
1. Use bidirectional binding when possible
2. Use handlers for side effects and structural changes
3. Use `derive()` for reactive transformations
4. Keep it simple - don't over-engineer
5. Test incrementally with `ct dev` and `charm setsrc`
