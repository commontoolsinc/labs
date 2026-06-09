# onClick Inside computed()

**Error:** "ReadOnlyAddressError: Cannot write to read-only address"

```typescript
// WRONG - Buttons inside computed() fail when clicked
{computed(() =>
  showAdd ? <cf-button onClick={addItem({ items })}>Add</cf-button> : null
)}

// CORRECT - Move button outside, use disabled attribute
<cf-button onClick={addItem({ items })} disabled={computed(() => !showAdd)}>
  Add
</cf-button>

// CORRECT - Or use ifElse instead of computed
{ifElse(showAdd, <cf-button onClick={addItem({ items })}>Add</cf-button>, null)}
```

**Why:** `computed()` creates read-only inline data addresses. Always render buttons at the top level and control visibility with `disabled`.

## Variant: a conditional `onClick` leaves a raw function

A handler gated by a ternary — `cond ? (() => stream.send(...)) : undefined` (e.g.
enabling a list row only when it's openable) — is NOT recognized by the JSX
transform. The ternary wrapper leaves a raw function as the prop value, which fails
settle validation:

```
Error: Action returned a function at path "...props.onClick".
Actions must return JSON-serializable values, OpaqueRefs, or Cells.
```

The transform recognizes a **direct** `onClick={() => stream.send(payload)}` (and
`onClick={handler}`) and compiles it to a serializable handler reference; the
ternary defeats that match.

```tsx
// WRONG - ternary leaves a raw function (or undefined)
onClick={isOpenable
  ? (() => isFolder ? openFolder.send({ id }) : openFile.send({ id }))
  : undefined}

// CORRECT - unconditional `() => action.send(payload)`; gate inside the action
onClick={() => openEntry.send({ id: item.id, name: item.name, kind: item.kind })}

const openEntry = action(({ id, name, kind }) => {
  if (/* not openable */) return;            // no-op for disabled rows
  /* …route folder vs file… */
});
```

Pass only direct `item.*` property reads in the payload — mapped-row closures that
capture derived locals can hit `closure-capture-in-nested-map.md`.

## See Also

- @common/concepts/reactivity.md - Reactivity system and computed()
- @common/components/COMPONENTS.md - UI components and event handling
