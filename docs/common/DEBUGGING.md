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
| "ReadOnlyAddressError" | onClick inside derive() | Move button outside, use disabled ([see below](#onclick-inside-derive)) |
| Charm hangs, never renders | ifElse with composed pattern cell | Use local computed cell ([see below](#ifelse-with-composed-pattern-cells)) |
| Data not updating | Missing `$` prefix or wrong event | Use `$checked`, `$value` ([COMPONENTS](COMPONENTS.md)) |
| Filtered list not updating | Need computed() | Wrap in `computed()` ([CELLS](CELLS_AND_REACTIVITY.md)) |

---

## Common Gotchas

These issues compile without errors but fail at runtime.

### onClick Inside derive()

**Error:** "ReadOnlyAddressError: Cannot write to read-only address"

```typescript
// ❌ Buttons inside derive() fail when clicked
{derive(showAdd, (show) =>
  show ? <ct-button onClick={addItem({ items })}>Add</ct-button> : null
)}

// ✅ Move button outside, use disabled attribute
<ct-button onClick={addItem({ items })} disabled={derive(showAdd, (show) => !show)}>
  Add
</ct-button>

// ✅ Or use ifElse instead of derive
{ifElse(showAdd, <ct-button onClick={addItem({ items })}>Add</ct-button>, null)}
```

**Why:** `derive()` creates read-only inline data addresses. Always render buttons at the top level and control visibility with `disabled`.

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

### Style Syntax Mismatch

| Element Type | Syntax | Example |
|--------------|--------|---------|
| HTML (`div`, `span`) | Object, camelCase | `style={{ backgroundColor: "#fff" }}` |
| Custom (`ct-*`) | String, kebab-case | `style="background-color: #fff;"` |

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
