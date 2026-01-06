<!-- @reviewed 2025-12-11 docs-rationalization -->

# Pattern Debugging Guide

Quick error reference and debugging workflows. For detailed explanations, see linked docs.

## Quick Error Reference

| Error Message | Cause | Fix |
|---------------|-------|-----|
| "Property 'set' does not exist" | Missing `Writable<>` in signature | Add `Writable<T>` for write access ([TYPES](TYPES_AND_SCHEMAS.md)) |
| "X.get is not a function" | Calling `.get()` on computed/lift result | Access directly without `.get()` - only `Writable<>` has `.get()` ([see below](#get-is-not-a-function)) |
| "X.filter is not a function" | Value isn't an array (yet) | Check `Default<>`, don't assume `.get()` is the fix ([see below](#filtermapfind-is-not-a-function)) |
| "Tried to access a reactive reference outside a reactive context" | Using reactive value to index plain object in `.map()` | Use `lift()` for object indexing ([see below](#reactive-reference-outside-context)) |
| "Type 'string' is not assignable to type 'CSSProperties'" | String style on HTML element | Use object syntax `style={{ ... }}` ([COMPONENTS](COMPONENTS.md)) |
| Type mismatch binding item to `$checked` | Binding whole item, not property | Bind `item.done`, not `item` |
| "ReadOnlyAddressError" | onClick inside computed() | Move button outside, use disabled ([see below](#onclick-inside-computed)) |
| Charm hangs, never renders | ifElse with composed pattern cell | Use local computed cell ([see below](#ifelse-with-composed-pattern-cells)) |
| Data not updating | Missing `$` prefix or wrong event | Use `$checked`, `$value` ([COMPONENTS](COMPONENTS.md)) |
| Filtered list not updating | Need computed() | Wrap in `computed()` ([REACTIVITY](REACTIVITY.md)) |
| lift() returns 0/empty | Passing cell directly to lift() | Use `computed()` or pass as object param ([see below](#lift-returns-staleempty-data)) |
| Handler binding: unknown property | Passing event data at binding time | Use inline handler for test buttons ([see below](#handler-binding-error-unknown-property)) |
| Stream.subscribe doesn't exist | Using Stream.of()/subscribe() | Bound handler IS the stream ([see below](#streamof--subscribe-dont-exist)) |
| Can't access variable in nested scope | Variable scoping limitation | Pre-compute grouped data or use lift() with explicit params ([see below](#variable-scoping-in-reactive-contexts)) |
| "Cannot access cell via closure" / "Accessing an opaque ref via closure is not supported" | Using lift() with closure | Pass all reactive deps as params to lift() ([REACTIVITY](REACTIVITY.md#lift-and-closure-limitations)) |
| CLI `get` returns stale computed values | `charm set` doesn't trigger recompute | Run `charm step` after `set` to trigger re-evaluation ([see below](#stale-computed-values-after-charm-set)) |
| Space URL 404 or routing errors | Space name contains `/` | Use only `a-z`, `0-9`, `-`, `_` in space names |

---

## Common Gotchas

These issues compile without errors but fail at runtime.

### .get() is Not a Function

**Error:** `X.get is not a function`

**Cause:** Calling `.get()` on a `computed()` or `lift()` result. Only `Writable<>` types have `.get()`.

```typescript
// Given:
const filteredItems = computed(() => items.filter(item => !item.done));

// ✅ CORRECT - Access computed results directly
const count = filteredItems.length;
const paulinaItems = filteredItems.filter(item => item.owner === "paulina");

// Also correct for lift() results
const formattedValue = getFormattedDate(date);  // Access directly
```

**Access pattern summary:**
| Type | Has `.get()`? |
|------|---------------|
| `Writable<>` (pattern inputs with write access) | Yes |
| `computed()` results | No - access directly |
| `lift()` results | No - access directly |

### filter/map/find is Not a Function

**Error:** `X.filter is not a function` (or `.map`, `.find`, `.reduce`, etc.)

**Tempting but wrong diagnosis:** "I need to unwrap with `.get()`"

**Actual cause:** The value isn't an array (yet). This usually means:
1. The array hasn't been initialized (missing `Default<T[], []>`)
2. You're accessing a nested property that doesn't exist
3. A computed is returning the wrong type

```typescript
// ✅ CORRECT - Ensure array has a default value
interface Input {
  items: Default<Item[], []>;  // Defaults to empty array
}

// ✅ CORRECT - Inside computed(), just use the value directly
const activeItems = computed(() => items.filter(item => !item.done));

// ✅ CORRECT - Writable<T[]> requires .get() to access the array
const handleClear = handler<never, { items: Writable<Item[]> }>(
  (_, { items }) => {
    const done = items.get().filter(item => item.done);  // .get() because items is Writable<>
    // ...
  }
);
```

**Diagnostic questions:**
1. Is the source a `Writable<>`? → Use `.get()` to read the value
2. Is it a `computed()` or `lift()` result? → Access directly, no `.get()`
3. Is the value possibly undefined? → Add `Default<T[], []>` to the interface

### Reactive Reference Outside Context

**Error:** `Tried to access a reactive reference outside a reactive context`

**Cause:** Using a reactive value (from `.map()` iteration) to index into a plain JavaScript object.

```typescript
const STYLES = {
  pending: { color: "#92400e" },
  active: { color: "#1e40af" },
};

// ✅ CORRECT - Use lift() for object indexing
const getStyleColor = lift((status: Status): string => STYLES[status].color);

items.map((item) => (
  <div style={{ color: getStyleColor(item.status) }}>
    {item.title}
  </div>
));
```

**Why this happens:** Inside `.map()`, each item's properties are reactive references. Using them to index plain objects (`STYLES[item.status]`) tries to access the reactive reference outside a reactive context. The `lift()` function creates a proper reactive context for the lookup.

See [REACTIVITY.md](REACTIVITY.md#using-reactive-values-to-index-objects-in-map) for more examples.

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

### lift() Returns Stale/Empty Data

**Symptom:** `lift()` returns 0, empty object, or stale values even when the source cell has data.

```typescript
// ❌ WRONG: Passing cell directly to lift()
const calcTotal = lift((expenses: Expense[]): number => {
  return expenses.reduce((sum, e) => sum + e.amount, 0);
});
const total = calcTotal(expenses);  // Returns 0!

// ✅ CORRECT: Use computed() instead
const total = computed(() => {
  const exp = expenses.get();
  return exp.reduce((sum, e) => sum + e.amount, 0);
});

// ✅ CORRECT: If using lift(), pass as object parameter
const calcTotal = lift((args: { expenses: Expense[] }): number => {
  return args.expenses.reduce((sum, e) => sum + e.amount, 0);
});
const total = calcTotal({ expenses });
```

**Why:** `lift()` creates a new frame, and cells cannot be accessed via closure across frames. `computed()` gets automatic closure extraction by the CTS transformer; `lift()` does not. Use `computed()` by default in patterns.

### Handler Binding Error: Unknown Property

**Error:** `Object literal may only specify known properties, and 'X' does not exist in type 'Opaque<{ state: unknown; }>'`

**Symptom:** Trying to pass event data when binding a handler.

```typescript
// ❌ WRONG: Passing event data at binding time
const addItem = handler<
  { title: string },               // Event type
  { items: Writable<Item[]> }      // State type
>(({ title }, { items }) => { items.push({ title }); });

<button onClick={addItem({ title: "Test", items })}>  // Error!

// ✅ CORRECT: For test buttons, use inline handler
<button onClick={() => items.push({ title: "Test" })}>

// ✅ CORRECT: For real handlers, bind with state only
<ct-message-input onct-send={addItem({ items })} />
// Event data ({ title }) comes from component at runtime
```

**Why:** Handlers have two-step binding: you pass **state only** when binding. Event data comes **at runtime** from the UI component. For test buttons with hardcoded data, use inline handlers instead.

### Stream.of() / .subscribe() Don't Exist

**Error:** `Property 'subscribe' does not exist on type 'Stream<...>'`

**Symptom:** Trying to create streams with `Stream.of()` and subscribe to them.

```typescript
// ❌ WRONG: This API doesn't exist
const addItem: Stream<{ title: string }> = Stream.of();
addItem.subscribe(({ title }) => {
  items.push({ title });
});

// ✅ CORRECT: A bound handler IS the stream
const addItemHandler = handler<{ title: string }, { items: Writable<Item[]> }>(
  ({ title }, { items }) => { items.push({ title }); }
);
const addItem = addItemHandler({ items });  // This IS Stream<{ title: string }>

// Export it directly
return { addItem };
```

**Why:** Streams aren't created directly - they're the result of binding a handler with state. The bound handler IS the stream that can receive events.

---

## Type Errors

### Wrong Type for Binding

**Error:** Type mismatch when binding to `$checked` or similar

❌ **Problem:** Trying to bind the whole item instead of a property

```typescript
<ct-checkbox $checked={item} />  {/* Trying to bind entire item */}
```

✅ **Solution:** Bind the specific property

```typescript
<ct-checkbox $checked={item.done} />  {/* Bind the boolean property */}
```

### Writable<T[]> vs Writable<Array<Writable<T>>>

Use `Writable<T[]>` by default. Only use `Writable<Array<Writable<T>>>` when you need Writable methods on individual elements:

```typescript
// ✅ Standard - Writable<T[]>
const addItem = handler<unknown, { items: Writable<Item[]> }>(
  (_, { items }) => items.push({ title: "New" })
);

// ✅ Advanced - Writable<Array<Writable<T>>> for .equals()
const removeItem = handler<
  unknown,
  { items: Writable<Array<Writable<Item>>>; item: Writable<Item> }
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

**Related issue with lift():**

The same scoping limitation applies to `lift()`. See [REACTIVITY.md](REACTIVITY.md#lift-and-closure-limitations) for the workaround pattern and explanation of frame-based execution.

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
  const handleSearch = handler<{ detail: { message: string } }, { searchQuery: Writable<string> }>(
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

## Development Best Practices

### Use Isolated Spaces for Testing

A charm with an infinite loop or high CPU usage can make an entire space unusable. When you visit a space URL, all charms in that space may be loaded - if one loops, the space becomes unresponsive.

**Symptoms:**
1. Deploy a charm that causes infinite loop or 100% CPU
2. Server becomes unresponsive, needs restart
3. After restart, visiting the space triggers the loop again
4. Space is effectively "poisoned" until the charm is removed

**Prevention:** Use isolated spaces for testing new patterns:

```bash
# ❌ Don't test in your main space
--space my-production-space

# ✅ Use throwaway spaces for testing
--space test-feature-1
--space debug-session-2
```

This way, if a charm causes issues, you don't lose access to your main space with other working charms.

---

## Debugging Workflow

### 1. Check TypeScript Errors

```bash
deno task ct dev pattern.tsx --no-run
```

Fix all type errors before deploying. Most issues are caught here.

### 2. Match Error to Doc

- **Type errors** → [TYPES_AND_SCHEMAS.md](TYPES_AND_SCHEMAS.md)
- **Reactivity issues** → [REACTIVITY.md](REACTIVITY.md)
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
| Can't call `.set()` | Add `Writable<T>` to type signature |
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

## CLI-Based Debugging

When patterns misbehave, the CLI often provides faster diagnosis than browser DevTools. This approach isolates data logic from UI rendering issues.

### When to Use CLI vs Browser

**Use CLI when:**
- Data transformations produce wrong results
- Computed values don't update as expected
- Handlers don't modify state correctly
- You need to test specific input combinations
- Debugging reactivity chains

**Use Browser when:**
- UI doesn't render correctly
- Bidirectional binding issues (visual symptoms)
- Visual/styling problems
- Event handling doesn't trigger (click handlers, etc.)

### Stale Computed Values After `charm set`

**Gotcha:** `charm set` updates data but does NOT trigger computed re-evaluation. You must run `charm step` after `set` to get fresh computed values.

```bash
# WRONG: Returns stale computed values
echo '[...]' | deno task ct charm set --charm ID expenses ...
deno task ct charm get --charm ID totalSpent ...  # May return old value!

# CORRECT: Run charm step to trigger recompute
echo '[...]' | deno task ct charm set --charm ID expenses ...
deno task ct charm step --charm ID ...  # Runs scheduling step, triggers recompute
deno task ct charm get --charm ID totalSpent ...  # Now correct
```

### Quick Diagnostic Sequence

```bash
# 1. What's the full state?
deno task ct charm inspect --charm <charm-id> -i claude.key -a URL -s space

# 2. What are the inputs?
deno task ct charm get --charm <charm-id> /input -i claude.key -a URL -s space

# 3. What's a specific computed value?
deno task ct charm get --charm <charm-id> myComputedField -i claude.key -a URL -s space

# 4. Set known input, trigger recompute, verify output
echo '{"items":[{"title":"test","done":false}]}' | \
  deno task ct charm set --charm <charm-id> /input -i claude.key -a URL -s space
deno task ct charm step --charm <charm-id> -i claude.key -a URL -s space
deno task ct charm get --charm <charm-id> itemCount -i claude.key -a URL -s space
```

### Common CLI Debugging Patterns

**"Computed value is stale":**
1. Set input via CLI
2. **Run `charm step` to trigger re-evaluation**
3. Get computed value via CLI
4. If CLI shows correct value but browser doesn't → issue is UI layer
5. If CLI shows wrong value → issue is in computed logic

**"Handler doesn't work":**
1. Inspect state before calling handler
2. Call handler via CLI with test payload
3. Inspect state after
4. Compare to see if state changed as expected

**"Don't know what data structure to expect":**
1. Deploy minimal pattern
2. `charm inspect` shows actual runtime structure
3. Use this to understand Cell wrapping, array shapes, etc.

**"Filtering/sorting not working":**
1. Set test data with known values via CLI
2. Get the filtered/sorted computed value
3. Verify the transformation logic in isolation

### The setsrc Workflow for Debugging

When iterating on fixes, always use `setsrc` instead of `new`:

```bash
# Make a fix to your pattern, then:
deno task ct charm setsrc --charm <charm-id> pattern.tsx -i claude.key -a URL -s space

# Test again
deno task ct charm get --charm <charm-id> brokenField -i claude.key -a URL -s space
```

This keeps you working with the same charm instance, preserving any test data you've set up.

---

## See Also

- [REACTIVITY.md](REACTIVITY.md) - Reactivity system
- [TYPES_AND_SCHEMAS.md](TYPES_AND_SCHEMAS.md) - Type system
- [COMPONENTS.md](COMPONENTS.md) - UI components
- [CELL_CONTEXT.md](CELL_CONTEXT.md) - Debug tool details
