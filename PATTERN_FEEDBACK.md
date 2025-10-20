# Pattern Development Feedback

Based on experience building shopping list patterns, here's feedback for improving documentation and examples.

## Key Gaps in Documentation/Examples

### 1. Bidirectional Binding Pattern Needs Prominence

The `$checked` and `$value` pattern for automatic two-way binding is extremely powerful but underemphasized. I initially wrote handlers for every checkbox/input change before learning these props handle updates automatically.

**Recommend:**
- Add a prominent example showing `$checked` and `$value` with array items
- Show the contrast: handler-based updates vs bidirectional binding
- Explain when you DO need handlers (side effects, validation) vs when you don't (simple value updates)

**Example to include:**
```tsx
// ❌ Unnecessary - handler for simple value update
const toggle = handler<{detail: {checked: boolean}}, {item: Cell<Item>}>(
  ({detail}, {item}) => {
    item.set({...item.get(), done: detail.checked});
  }
);
<ct-checkbox checked={item.done} onct-change={toggle({item})} />

// ✅ Preferred - bidirectional binding handles it
<ct-checkbox $checked={item.done} />
```

### 2. OpaqueRef Type Annotation in Maps is Non-Obvious

When using bidirectional binding with `.map()`, you need to add `OpaqueRef<T>` type annotation or it won't type-check:

```tsx
items.map((item: OpaqueRef<ShoppingItem>) => (
  <ct-checkbox $checked={item.done}>
    <span>{item.title}</span>
  </ct-checkbox>
))
```

**Recommend:**
- Document this pattern explicitly
- Add to the TypeScript tips section
- Include in array mapping examples

### 3. When NOT to Use Built-in Components

I initially used `ct-list` but it only supports `{title, done}` schema. There's no clear guidance on when to use built-in components vs manual rendering for custom data structures.

**Recommend:**
- Document the exact schema requirements for `ct-list`, `ct-select`, etc.
- Show an example of manual rendering for custom fields
- Clarify the trade-offs

**Example:**
```tsx
// ct-list requires {title: string, done?: boolean}
interface CtListItem {
  title: string;
  done?: boolean;
}

// For custom fields, render manually:
interface ShoppingItem {
  title: string;
  done: boolean;
  category: string; // ← custom field, can't use ct-list
}

// Manual rendering required:
{items.map((item: OpaqueRef<ShoppingItem>) => (
  <div>
    <ct-checkbox $checked={item.done}>{item.title}</ct-checkbox>
    <ct-input $value={item.category} />
  </div>
))}
```

### 4. Simplify JSX Patterns in Examples

Current examples might over-use `derive()` and `ifElse()`:
- **derive()**: Often unnecessary when accessing reactive values directly
- **ifElse()**: Can be replaced with ternary operators in JSX attributes

**Current pattern (overly complex):**
```tsx
{derive(item, (i) =>
  ifElse(
    i.done,
    <span style="text-decoration: line-through;">
      {i.title}
    </span>,
    <span>{i.title}</span>
  )
)}
```

**Simpler pattern:**
```tsx
<span style={item.done ? "text-decoration: line-through;" : ""}>
  {item.title}
</span>
```

**Recommend:**
- Update examples to show the simpler patterns first
- Reserve `derive()` examples for cases where transformation is actually needed
- Show `ifElse()` primarily for conditional rendering of large blocks, not simple attributes

**When derive() IS needed:**
```tsx
// ✅ Good use - actual transformation
const groupedItems = derive(items, (list) => {
  const groups: Record<string, Item[]> = {};
  for (const item of list) {
    const category = item.category || "Uncategorized";
    if (!groups[category]) groups[category] = [];
    groups[category].push(item);
  }
  return groups;
});
```

### 5. Inline Expressions Over Intermediate Variables

Examples should favor inline expressions like `(array ?? []).map(...)` over extracting to variables first, unless clarity genuinely improves.

**Example:**
```tsx
// ❌ Unnecessary intermediate variable
{derive(groupedItems, (groups) => {
  const categoryItems = groups[category] || [];
  return (
    <div>
      {categoryItems.map(item => ...)}
    </div>
  );
})}

// ✅ Inline expression
<div>
  {(groupedItems[category] ?? []).map(item => ...)}
</div>
```

### 6. Remove Unnecessary Keys

Examples include `key={index}` in maps where it's not needed. This might confuse users about when keys are actually required.

**Recommend:**
- Remove `key` from examples unless demonstrating reordering/reconciliation
- Document when keys ARE needed (dynamic reordering, performance optimization)

### 7. Array Mutation Patterns

Better examples of updating array items. Show both patterns and when to use each:

**Pattern A: Direct mutation with bidirectional binding**
```tsx
// For simple value updates
{items.map((item: OpaqueRef<ShoppingItem>) => (
  <ct-checkbox $checked={item.done}>
    {item.title}
  </ct-checkbox>
))}
```

**Pattern B: Handler with array reconstruction**
```tsx
// For complex operations (remove, reorder)
const removeItem = handler<unknown, {items: Cell<Item[]>, index: number}>(
  (_, {items, index}) => {
    items.set(items.get().filter((_, i) => i !== index));
  }
);
```

## Documentation Structure Suggestion

Consider a "Common Patterns" section with:

### Essential Patterns to Document

1. **Simple list with checkboxes (bidirectional binding)**
   - Basic CRUD operations
   - Add/remove items
   - Toggle states

2. **Filtered/grouped views of the same data**
   - Using `derive()` for transformations
   - Multiple views of same underlying data
   - Category/tag grouping

3. **Master-detail patterns (multiple charms sharing data via links)**
   - Linking charms together
   - Shared state across charms
   - Data flow patterns

4. **When to use handlers vs bidirectional binding**
   - Decision matrix
   - Performance considerations
   - Side effects and validation

5. **TypeScript tips for reactive data in JSX**
   - `OpaqueRef<T>` type annotations
   - Type inference limitations
   - Common type errors and fixes

## Example: Graduated Complexity

The shopping list pattern demonstrates all these concepts:

**Level 1: Basic List**
- Bidirectional binding with `$checked` and `$value`
- Array mapping with proper types
- Simple add/remove operations

**Level 2: Categorized View**
- Using `derive()` for grouping transformation
- Multiple views of same data
- Inline expressions vs intermediate variables

**Level 3: Linked Charms**
- Two separate charms sharing the same items array
- Updates in one reflected in the other
- Practical use of `ct charm link`

This provides a natural learning progression from simple to complex patterns.

## Additional Resources Needed

1. **Video walkthrough** of building a simple pattern from scratch
2. **Common errors** reference (with solutions)
3. **Performance tips** (when to optimize, when not to)
4. **Testing patterns** (how to test recipes with ct dev)
5. **Debugging guide** (common issues and how to debug them)
