```typescript
const searchQuery = Cell.of("");

// Reactive filtered list
const filteredItems = computed(() => {
  const query = searchQuery.toLowerCase();
  return items.filter(item =>
    item.title.toLowerCase().includes(query)
  );
});

return {
  [UI]: (
    <div>
      <ct-input $value={searchQuery} placeholder="Search..." />
      {filteredItems.map(item => <div>{item.title}</div>)}
    </div>
  ),
};
```
