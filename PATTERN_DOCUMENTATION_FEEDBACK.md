# Pattern Documentation Feedback

**Date**: 2025-10-20 **Context**: Feedback based on implementing shopping list
patterns (basic, categorized, and composed views) **Author**: Pattern developer
working through real-world examples

---

## Executive Summary

After building three shopping list patterns from scratch—a basic list, a
category-grouped view, and a composed pattern displaying both side-by-side—I've
identified several documentation gaps that significantly slowed development.
While the existing PATTERNS.md and tutorial docs are helpful, critical details
about pattern composition, TypeScript typing, and style attributes were either
missing or buried in unrelated examples.

This feedback focuses on specific improvements that would help developers move
faster and avoid common pitfalls.

---

## 1. Missing Examples

### 1.1 Pattern Composition with `ct-render`

**Current State**: The `chatbot-note-composed.tsx` example exists but is complex
and hard to extract the core pattern from.

**Gap**: No clear, minimal example showing:

- How to compose two patterns together
- The difference between `<ct-render charm={...}>` (wrong) and
  `<ct-render $cell={...}>` (correct)
- How data sharing works between composed patterns

**Suggested Addition to PATTERNS.md**:

````typescript
## Level 4: Pattern Composition with ct-render

When you want to display multiple patterns together that share the same data, use pattern composition.

**Key Concept**: Use `$cell={pattern}` not `charm={pattern}` to render composed patterns.

```typescript
/// <cts-enable />
import { recipe, UI, NAME, Default } from "commontools";
import ShoppingList from "./shopping-list.tsx";
import ShoppingListByCategory from "./shopping-list-by-category.tsx";

interface ShoppingItem {
  name: string;
  checked: Default<boolean, false>;
  category: string;
}

interface ComposedInput {
  items: Default<ShoppingItem[], []>;
}

export default recipe<ComposedInput, any>(
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
            <ct-render $cell={basicView} />
          </div>
          <div style={{ flex: 1 }}>
            <ct-render $cell={categoryView} />
          </div>
        </div>
      ),
      items, // Export shared data
    };
  },
);
````

**What to notice:**

- ✅ `ShoppingList({ items })` creates a pattern instance
- ✅ Both patterns receive the same `items` cell reference
- ✅ `<ct-render $cell={basicView} />` - note the `$cell` attribute
- ✅ Changes in one view automatically update the other
- ❌ Don't use `charm={...}` or `pattern={...}` - use `$cell={...}`

**Common mistake:**

```typescript
// ❌ WRONG - This doesn't work
<ct-render charm={basicView} />

// ✅ CORRECT
<ct-render $cell={basicView} />
```

````
**Why This Helps**: This is the number one thing that blocked me. The `$cell` syntax is not documented anywhere clearly, and I only found it by reading the chatbot example carefully.

---

### 1.2 Working with Grouped Data and Direct Property Access

**Current State**: PATTERNS.md shows `groupedItems[category]` but doesn't explain when/why this works vs when you need intermediate variables.

**Gap**: No explanation of how to access derived object properties directly in JSX.

**Suggested Addition to PATTERNS.md**:

```typescript
## Pattern: Direct Property Access on Derived Objects

When you derive an object (not an array), you can access its properties directly in JSX without additional derives.

```typescript
// Derive a grouped object
const groupedItems = derive(items, (list) => {
  const groups: Record<string, ShoppingItem[]> = {};
  for (const item of list) {
    const category = item.category || "Uncategorized";
    if (!groups[category]) groups[category] = [];
    groups[category].push(item);
  }
  return groups;
});

// Get category names as separate derived value
const categories = derive(groupedItems, (groups) => Object.keys(groups).sort());

// In JSX: Access properties directly with inline null coalescing
{categories.map((category) => (
  <div>
    <h3>{category}</h3>
    {/* ✅ Direct property access with null coalescing */}
    {(groupedItems[category] ?? []).map((item: OpaqueRef<ShoppingItem>) => (
      <ct-checkbox $checked={item.checked}>{item.name}</ct-checkbox>
    ))}
  </div>
))}
````

**What to notice:**

- ✅ `groupedItems[category]` - direct property access on derived object
- ✅ `(groupedItems[category] ?? [])` - inline null coalescing for safety
- ✅ No intermediate `derive` needed for property access
- ✅ Type annotation `OpaqueRef<ShoppingItem>` required in inner map

**When to use this pattern:**

- You have a derived object (Record, Map-like structure)
- You need to access its properties in a loop
- The property access is simple (no complex transformations)

**When NOT to use this pattern:**

- If you need to filter or transform the property value, use another `derive`

````
**Why This Helps**: I spent time trying to figure out if I needed another `derive()` call or if direct access would work. This pattern is powerful but not documented.

---

### 1.3 TypeScript Type Annotations in `.map()`

**Current State**: PATTERNS.md shows `(item: OpaqueRef<ShoppingItem>, index)` but doesn't explain why or when this is required.

**Gap**: No clear explanation of when type annotations are needed and what errors you'll get without them.

**Suggested Addition to PATTERNS.md (or new TypeScript section)**:

```typescript
## TypeScript: Type Annotations in .map()

