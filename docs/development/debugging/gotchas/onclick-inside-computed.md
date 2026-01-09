# onClick Inside computed()

**Error:** "ReadOnlyAddressError: Cannot write to read-only address"

```typescript
// WRONG - Buttons inside computed() fail when clicked
{computed(() =>
  showAdd ? <ct-button onClick={addItem({ items })}>Add</ct-button> : null
)}

// CORRECT - Move button outside, use disabled attribute
<ct-button onClick={addItem({ items })} disabled={computed(() => !showAdd)}>
  Add
</ct-button>

// CORRECT - Or use ifElse instead of computed
{ifElse(showAdd, <ct-button onClick={addItem({ items })}>Add</ct-button>, null)}
```

**Why:** `computed()` creates read-only inline data addresses. Always render buttons at the top level and control visibility with `disabled`.

## See Also

- @common/concepts/reactivity.md - Reactivity system and computed()
- @common/components/COMPONENTS.md - UI components and event handling
