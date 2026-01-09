# Reactivity Issues

## Data Not Updating

**Issue:** UI doesn't update when data changes

**Check 1:** Missing `$` prefix for bidirectional binding?

```typescript
// Not bidirectional - won't update automatically
<ct-checkbox checked={item.done} />

// Bidirectional - updates automatically
<ct-checkbox $checked={item.done} />
```

**Check 2:** Using handler when bidirectional binding would work?

```typescript
// Unnecessary handler
const toggle = handler(({ detail }, { item }) => {
  item.set.key("done").set(detail.checked);
});
<ct-checkbox checked={item.done} onct-change={toggle({ item })} />

// Use bidirectional binding instead
<ct-checkbox $checked={item.done} />
```

**Check 3:** Wrong event name for handler?

Each component has specific event names. Check @common/components/COMPONENTS.md for the right event:

```typescript
// Wrong event name
<ct-checkbox onChange={...} />

// Correct event name
<ct-checkbox onct-change={...} />
```

## Filtered/Sorted List Not Updating

**Issue:** Filter or sort doesn't update when dependencies change

**Problem:** Inline filtering/transformations in JSX don't create reactive dependencies

```typescript
{items.filter(item => !item.done).map(...)}  {/* Won't update! */}
```

**Solution:** Use `computed()` outside JSX, then map over the result

```typescript
const activeItems = computed(() => items.filter(item => !item.done));
{activeItems.map(...)}  {/* Updates reactively! */}
```

**The Pattern:** Compute transformations (filter, sort, group) outside JSX using `computed()`, then map over the computed result inside JSX. Mapping over `computed()` results is the canonical pattern.

## Conditional Rendering Not Working

**Issue:** Ternary operator doesn't work for conditional rendering

**Problem:** Ternaries don't work for conditional elements

```typescript
{showDetails ? <div>Details</div> : null}  {/* Won't work! */}
```

**Solution:** Use `ifElse()` for conditional rendering

```typescript
{ifElse(showDetails, <div>Details</div>, null)}  {/* Works! */}
```

**Note:** Ternaries DO work in JSX attributes for simple values:

```typescript
// Ternaries work in attributes
<span style={item.done ? { textDecoration: "line-through" } : {}}>
  {item.title}
</span>
```

## Variable Scoping in Reactive Contexts

**Issue:** Can't access variable from outer scope in `computed()`

**Problem:** Variables from outer scopes aren't accessible in nested reactive contexts

```typescript
{categories.map((category) => (
  <div>
    {computed(() =>
      items.filter(i => i.category === category)  // category not accessible!
    )}
  </div>
))}
```

**Solution:** Pre-compute grouped data

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

The same scoping limitation applies to `lift()`. See @common/concepts/reactivity.md for the workaround pattern and explanation of frame-based execution.

## See Also

- @common/concepts/reactivity.md - Reactivity system fundamentals
- @common/components/COMPONENTS.md - Component binding patterns
- @common/components/CELL_CONTEXT.md - Debugging cell values