When using `.map()` on cells in JSX, TypeScript needs explicit type annotations to enable property access and bidirectional binding.

### The Rule

**Always annotate the item parameter when using `.map()` on a Cell array:**

```typescript
// ❌ WRONG - TypeScript can't infer the type
{items.map((item) => (
  <ct-checkbox $checked={item.checked}>{item.name}</ct-checkbox>
  // Error: Property 'checked' does not exist on type 'OpaqueRef<unknown>'
))}

// ✅ CORRECT - Explicit type annotation
{items.map((item: OpaqueRef<ShoppingItem>) => (
  <ct-checkbox $checked={item.checked}>{item.name}</ct-checkbox>
))}
````

### Why OpaqueRef?

Items in a `.map()` are wrapped as `OpaqueRef<T>` to maintain their connection
to the Cell system. This enables:

- Bidirectional binding (`$checked`, `$value`)
- Reactive updates when the item changes
- Type-safe property access

### With Index Parameter

```typescript
// Both parameters need types when using index
{
  items.map((item: OpaqueRef<ShoppingItem>, index: number) => (
    <div>
      <span>{index + 1}. {item.name}</span>
      <ct-button onClick={removeItem({ items, index })}>Remove</ct-button>
    </div>
  ));
}
```

### Common Errors and Solutions

**Error**: "Property 'X' does not exist on type 'OpaqueRef<unknown>'"

```typescript
// ❌ Missing type annotation
{
  items.map((item) => <span>{item.name}</span>);
}

// ✅ Add OpaqueRef<YourType>
{
  items.map((item: OpaqueRef<ShoppingItem>) => <span>{item.name}</span>);
}
```

**Error**: "Type 'OpaqueRef<ShoppingItem>' is not assignable to type
'Cell<boolean>'"

```typescript
// ❌ Wrong - trying to bind the whole item
<ct-checkbox $checked={item} />

// ✅ Correct - bind the property
<ct-checkbox $checked={item.checked} />
```

````
**Why This Helps**: This was a source of multiple TypeScript errors. The connection between `.map()`, `OpaqueRef`, and bidirectional binding needs to be explicit.

---

## 2. Documentation Gaps

### 2.1 Style Attributes: String vs Object Syntax

**Current State**: No documentation on when to use string vs object styles.

**Gap**: HTML elements and custom elements accept different style syntax, causing TypeScript errors.

**Suggested Addition to COMPONENTS.md or PATTERNS.md**:

```typescript
## Styling: String vs Object Syntax

Different element types accept different style syntax in CommonTools JSX.

### HTML Elements: Object Syntax

HTML elements (`div`, `span`, `button`, etc.) use JavaScript object syntax:

```typescript
// ✅ CORRECT - Object syntax for HTML elements
<div style={{ flex: 1, padding: "1rem", marginBottom: "0.5rem" }}>
  <span style={{ color: "red", fontWeight: "bold" }}>Error</span>
</div>

// ❌ WRONG - String syntax doesn't work
<div style="flex: 1; padding: 1rem;">
  {/* TypeScript error: Type 'string' is not assignable to type 'CSSProperties' */}
</div>
````

### Custom Elements: String Syntax

CommonTools custom elements (`common-hstack`, `common-vstack`, `ct-card`, etc.)
use CSS string syntax:

```typescript
// ✅ CORRECT - String syntax for custom elements
<common-hstack gap="sm" style="align-items: center; padding: 1rem;">
  <common-vstack gap="md" style="flex: 1; max-width: 600px;">
    <ct-card style="border: 1px solid #ccc;">
      {/* ... */}
    </ct-card>
  </common-vstack>
</common-hstack>

// ❌ WRONG - Object syntax causes errors
<common-hstack style={{ alignItems: "center" }}>
  {/* Error */}
