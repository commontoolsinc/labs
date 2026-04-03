# Type Errors

## Wrong Type for Binding

**Error:** Type mismatch when binding to `$checked` or similar

**Problem:** Trying to bind the whole item instead of a property

```typescript
<ct-checkbox $checked={item} />  {/* Trying to bind entire item */}
```

**Solution:** Bind the specific property

```typescript
<ct-checkbox $checked={item.done} />  {/* Bind the boolean property */}
```

## Writable<T[]> vs Writable<Array<Writable<T>>>

Use `Writable<T[]>` by default. Only use `Writable<Array<Writable<T>>>` when you need Writable methods on individual elements:

```typescript
// Standard - Writable<T[]>
const addItem = handler<unknown, { items: Writable<Item[]> }>(
  (_, { items }) => items.push({ title: "New" })
);

// Advanced - Writable<Array<Writable<T>>> for .equals()
const removeItem = handler<
  unknown,
  { items: Writable<Array<Writable<Item>>>; item: Writable<Item> }
>((_event, { items, item }) => {
  const index = items.get().findIndex(el => el.equals(item));
  if (index >= 0) items.set(items.get().toSpliced(index, 1));
});
```

## See Also

- @common/concepts/types-and-schemas.md - Type system fundamentals
- @common/concepts/reactivity.md - Reactivity and Cell types
- @common/components/COMPONENTS.md - Component binding patterns
