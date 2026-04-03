# Runtime Errors

## No Direct DOM Access

Patterns run in a sandboxed environment. DOM APIs don't work:

```typescript
// Won't work - DOM APIs not available in sandbox
const addItem = handler((_, { items }) => {
  const input = document.getElementById('item-input');  // Error!
  items.push({ title: input.value });
});

// Use cells to capture state (handler at module scope)
const addItem = handler<unknown, { items: Writable<Item[]>; itemTitle: Writable<string> }>(
  (_, { items, itemTitle }) => {
    const value = itemTitle.get();
    if (value.trim()) {
      items.push({ title: value });
      itemTitle.set("");
    }
  }
);

export default pattern<Input, Input>(({ items }) => {
  const itemTitle = Writable.of("");
  return {
    [UI]: (
      <div>
        <ct-input $value={itemTitle} />
        <ct-button onClick={addItem({ items, itemTitle })}>Add</ct-button>
      </div>
    ),
    items,
  };
});
```

## Async Operations Block UI

Using `await` in handlers blocks the entire UI:

```typescript
// Blocks UI - async handlers block the entire UI
const handleFetch = handler(async (_, { url, result }) => {
  const response = await fetch(url.get());  // BLOCKS!
  const data = await response.json();
  result.set(data);
});

// Use fetchData - reactive, non-blocking
// Handler at module scope - just updates the query
const handleSearch = handler<{ detail: { message: string } }, { searchQuery: Writable<string> }>(
  ({ detail }, { searchQuery }) => searchQuery.set(detail.message)
);

export default pattern(({ searchQuery }) => {
  const searchUrl = computed(() =>
    searchQuery ? `/api/search?q=${encodeURIComponent(searchQuery)}` : ""
  );
  const { result, error, loading } = fetchData({ url: searchUrl });

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

**Rule:** Handlers should be synchronous state changes defined at module scope. Use `fetchData` for async operations.

## See Also

- @common/concepts/reactivity.md - Reactivity and fetchData patterns
- @common/concepts/types-and-schemas.md - Cell and Writable types