</common-hstack>
```

### Quick Reference

| Element Type                        | Style Syntax | Example               |
| ----------------------------------- | ------------ | --------------------- |
| HTML (`div`, `span`, `button`)      | Object       | `style={{ flex: 1 }}` |
| Custom (`common-hstack`, `ct-card`) | String       | `style="flex: 1;"`    |

### Why the Difference?

HTML elements are processed by the JSX transformer which expects React-style
object syntax. Custom elements are web components that accept CSS strings as
attributes.

### Mixed Usage

```typescript
<div style={{ display: "flex", gap: "1rem" }}>
  <common-vstack gap="md" style="flex: 1; padding: 1rem;">
    <span style={{ color: "#333", fontSize: "14px" }}>
      Label
    </span>
  </common-vstack>
</div>;
```

````
**Why This Helps**: I got multiple TypeScript errors mixing these up. This is a fundamental thing that should be clearly documented.

---

### 2.2 When to Use `[ID]` vs Index-Based Handlers

**Current State**: `list-operations.tsx` has a big comment about `[ID]` but PATTERNS.md suggests simpler patterns work fine.

**Gap**: No clear guidance on when the complexity of `[ID]` is actually needed.

**Suggested Addition to PATTERNS.md**:

```typescript
## Advanced: When to Use [ID] with Array Items

Most patterns don't need `[ID]`. Use it only when you have specific stability requirements.

### Simple Pattern (Recommended for Most Cases)

For most list operations, index-based handlers are simpler and sufficient:

```typescript
interface ShoppingItem {
  name: string;
  checked: Default<boolean, false>;
  // No [ID] needed!
}

const removeItem = handler<unknown, { items: Cell<ShoppingItem[]>; index: number }>(
  (_, { items, index }) => {
    items.set(items.get().toSpliced(index, 1));
  }
);

{items.map((item: OpaqueRef<ShoppingItem>, index) => (
  <div>
    <ct-checkbox $checked={item.checked}>{item.name}</ct-checkbox>
    <ct-button onClick={removeItem({ items, index })}>Remove</ct-button>
  </div>
))}
````

**When this works fine:**

- Adding items to the end
- Removing items by button click
- Editing items in place
- Most CRUD operations

### Advanced Pattern with [ID] (Only When Needed)

Use `[ID]` only when you need stable references for:

- Inserting items at the beginning of arrays
- Complex drag-and-drop reordering
- Maintaining references when items move positions

```typescript
import { ID } from "commontools";

interface ShoppingItem {
  [ID]: number; // Stable identifier
  name: string;
  checked: Default<boolean, false>;
}

const insertAtStart = handler<unknown, { items: Cell<ShoppingItem[]> }>(
  (_, { items }) => {
    const current = items.get();
    items.set([{ [ID]: Date.now(), name: "New", checked: false }, ...current]);
  },
);
```

### Trade-offs

| Approach                  | Pros                                                 | Cons                                 |
| ------------------------- | ---------------------------------------------------- | ------------------------------------ |
| Index-based (recommended) | Simpler code, less boilerplate, easier to understand | May have issues with front-insertion |
| [ID]-based                | Stable references, handles all operations            | More complex, requires ID management |

**Rule of thumb**: Start without `[ID]`. Only add it if you encounter specific
bugs with front-insertion or item identity.

````
**Why This Helps**: I was confused seeing `[ID]` in examples and wondering if I needed it. Clear guidance on when to use which approach would save time.

---

## 3. TypeScript Guidance Improvements

### 3.1 Handler Type Parameters: Cell\<T[]\> vs Cell\<Array\<Cell\<T\>\>\>

**Current State**: HANDLERS.md mentions this briefly but doesn't explain the pattern clearly.

**Gap**: Confusion about how to type array cells in handler parameters.

**Suggested Enhancement to HANDLERS.md**:

Add this section after "Handler Parameter Type Patterns":

```typescript
### Array Cell Typing in Handlers

**Critical Rule**: In handler type signatures, always use `Cell<T[]>` for array parameters, never `Cell<Array<Cell<T>>>`.

