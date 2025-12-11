<!-- @reviewed 2025-12-10 docs-rationalization -->

# Pattern Debugging Guide

This guide consolidates common errors, debugging workflows, and troubleshooting tips for CommonTools pattern development.

## Quick Error Reference

| Error Message | Likely Cause | See Section |
|---------------|--------------|-------------|
| "Property 'set' does not exist" | Missing `Cell<>` in signature | [Type Errors](#type-errors) |
| "Property X does not exist on type 'OpaqueRef\<unknown\>'" | Missing type annotation in `.map()` | [Type Errors](#type-errors) |
| "Type 'string' is not assignable to type 'CSSProperties'" | Using string style on HTML element | [Style Errors](#style-errors) |
| "Type 'OpaqueRef\<T\>' is not assignable to 'Cell\<T\>'" | Binding whole item instead of property | [Type Errors](#type-errors) |
| Using `OpaqueRef<T>` in Output interface for handlers | Should use `Stream<T>` instead | [OpaqueRef in Output Interface Handlers](#opaqueref-in-output-interface-handlers) |
| Data not updating in UI | Missing `$` prefix or wrong event name | [Reactivity Issues](#reactivity-issues) |
| Filtered list not updating | Need `computed()` outside JSX | [Reactivity Issues](#reactivity-issues) |
| Can't access variable in nested scope | Variable scoping limitation | [Reactivity Issues](#reactivity-issues) |

## Type Errors

### Missing Cell<> for Write Access

**Error:** "Property 'set' does not exist on type 'number'"

❌ **Problem:** Trying to mutate without `Cell<>` in signature

```typescript
interface Input {
  count: number;  // Read-only!
}

export default pattern<Input>(({ count }) => {
  return {
    [UI]: (
      <ct-button onClick={() => count.set(5)}>  {/* Error! */}
        Set to 5
      </ct-button>
    ),
  };
});
```

✅ **Solution:** Add `Cell<>` to indicate write intent

```typescript
interface Input {
  count: Cell<number>;  // Write access
}

export default pattern<Input>(({ count }) => {
  return {
    [UI]: (
      <ct-button onClick={() => count.set(5)}>  {/* Works! */}
        Set to 5
      </ct-button>
    ),
  };
});
```

**Remember:** `Cell<>` in signatures = write permission. Omit for read-only.

### Missing OpaqueRef Type Annotation

**Error:** "Property 'done' does not exist on type 'OpaqueRef\<unknown\>'"

❌ **Problem:** Missing type annotation in `.map()` with bidirectional binding

```typescript
{items.map((item) => (
  <ct-checkbox $checked={item.done} />  {/* Type error! */}
))}
```

✅ **Solution:** Add `OpaqueRef<T>` type annotation

```typescript
{items.map((item: OpaqueRef<ShoppingItem>) => (
  <ct-checkbox $checked={item.done} />  {/* Works! */}
))}
```

**When needed:**
- Using `$checked`, `$value`, or other bidirectional bindings
- TypeScript shows errors about property types
- Complex nested objects

**When NOT needed:**
- Simple display without bidirectional binding
- TypeScript infers correctly

### Wrong Type for Binding

**Error:** "Type 'OpaqueRef\<ShoppingItem\>' is not assignable to type 'Cell\<boolean\>'"

❌ **Problem:** Trying to bind the whole item instead of a property

```typescript
<ct-checkbox $checked={item} />  {/* Trying to bind entire item */}
```

✅ **Solution:** Bind the specific property

```typescript
<ct-checkbox $checked={item.done} />  {/* Bind the boolean property */}
```

### OpaqueRef in Handler Parameters

**Error:** Type errors when calling handler methods

❌ **Problem:** Using `OpaqueRef<>` in handler type signature

```typescript
const addItem = handler<
  unknown,
  { items: Cell<OpaqueRef<ShoppingItem>[]> }  // Wrong!
>(/* ... */);
```

✅ **Solution:** Use `Cell<T[]>` instead

```typescript
const addItem = handler<
  unknown,
  { items: Cell<ShoppingItem[]> }  // Correct!
>((_event, { items }) => {
  items.push({ title: "New", done: false });
});
```

Don't use `OpaqueRef<>` in handler signatures. Use `Cell<T[]>` instead.

### OpaqueRef in Output Interface Handlers

**Error:** Type errors when exposing handlers in Output interface

❌ **Problem:** Using `OpaqueRef<>` for handlers in Output interface

```typescript
interface Output {
  increment: OpaqueRef<void>;  // Wrong!
  addItem: OpaqueRef<{ title: string }>;  // Wrong!
}
```

✅ **Solution:** Use `Stream<T>` for handlers in Output interfaces

```typescript
interface Output {
  increment: Stream<void>;  // Correct!
  addItem: Stream<{ title: string }>;  // Correct!
}
```

**Rule:** Handlers in Output interfaces must be typed as `Stream<T>`, not `OpaqueRef<T>`. See [TYPES_AND_SCHEMAS.md](TYPES_AND_SCHEMAS.md) section "Handler Types in Output Interfaces" for details.

### Cell<T[]> vs Cell<Array<Cell<T>>>

Use `Cell<T[]>` by default. Only use `Cell<Array<Cell<T>>>` when you need Cell methods on individual elements:

```typescript
// ✅ Standard - Cell<T[]>
const addItem = handler<unknown, { items: Cell<Item[]> }>(
  (_, { items }) => items.push({ title: "New" })
);

// ✅ Advanced - Cell<Array<Cell<T>>> for .equals()
const removeItem = handler<
  unknown,
  { items: Cell<Array<Cell<Item>>>; item: Cell<Item> }
>((_event, { items, item }) => {
  const index = items.get().findIndex(el => el.equals(item));
  if (index >= 0) items.set(items.get().toSpliced(index, 1));
});
```

## Style Errors

### String Style on HTML Elements

**Error:** "Type 'string' is not assignable to type 'CSSProperties'"

❌ **Problem:** Using CSS string syntax on HTML elements

```typescript
<div style="flex: 1; padding: 1rem;">  {/* Error! */}
  Content
</div>
```

✅ **Solution:** Use object syntax for HTML elements

```typescript
<div style={{ flex: 1, padding: "1rem" }}>  {/* Correct! */}
  Content
</div>
```

### Object Style on Custom Elements

**Error:** Styles not applying to custom elements

❌ **Problem:** Using object syntax on custom elements

```typescript
<common-hstack style={{ padding: "1rem" }}>  {/* Won't work */}
  Content
</common-hstack>
```

✅ **Solution:** Use string syntax for custom elements

```typescript
<common-hstack style="padding: 1rem;">  {/* Correct! */}
  Content
</common-hstack>
```

### Style Syntax Quick Reference

| Element Type | Style Syntax | Property Format | Example |
|--------------|--------------|-----------------|---------|
| HTML (`div`, `span`, `button`) | Object | camelCase | `style={{ flex: 1, backgroundColor: "#fff" }}` |
| Custom (`common-*`, `ct-*`) | String | kebab-case | `style="flex: 1; background-color: #fff;"` |

## Reactivity Issues

### Data Not Updating

**Issue:** UI doesn't update when data changes

**Check 1:** Missing `$` prefix for bidirectional binding?

```typescript
// ❌ Not bidirectional - won't update automatically
<ct-checkbox checked={item.done} />

// ✅ Bidirectional - updates automatically
<ct-checkbox $checked={item.done} />
```

**Check 2:** Using handler when bidirectional binding would work?

```typescript
// ❌ Unnecessary handler
const toggle = handler(({ detail }, { item }) => {
  item.set.key("done").set(detail.checked);
});
<ct-checkbox checked={item.done} onct-change={toggle({ item })} />

// ✅ Use bidirectional binding instead
<ct-checkbox $checked={item.done} />
```

**Check 3:** Wrong event name for handler?

Each component has specific event names. Check [COMPONENTS.md](COMPONENTS.md) for the right event:

```typescript
// ❌ Wrong event name
<ct-checkbox onChange={...} />

// ✅ Correct event name
<ct-checkbox onct-change={...} />
```

### Filtered/Sorted List Not Updating

**Issue:** Filter or sort doesn't update when dependencies change

❌ **Problem:** Direct operations don't create reactive nodes

```typescript
{items.filter(item => !item.done).map(...)}  {/* Won't update! */}
```

✅ **Solution:** Use `computed()` outside JSX

```typescript
const activeItems = computed(() => items.filter(item => !item.done));
{activeItems.map(...)}  {/* Updates reactively! */}
```

**Remember:** Within JSX, reactivity is automatic for simple expressions. Use `computed()` for transformations outside JSX.

### Conditional Rendering Not Working

**Issue:** Ternary operator doesn't work for conditional rendering

❌ **Problem:** Ternaries don't work for conditional elements

```typescript
{showDetails ? <div>Details</div> : null}  {/* Won't work! */}
```

✅ **Solution:** Use `ifElse()` for conditional rendering

```typescript
{ifElse(showDetails, <div>Details</div>, null)}  {/* Works! */}
```

**Note:** Ternaries DO work in JSX attributes for simple values:

```typescript
// ✅ Ternaries work in attributes
<span style={item.done ? { textDecoration: "line-through" } : {}}>
  {item.title}
</span>
```

### Variable Scoping in Reactive Contexts

**Issue:** Can't access variable from outer scope in `computed()`

❌ **Problem:** Variables from outer scopes aren't accessible in nested reactive contexts

```typescript
{categories.map((category) => (
  <div>
    {computed(() =>
      items.filter(i => i.category === category)  // category not accessible!
    )}
  </div>
))}
```

✅ **Solution:** Pre-compute grouped data

```typescript
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

## Runtime Errors

### DOM Access Not Allowed

**Error:** DOM manipulation doesn't work or throws errors

❌ **Problem:** Trying to access DOM directly

```typescript
const addItem = handler((_, { items }) => {
  const input = document.getElementById('item-input');
  const value = input.value;  // Won't work!
  items.push({ title: value });
});
```

✅ **Solution:** Use cells to capture state

```typescript
const itemTitle = Cell.of("");

// Bind to input
<ct-input $value={itemTitle} />

// Access in handler
const addItem = handler((_, { items, itemTitle }) => {
  const value = itemTitle.get();
  if (value.trim()) {
    items.push({ title: value });
    itemTitle.set("");
  }
});
```

Don't access DOM directly. Use cells for state management.

### Calling LLM Functions from Handlers

**Error:** `generateText()` or `generateObject()` not available or doesn't work in handlers

❌ **Problem:** Calling LLM functions outside pattern body

```typescript
const processItem = handler((_, { item }) => {
  const result = generateText({  // Won't work!
    prompt: item.content,
  });
});
```

✅ **Solution:** Call LLM functions in pattern body, use results in UI or handlers

```typescript
export default pattern(({ item }) => {
  // Call generateText in pattern body
  const llmResult = generateText({
    prompt: item.content,
  });

  // Use results in UI
  return {
    [UI]: (
      <div>
        {llmResult.pending ? "Generating..." : llmResult.result}
      </div>
    ),
  };
});
```

`generateText()` and `generateObject()` can only be called from pattern bodies, not handlers or `computed()`. See [LLM.md](LLM.md) for details.

### Using await in Handlers

**Error:** UI freezes, blocked interactions

❌ **Problem:** Using `await` in handlers blocks the entire UI

```typescript
const handleFetch = handler(async (_, { url, result }) => {
  const response = await fetch(url.get());  // BLOCKS UI!
  const data = await response.json();        // BLOCKS UI!
  result.set(data);
});
```

✅ **Solution:** Use `fetchData` for async operations

```typescript
export default pattern(({ searchQuery }) => {
  // Async fetch is reactive - doesn't block
  const searchUrl = computed(() =>
    searchQuery.get() ? `/api/search?q=${encodeURIComponent(searchQuery.get())}` : ""
  );
  const { result, error, loading } = fetchData({ url: searchUrl });

  // Handler just triggers fetch by changing the query
  const handleSearch = handler<
    { detail: { message: string } },
    { searchQuery: Cell<string> }
  >(({ detail }, { searchQuery }) => {
    searchQuery.set(detail.message);
  });

  return {
    [UI]: (
      <div>
        {loading && <span>Loading...</span>}
        {error && <span>Error: {error}</span>}
        {result && <Results data={result} />}
        <ct-message-input onct-send={handleSearch({ searchQuery })} />
      </div>
    ),
  };
});
```

Handlers should be synchronous state changes. Use `fetchData` for async operations.

### Using if Statements in Data Transformations

**Error:** Conditional logic doesn't work in transformations

❌ **Problem:** Using `if` statements in reactive contexts

```typescript
const result = items.map((item) => {
  if (item.isValid) {  // Won't work!
    return processItem(item);
  } else {
    return { item, error: "Invalid" };
  }
});
```

✅ **Solution:** Use `ifElse()` for conditional logic

```typescript
const result = items.map((item) =>
  ifElse(
    item.isValid,
    () => processItem(item),
    () => ({ item, error: "Invalid" })
  )
);
```

## Debugging Workflow

### Step 1: Check TypeScript Errors First

Run type checking before deploying:

```bash
deno task ct dev pattern.tsx --no-run
```

Fix all type errors before proceeding. Most issues are caught here.

### Step 2: Consult Documentation

Match your error to the relevant guide:

- **Type errors** → [TYPES_AND_SCHEMAS.md](TYPES_AND_SCHEMAS.md)
- **Cell/reactivity issues** → [CELLS_AND_REACTIVITY.md](CELLS_AND_REACTIVITY.md)
- **Component questions** → [COMPONENTS.md](COMPONENTS.md)
- **Pattern examples** → [PATTERNS.md](PATTERNS.md)

### Step 3: Debug Intermediate Values

For debugging intermediate cell values without flooding the console:

- **Use `<ct-cell-context>`** - See [CELL_CONTEXT.md](CELL_CONTEXT.md) for on-demand inspection
- Hold **Alt** and hover over a cell context region to access debugging toolbar
- Better than `console.log` because inspection is conditional (watch/unwatch on demand)

### Step 4: Inspect Deployed Charm

If code compiles but doesn't work as expected:

```bash
# View full charm state
deno task ct charm inspect --identity key.json --api-url https://toolshed.saga-castor.ts.net --space test-space --charm [charm-id]

# Get specific field
deno task ct charm get --identity key.json --api-url https://toolshed.saga-castor.ts.net --space test-space --charm [charm-id] items/0/title
```

### Step 4: Check Examples

Look for similar patterns in `packages/patterns/`:

```bash
ls packages/patterns/
# Find patterns similar to what you're building
```

### Step 5: Simplify

If still stuck, simplify until it works:

1. Comment out code until you have a minimal working pattern
2. Add back features one at a time
3. Test after each addition

## Common Mistakes by Pattern

### Pattern: Basic List with Bidirectional Binding

**Mistake 1:** Using handlers instead of bidirectional binding

```typescript
// ❌ Over-engineered
const toggle = handler(...);
<ct-checkbox checked={item.done} onct-change={toggle({ item })} />

// ✅ Simple
<ct-checkbox $checked={item.done} />
```

**Mistake 2:** Forgetting Cell<> for write operations

```typescript
// ❌ Missing Cell<> for items array
interface Input {
  items: Item[];  // Can't call .push()!
}

// ✅ Add Cell<> for write access
interface Input {
  items: Cell<Item[]>;  // Can call .push()
}
```

**Mistake 3:** Missing type annotation in .map()

```typescript
// ❌ No type annotation
{items.map((item) => (
  <ct-checkbox $checked={item.done} />  // Type error!
))}

// ✅ Add OpaqueRef<T>
{items.map((item: OpaqueRef<Item>) => (
  <ct-checkbox $checked={item.done} />
))}
```

### Pattern: Filtered Views

**Mistake 1:** Not using computed() for filters

```typescript
// ❌ Direct filter won't update
{items.filter(item => !item.done).map(...)}

// ✅ Use computed()
const activeItems = computed(() => items.filter(item => !item.done));
{activeItems.map(...)}
```

**Mistake 2:** Creating computed() inside JSX

```typescript
// ❌ Don't create computed() in JSX
{computed(() => items.filter(...)).map(...)}

// ✅ Create outside, use inside
const filtered = computed(() => items.filter(...));
{filtered.map(...)}
```

### Pattern: Handlers for Structural Changes

**Mistake 1:** Wrong array type in handler

```typescript
// ❌ OpaqueRef in handler signature
handler<unknown, { items: Cell<OpaqueRef<Item>[]> }>(...)

// ✅ Use Cell<T[]>
handler<unknown, { items: Cell<Item[]> }>(...)
```

**Mistake 2:** Not using .get() in handlers

```typescript
// ❌ Can't access cell value directly
const addItem = handler((_, { items }) => {
  items.push({ title: items.length + 1 });  // Wrong!
});

// ✅ Use .get() to read
const addItem = handler((_, { items }) => {
  items.push({ title: items.get().length + 1 });
});
```

## Testing Patterns

### Local Testing

Test syntax and execution locally before deploying:

```bash
# Check syntax
deno task ct dev pattern.tsx --no-run

# Run locally (if applicable)
deno task ct dev pattern.tsx
```

### Deployed Testing

After deployment, test with real data:

```bash
# Deploy
deno task ct charm new --identity key.json --api-url https://toolshed.saga-castor.ts.net --space test pattern.tsx
# Returns: charm-id

# Set test data
echo '{"title": "Test", "done": false}' | \
  deno task ct charm set --identity key.json --api-url https://toolshed.saga-castor.ts.net \
  --space test --charm [charm-id] testItem

# Inspect results
deno task ct charm inspect --identity key.json --api-url https://toolshed.saga-castor.ts.net \
  --space test --charm [charm-id]
```

### Iterating Quickly

Use `setsrc` to update existing charm (much faster):

```bash
# Update without creating new charm
deno task ct charm setsrc --identity key.json --api-url https://toolshed.saga-castor.ts.net \
  --space test --charm [charm-id] pattern.tsx
```

## Debugging Checklist

When something doesn't work:

1. ✅ **Check the console** - Look for TypeScript errors
2. ✅ **Inspect the data** - Use `charm inspect` to see current state
3. ✅ **Simplify** - Comment out code until it works, then add back gradually
4. ✅ **Check types** - Most errors are type-related (OpaqueRef, Cell, style syntax)
5. ✅ **Verify bindings** - Did you use `$` prefix for bidirectional binding?
6. ✅ **Review common pitfalls** - Check this guide for your pattern type
7. ✅ **Check examples** - Look in `packages/patterns/` for similar patterns
8. ✅ **Read the docs** - Match your issue to the relevant guide

## Performance Debugging

### Issue: Sluggish UI with Large Lists

**When to optimize:** Lists with 100+ items that feel slow

**Common causes:**

1. **Creating handlers in .map()**

```typescript
// ❌ Creates new handler for every item on every render
{items.map(item => {
  const remove = handler(() => { ... });
  return <ct-button onClick={remove}>×</ct-button>;
})}

// ✅ Create handler once, reuse
const removeItem = handler((_, { items, item }) => { ... });
{items.map(item => (
  <ct-button onClick={removeItem({ items, item })}>×</ct-button>
))}
```

2. **Unnecessary computed() in loops**

```typescript
// ❌ Computing on every render
{items.map(item => (
  <div>{computed(() => expensiveCalc(item))}</div>
))}

// ✅ Compute once before loop
const processed = computed(() => items.map(item => expensiveCalc(item)));
{processed.map(result => <div>{result}</div>)}
```

3. **Over-sorting/filtering**

```typescript
// ❌ Sorting entire list when you only need count
const sortedItems = computed(() => items.toSorted(...));
const count = computed(() => sortedItems.length);

// ✅ Just compute count
const count = computed(() => items.length);
```

## Getting Help

If you're still stuck:

1. **Check the docs** - Most answers are in the guides
2. **Look at examples** - `packages/patterns/` has working code
3. **Simplify first** - Get a minimal version working
4. **Ask with context** - Include error messages, code snippets, and what you've tried

## Summary

**Quick debugging steps:**

1. Run `deno task ct dev pattern.tsx --no-run` to check types
2. Match error to this guide's quick reference
3. Check relevant doc (TYPES, CELLS, COMPONENTS, PATTERNS)
4. Look at similar examples in `packages/patterns/`
5. Simplify until it works, then add back features
6. Use `charm inspect` to debug runtime data

**Most common fixes:**

- Add `Cell<>` to signature for write access
- Add `OpaqueRef<T>` type annotation in `.map()`
- Use `$` prefix for bidirectional binding
- Use `computed()` for filters/transforms outside JSX
- Use `ifElse()` instead of ternaries for conditional rendering
- Use object styles for HTML, string styles for custom elements
