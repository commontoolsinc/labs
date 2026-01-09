# Runtime Errors

## No Direct DOM Access

Patterns run in a sandboxed environment. DOM APIs don't work:

```typescript
// Won't work
const addItem = handler((_, { items }) => {
  const input = document.getElementById('item-input');
  const value = input.value;
  items.push({ title: value });
});

// Use cells to capture state
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

## Async Operations Block UI

Using `await` in handlers blocks the entire UI:

```typescript
// Blocks UI
const handleFetch = handler(async (_, { url, result }) => {
  const response = await fetch(url.get());  // BLOCKS!
  const data = await response.json();
  result.set(data);
});

// Use fetchData - reactive, non-blocking
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

## See Also

- @common/concepts/reactivity.md - Reactivity and fetchData patterns
- @common/concepts/types-and-schemas.md - Cell and Writable types