```typescript
// ✅ CORRECT - Cell wraps the entire array
const addItem = handler<
  unknown,
  { items: Cell<ShoppingItem[]> }  // ← Cell<ShoppingItem[]>
>((_event, { items }) => {
  const currentItems = items.get();  // Returns ShoppingItem[]
  items.set([...currentItems, { name: "New", checked: false }]);
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
````

**Understanding the Types**

1. **In handler parameters**: `items: Cell<ShoppingItem[]>`
   - The Cell wraps the entire array
   - Calling `items.get()` returns `ShoppingItem[]` (plain array)

2. **In JSX .map()**: `item: OpaqueRef<ShoppingItem>`
   - Each item is wrapped as OpaqueRef during iteration
   - Enables bidirectional binding on item properties

3. **In recipe returns**: `items: Cell<ShoppingItem[]>`
   - Same as handler parameters

```typescript
// Complete example showing all three contexts
interface ShoppingItem {
  name: string;
  checked: Default<boolean, false>;
}

// 1. Handler parameter typing
const addItem = handler<
  unknown,
  { items: Cell<ShoppingItem[]> } // ← Cell<ShoppingItem[]>
>((_event, { items }) => {
  items.set([...items.get(), { name: "New", checked: false }]);
});

export default recipe<{ items: Default<ShoppingItem[], []> }, any>(
  "Shopping List",
  ({ items }) => { // ← items is Cell<ShoppingItem[]>
    return {
      [UI]: (
        <div>
          {/* 2. JSX .map() typing */}
          {items.map((item: OpaqueRef<ShoppingItem>) => ( // ← OpaqueRef<ShoppingItem>
            <ct-checkbox $checked={item.checked}>{item.name}</ct-checkbox>
          ))}
          <ct-button onClick={addItem({ items })}>Add</ct-button>
        </div>
      ),
      items, // 3. Return typing ← Cell<ShoppingItem[]>
    };
  },
);
```

**Mental Model**:

- Think of `Cell<T[]>` as a box containing an array
- When you open the box (`.get()`), you get `T[]`
- When you iterate in JSX (`.map()`), each item becomes `OpaqueRef<T>`

````
**Why This Helps**: This was confusing initially. The relationship between Cell, OpaqueRef, and plain types needs to be crystal clear.

---

## 4. Best Practices to Emphasize

### 4.1 Bidirectional Binding First

**Current State**: PATTERNS.md mentions this but buries it in the middle.

**Recommendation**: Put this at the very top of PATTERNS.md as a "golden rule":

```markdown
# Common Recipe Patterns

## 🌟 Golden Rule: Prefer Bidirectional Binding

**Before writing any handler, ask yourself**: "Am I just syncing UI ↔ data with no additional logic?"

If yes, use bidirectional binding:
```typescript
// ✅ SIMPLE - Just syncing UI and data
<ct-checkbox $checked={item.done} />
<ct-input $value={item.name} />
<ct-select $value={item.category} items={[...]} />
````

Only use handlers when you need:

- Side effects (logging, API calls)
- Validation logic
- Structural changes (add/remove from arrays)

**This is the most important pattern to learn.** Most of your UI updates will
use bidirectional binding, not handlers.

---

[Rest of the document...]

````
**Why This Helps**: I initially wrote handlers for everything, then learned about bidirectional binding. Starting with this principle would have saved significant time.

---

### 4.2 Pattern Development Workflow

**Current State**: Testing patterns section exists but doesn't show the full workflow.

**Gap**: No clear step-by-step process for developing patterns.

**Suggested Addition to PATTERNS.md**:

```typescript
## Pattern Development Workflow

Follow this workflow when creating new patterns:

### 1. Start Simple (5-10 minutes)

Create the minimal version first:
```typescript
// Start with just the data structure
interface ShoppingItem {
  name: string;
}

interface Input {
  items: Default<ShoppingItem[], []>;
}

export default recipe<Input, Input>("Shopping List", ({ items }) => {
  return {
    [NAME]: "Shopping List",
    [UI]: (
      <div>
        {items.map((item: OpaqueRef<ShoppingItem>) => (
          <div>{item.name}</div>
        ))}
      </div>
    ),
    items,
  };
});
````

### 2. Test Locally (2 minutes)

```bash
./dist/ct dev my-pattern.tsx
```

Fix any syntax errors before moving on.

### 3. Add Interactivity (10-15 minutes)

Add one feature at a time:

```typescript
// Add bidirectional binding first
<ct-checkbox $checked={item.checked}>

// Then add handlers for structural changes
const removeItem = handler(/* ... */);
```

### 4. Deploy and Test (3-5 minutes)

```bash
# Deploy
./dist/ct charm new --identity key.json --api-url ... --space test pattern.tsx
# Returns: pattern-charm-id

