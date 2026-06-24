# Immediate Event Invocation

**Symptom:** Pattern tests or runtime checks report a non-idempotent `raw:map`,
`Too many iterations: ... raw:map`, link-resolution churn, or an action timeout
after rendering a list.

**Cause:** A JSX event prop is invoking a stream or mutation while the UI is
rendering, instead of passing a handler to run later.

```tsx
// Shown inside a pattern body.
// WRONG - sends during render
{items.map((item, index) => (
  <cf-button onClick={selectItem.send(index)}>Select</cf-button>
))}
```

In a mapped row this is especially dangerous: the render-time send or write can
mutate the same array that `raw:map` is rendering. That retriggers the map,
which sends or writes again, and the scheduler may never settle.

## Fix

Pass a handler or stream value to the event prop. If the stream needs an
argument, wrap the `.send(...)` call in a callback so it runs only when the
event fires.

```tsx
// Shown inside a pattern body.
// CORRECT - sends only when clicked
{items.map((item, index) => (
  <cf-button onClick={() => selectItem.send(index)}>Select</cf-button>
))}
```

When the same behavior is reused with different state bindings, prefer a
module-scope `handler()` and bind it inside the map.

```tsx
// Shown for illustration only.
const deleteItem = handler<void, { items: Writable<Item[]>; index: number }>(
  (_, { items, index }) => items.set(items.get().toSpliced(index, 1)),
);

export default pattern(({ items }) => ({
  [UI]: (
    <>
      {items.map((item, index) => (
        <cf-button onClick={deleteItem({ items, index })}>Delete</cf-button>
      ))}
    </>
  ),
}));
```

## Diagnosis Checklist

When a failure names `raw:map`:

1. Inspect every `.map(...)` body in the pattern.
2. Look for event props such as `onClick`, `oncf-change`, or `oncf-input` whose
   value calls `.send(...)`, `.set(...)`, `.push(...)`, `.remove(...)`, or any
   mutating helper immediately.
3. Check for other render-time writes in JSX value positions.
4. If the issue is still unclear, run
   `deno task cf check <pattern>.tsx --show-transformed` and inspect the mapped
   section for derived values that call streams or writes during render.

## See Also

- [Handler Binding Error](handler-binding-error.md)
- [onClick Inside computed()](onclick-inside-computed.md)
- [Reactivity Issues](../reactivity-issues.md)
- [Non-Idempotent Detection](../non-idempotent-detection.md)
