<!-- @reviewed 2025-12-11 docs-rationalization -->

# Pattern Debugging Guide

Quick error reference and debugging workflows. For detailed explanations, see linked docs.

## Quick Error Reference

| Error Message | Cause | Fix |
|---------------|-------|-----|
| "Property 'set' does not exist" | Missing `Cell<>` in signature | Add `Cell<T>` for write access ([TYPES](TYPES_AND_SCHEMAS.md)) |
| "Property X does not exist on type 'OpaqueRef\<unknown\>'" | Missing type in `.map()` | Add `OpaqueRef<T>` annotation ([TYPES](TYPES_AND_SCHEMAS.md)) |
| "Type 'string' is not assignable to type 'CSSProperties'" | String style on HTML element | Use object syntax `style={{ ... }}` ([COMPONENTS](COMPONENTS.md)) |
| "Type 'OpaqueRef\<T\>' is not assignable to 'Cell\<T\>'" | Binding whole item, not property | Bind `item.done`, not `item` |
| Using `OpaqueRef<T>` in Output for handlers | Should use `Stream<T>` | Use `Stream<T>` for handlers ([TYPES](TYPES_AND_SCHEMAS.md)) |
| "ReadOnlyAddressError" | onClick inside computed() | Move button outside, use disabled ([see below](#onclick-inside-computed)) |
| Charm hangs, never renders | ifElse with composed pattern cell | Use local computed cell ([see below](#ifelse-with-composed-pattern-cells)) |
| Data not updating | Missing `$` prefix or wrong event | Use `$checked`, `$value` ([COMPONENTS](COMPONENTS.md)) |
| Filtered list not updating | Need computed() | Wrap in `computed()` ([CELLS](CELLS_AND_REACTIVITY.md)) |
| Can't access variable in nested scope | Variable scoping limitation | Pre-compute grouped data ([see below](#variable-scoping-in-reactive-contexts)) |

---

## Common Gotchas

These issues compile without errors but fail at runtime.

### onClick Inside computed()

**Error:** "ReadOnlyAddressError: Cannot write to read-only address"

```typescript
// ❌ Buttons inside computed() fail when clicked
{computed(() =>
  showAdd ? <ct-button onClick={addItem({ items })}>Add</ct-button> : null
)}

// ✅ Move button outside, use disabled attribute
<ct-button onClick={addItem({ items })} disabled={computed(() => !showAdd)}>
  Add
</ct-button>

// ✅ Or use ifElse instead of computed
{ifElse(showAdd, <ct-button onClick={addItem({ items })}>Add</ct-button>, null)}
```

**Why:** `computed()` creates read-only inline data addresses. Always render buttons at the top level and control visibility with `disabled`.

### ifElse with Composed Pattern Cells

**Symptom:** Charm never renders, no errors, blank UI

```typescript
// ❌ May hang - cell from composed pattern
const showDetails = subPattern.isExpanded;
{ifElse(showDetails, <div>Details</div>, null)}

// ✅ Use local computed cell
const showDetails = computed(() => subPattern.isExpanded);
{ifElse(showDetails, <div>Details</div>, null)}
```

### Conditional Rendering with Ternaries

```typescript
// ❌ Ternaries don't work for elements
{show ? <div>Content</div> : null}

// ✅ Use ifElse()
{ifElse(show, <div>Content</div>, null)}

// ✅ Ternaries ARE fine for attributes
<span style={done ? { textDecoration: "line-through" } : {}}>{title}</span>
```

---

## Type Errors

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

❌ **Problem:** Inline filtering/transformations in JSX don't create reactive dependencies

```typescript
{items.filter(item => !item.done).map(...)}  {/* Won't update! */}
```

✅ **Solution:** Use `computed()` outside JSX, then map over the result

```typescript
const activeItems = computed(() => items.filter(item => !item.done));
{activeItems.map(...)}  {/* Updates reactively! */}
```

**The Pattern:** Compute transformations (filter, sort, group) outside JSX using `computed()`, then map over the computed result inside JSX. Mapping over `computed()` results is the canonical pattern.

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

### No Direct DOM Access

Patterns run in a sandboxed environment. DOM APIs don't work:

```typescript
// ❌ Won't work
const addItem = handler((_, { items }) => {
  const input = document.getElementById('item-input');
  const value = input.value;
  items.push({ title: value });
});

// ✅ Use cells to capture state
const itemTitle = Cell.of("");

<ct-input $value={itemTitle} />

const addItem = handler((_, { items, itemTitle }) => {
  const value = itemTitle.get();
  if (value.trim()) {
    items.push({ title: value });
    itemTitle.set("");
  }
});
```

### Async Operations Block UI

Using `await` in handlers blocks the entire UI:

```typescript
// ❌ Blocks UI
const handleFetch = handler(async (_, { url, result }) => {
  const response = await fetch(url.get());  // BLOCKS!
  const data = await response.json();
  result.set(data);
});

// ✅ Use fetchData - reactive, non-blocking
export default pattern(({ searchQuery }) => {
  const searchUrl = computed(() =>
    searchQuery ? `/api/search?q=${encodeURIComponent(searchQuery)}` : ""
  );
  const { result, error, loading } = fetchData({ url: searchUrl });

  // Handler just updates the query, fetchData handles the rest
  const handleSearch = handler<{ detail: { message: string } }, { searchQuery: Cell<string> }>(
    ({ detail }, { searchQuery }) => searchQuery.set(detail.message)
  );

  return {
    [UI]: (
      <div>
        {loading && <span>Loading...</span>}
        {error && <span>Error: {error}</span>}
        {result && <div>{result}</div>}
        <ct-message-input onct-send={handleSearch({ searchQuery })} />
      </div>
    ),
  };
});
```

**Rule:** Handlers should be synchronous state changes. Use `fetchData` for async operations.

---

## Debugging Workflow

### 1. Check TypeScript Errors

```bash
deno task ct dev pattern.tsx --no-run
```

Fix all type errors before deploying. Most issues are caught here.

### 2. Match Error to Doc

- **Type errors** → [TYPES_AND_SCHEMAS.md](TYPES_AND_SCHEMAS.md)
- **Reactivity issues** → [CELLS_AND_REACTIVITY.md](CELLS_AND_REACTIVITY.md)
- **Component questions** → [COMPONENTS.md](COMPONENTS.md)
- **Pattern examples** → [PATTERNS.md](PATTERNS.md)

### 3. Inspect Cell Values

Use `<ct-cell-context>` for on-demand value inspection:

```tsx
<ct-cell-context $cell={result} label="Result">
  <div>{result.value}</div>
</ct-cell-context>
```

Hold **Alt** and hover to access debugging toolbar (val, id, watch/unwatch).

### 4. Inspect Deployed Charm

```bash
deno task ct charm inspect --identity key.json --api-url URL --space SPACE --charm ID
```

### 5. Simplify Until It Works

1. Comment out code until you have a minimal working pattern
2. Add back features one at a time
3. Test after each addition

---

## Quick Fixes

| Problem | Fix |
|---------|-----|
| Can't call `.set()` | Add `Cell<T>` to type signature |
| Type error in `.map()` | Add `OpaqueRef<T>` annotation |
| Filter not updating | Use `computed(() => items.filter(...))` |
| Checkbox not syncing | Use `$checked` not `checked` |
| Style not applying | Check element type (object vs string syntax) |
| LLM in handler | Move `generateText` to pattern body |
| UI blocking | Use `fetchData` instead of `await` in handlers |

---

## Performance Issues

For lists with 100+ items that feel slow:

**1. Don't create handlers in .map()**

```typescript
// ❌ Creates handler per item per render
{items.map(item => {
  const remove = handler(() => { ... });
  return <ct-button onClick={remove}>×</ct-button>;
})}

// ✅ Create once, reuse
const removeItem = handler((_, { items, item }) => { ... });
{items.map(item => <ct-button onClick={removeItem({ items, item })}>×</ct-button>)}
```

**2. Pre-compute outside loops**

```typescript
// ❌ Expensive in loop
{items.map(item => <div>{computed(() => expensive(item))}</div>)}

// ✅ Compute once
const processed = computed(() => items.map(expensive));
{processed.map(result => <div>{result}</div>)}
```

---

## Testing Patterns

### Local Testing

```bash
# Check syntax only (fast)
deno task ct dev pattern.tsx --no-run

# Run locally
deno task ct dev pattern.tsx

# View transformer output (debug compile issues)
deno task ct dev pattern.tsx --show-transformed
```

### Deployed Testing

```bash
# Deploy
deno task ct charm new --identity key.json --api-url URL --space SPACE pattern.tsx
# Returns: charm-id

# Set test data
echo '{"title": "Test", "done": false}' | \
  deno task ct charm set --identity key.json --api-url URL --space SPACE --charm ID testItem

# Inspect full state
deno task ct charm inspect --identity key.json --api-url URL --space SPACE --charm ID

# Get specific field
deno task ct charm get --identity key.json --api-url URL --space SPACE --charm ID items/0/title
```

### Iterate Quickly

Use `setsrc` to update existing charm without creating new one:

```bash
deno task ct charm setsrc --identity key.json --api-url URL --space SPACE --charm ID pattern.tsx
```

---

## See Also

- [CELLS_AND_REACTIVITY.md](CELLS_AND_REACTIVITY.md) - Reactivity system
- [TYPES_AND_SCHEMAS.md](TYPES_AND_SCHEMAS.md) - Type system
- [COMPONENTS.md](COMPONENTS.md) - UI components
- [CELL_CONTEXT.md](CELL_CONTEXT.md) - Debug tool details