# Test with real data
echo '{"name": "Test", "checked": false}' | \
  ./dist/ct charm set --identity key.json --api-url ... \
  --space test --charm pattern-charm-id testItem
```

### 5. Iterate Quickly (1-2 minutes per iteration)

```bash
# Update existing charm (much faster than creating new)
./dist/ct charm setsrc --identity key.json --api-url ... \
  --space test --charm pattern-charm-id pattern.tsx
```

### Tips for Fast Iteration

- ✅ Use `ct dev` first to catch TypeScript errors
- ✅ Deploy once, then use `setsrc` for updates
- ✅ Test one feature at a time
- ✅ Use `charm inspect` to debug data issues
- ❌ Don't deploy a new charm for every change
- ❌ Don't add multiple features before testing

### Debugging Patterns

When something doesn't work:

1. **Check the console** - Look for TypeScript errors
2. **Inspect the data** - Use `charm inspect` to see current state
3. **Simplify** - Comment out code until it works, then add back gradually
4. **Check types** - Most errors are type-related (OpaqueRef, Cell, etc.)

````
**Why This Helps**: Having a clear workflow would have helped me move faster and avoid getting stuck.

---

## 5. Common Pitfalls to Warn Against

### 5.1 Using `charm={}` Instead of `$cell={}`

**Add to PATTERNS.md under "Common Debugging Patterns"**:

```typescript
**Issue: Pattern composition not rendering**

```typescript
// ❌ WRONG - Using charm attribute
<ct-render charm={myPattern} />

// ❌ WRONG - Using pattern attribute
<ct-render pattern={myPattern} />

// ✅ CORRECT - Use $cell
<ct-render $cell={myPattern} />
````

This is the most common mistake when composing patterns. The `ct-render`
component requires the `$cell` attribute for bidirectional binding with pattern
instances.

````
---

### 5.2 Forgetting Type Annotations in `.map()`

**Add to PATTERNS.md TypeScript section**:

```typescript
**Issue: "Property does not exist on type 'OpaqueRef<unknown>'"**

```typescript
// ❌ WRONG - Missing type annotation
{items.map((item) => (
  <ct-checkbox $checked={item.checked} />
  // Error: Property 'checked' does not exist on type 'OpaqueRef<unknown>'
))}

// ✅ CORRECT - Add type annotation
{items.map((item: OpaqueRef<ShoppingItem>) => (
  <ct-checkbox $checked={item.checked} />
))}
````

**Why this happens**: TypeScript can't infer the type of items in a Cell array.
You must explicitly annotate the parameter with `OpaqueRef<YourType>`.

**When to add it**: Always, in every `.map()` call on a Cell array in JSX.

````
---

### 5.3 Mixing Style Syntax

**Add to PATTERNS.md debugging section**:

```typescript
**Issue: "Type 'string' is not assignable to type 'CSSProperties'"**

```typescript
// ❌ WRONG - String style on HTML element
<div style="flex: 1;">
  {/* TypeScript error */}
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
````

**Rule**: HTML elements use object styles, custom elements use string styles.
See "Styling: String vs Object Syntax" for details.

````
---

## 6. Specific Documentation Additions

### 6.1 New Section: "Pattern Composition"

Add as Level 4 in PATTERNS.md (after Level 3: Linked Charms):

```markdown
## Level 4: Pattern Composition with ct-render

When you want to display multiple patterns together that share the same data, without deploying separate charms.

[Include the full example from section 1.1 above]
````

---

### 6.2 New Section: "TypeScript Quick Reference"

Add to PATTERNS.md or create TYPESCRIPT.md:

````markdown
# TypeScript Quick Reference for Patterns

## Type Annotations Cheat Sheet

### In Handler Parameters

```typescript
handler<EventType, { items: Cell<ShoppingItem[]> }>;
```
````

### In JSX .map()

```typescript
items.map((item: OpaqueRef<ShoppingItem>, index: number) => ...)
```

### In Recipe Parameters

```typescript
recipe<{ items: Default<ShoppingItem[], []> }, Output>;
```

### Style Attributes

```typescript
// HTML elements
<div style={{ flex: 1 }} />

// Custom elements
<common-hstack style="flex: 1;" />
```

[Include more from section 3 above]

````
---

### 6.3 Enhanced COMPONENTS.md: ct-render Section

Add to COMPONENTS.md:

```markdown
# ct-render

The `ct-render` component displays pattern instances within another pattern. Use this for pattern composition.

## Basic Usage

```typescript
import { recipe, UI, NAME } from "commontools";
import MyPattern from "./my-pattern.tsx";

export default recipe("Composed Pattern", ({ items }) => {
  // Create pattern instance
  const patternInstance = MyPattern({ items });

  return {
    [NAME]: "Composed Pattern",
    [UI]: (
      <div>
        {/* Render the pattern */}
        <ct-render $cell={patternInstance} />
      </div>
    ),
  };
});
````

## Important: Use $cell not charm

```typescript
// ❌ WRONG
<ct-render charm={patternInstance} />
<ct-render pattern={patternInstance} />

// ✅ CORRECT
<ct-render $cell={patternInstance} />
```

The `$cell` attribute enables bidirectional binding with the pattern instance.

## Multiple Patterns Sharing Data

```typescript
const pattern1 = Pattern1({ items });
const pattern2 = Pattern2({ items }); // Same items cell

return {
  [UI]: (
    <div style={{ display: "flex" }}>
      <ct-render $cell={pattern1} />
      <ct-render $cell={pattern2} />
    </div>
  ),
};
```

Both patterns receive the same cell reference, so updates in one automatically
appear in the other.

```
---

## 7. Priority Recommendations

If documentation resources are limited, prioritize these changes in order:

1. **Add Pattern Composition section** (Section 1.1) - This was the biggest blocker
2. **Add Style Syntax documentation** (Section 2.1) - Common source of errors
3. **Add TypeScript .map() annotation guidance** (Section 1.3) - Frequent confusion
4. **Emphasize Bidirectional Binding First** (Section 4.1) - Fundamental principle
5. **Add ct-render documentation** (Section 6.3) - Currently missing
6. **Add [ID] guidance** (Section 2.2) - Prevents over-engineering
7. **Add Pattern Development Workflow** (Section 4.2) - Speeds up learning

---

## 8. Additional Observations

### 8.1 Documentation Discoverability

The chatbot-note-composed.tsx example contains the pattern composition knowledge, but it's:
- Too complex to extract the core pattern
- Mixed with backlinks, navigation, and other features
- Not referenced from PATTERNS.md

**Recommendation**: Create a `composed-simple.tsx` example that shows just pattern composition with no other features.

---

### 8.2 Example Complexity Gradient

Current examples jump from simple (shopping list) to complex (chatbot-note-composed) with no middle ground.

**Recommendation**: Create a "medium complexity" example showing:
- Two simple patterns
- Composed together
- Sharing data
- No advanced features (navigation, backlinks, etc.)

---

### 8.3 TypeScript Error Messages

Many TypeScript errors come from:
1. Missing `OpaqueRef<T>` annotations
2. Wrong style syntax (string vs object)
3. Wrong ct-render attribute (`charm` vs `$cell`)

**Recommendation**: Add a "Common TypeScript Errors" page with screenshots of actual errors and their solutions.

---

## 9. Positive Feedback

What works well in the current documentation:

1. **PATTERNS.md structure** - The Level 1/2/3 progression is excellent
2. **Bidirectional binding explanation** - Once I found it in COMPONENTS.md, it was clear
3. **Decision matrices** - Tables showing "when to use what" are very helpful
4. **derive() examples** - The grouping example in Level 2 was perfect
5. **Handler patterns** - HANDLERS.md covers the basics well

These should be preserved and extended, not replaced.

---

## 10. Conclusion

The CommonTools pattern system is powerful and well-designed. The documentation covers many concepts well, but critical details about composition, TypeScript typing, and styling are either missing or hard to find.

The improvements suggested here would:
- Reduce time-to-productivity for new pattern developers
- Prevent common mistakes (wrong ct-render syntax, missing type annotations)
- Clarify when to use simple vs complex approaches ([ID], handlers vs binding)
- Provide clear mental models (Cell wraps arrays, OpaqueRef in maps, etc.)

Most importantly, these suggestions come from real development experience, not theoretical concerns. Each gap listed caused actual development delays or errors during the shopping list pattern implementation.

---

**Next Steps for Documentation Maintainers**:

1. Review and prioritize the suggested additions
2. Consider creating a "Pattern Composition" tutorial
3. Add TypeScript Quick Reference section
4. Create medium-complexity examples between simple and chatbot-note-composed
5. Add ct-render to COMPONENTS.md
6. Consider a "Common Errors" troubleshooting page

Thank you for maintaining this documentation. I hope this feedback helps improve the developer experience for future pattern creators.
```
