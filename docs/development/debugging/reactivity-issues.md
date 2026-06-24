# Reactivity Issues

## Data Not Updating

**Issue:** UI doesn't update when data changes

**Check 1:** Missing `$` prefix for bidirectional binding?

```typescript
// Shown as JSX element children.
// Not bidirectional - won't update automatically
<cf-checkbox checked={item.done} />

// Bidirectional - updates automatically
<cf-checkbox $checked={item.done} />
```

**Check 2:** Using handler when bidirectional binding would work?

```typescript
// Shown as alternative snippets.
// Unnecessary handler
const toggle = handler(({ detail }, { item }) => {
  item.set.key("done").set(detail.checked);
});
<cf-checkbox checked={item.done} oncf-change={toggle({ item })} />

// Use bidirectional binding instead
<cf-checkbox $checked={item.done} />
```

**Check 3:** Wrong event name for handler?

Each component has specific event names. Check @common/components/COMPONENTS.md for the right event:

```typescript
// Shown for illustration only.
// Wrong event name
<cf-checkbox onChange={...} />

// Correct event name
<cf-checkbox oncf-change={...} />
```

## Filtered/Sorted List Not Updating

**Issue:** Filter or sort doesn't update when dependencies change

**Problem:** Inline filtering/transformations in JSX don't create reactive dependencies

```typescript
// Shown for illustration only.
{items.filter(item => !item.done).map(...)}  {/* Won't update! */}
```

**Solution:** Use `computed()` outside JSX, then map over the result

```typescript
// Shown for illustration only.
const activeItems = computed(() => items.filter(item => !item.done));
{activeItems.map(...)}  {/* Updates reactively! */}
```

**The Pattern:** Compute transformations (filter, sort, group) outside JSX using `computed()`, then map over the computed result inside JSX. Mapping over `computed()` results is the canonical pattern.

## Mapped List Churns or Times Out

**Issue:** Rendering a list triggers `non-idempotent raw:map`,
`Too many iterations: ... raw:map`, link-resolution churn, or a test action
timeout.

**Check:** Look for render-time writes inside the `.map()` body. Event props
must receive a handler to run later, not the result of calling a stream or
mutation immediately.

```tsx
// Shown inside a pattern body.
// Wrong - send runs while the row renders
{items.map((item, index) => (
  <cf-button onClick={selectItem.send(index)}>Select</cf-button>
))}

// Correct - send runs when clicked
{items.map((item, index) => (
  <cf-button onClick={() => selectItem.send(index)}>Select</cf-button>
))}
```

See [Immediate Event Invocation](gotchas/immediate-event-invocation.md) for the
full diagnosis checklist.

## Conditional Rendering Not Working

**Issue:** A conditional section doesn't render or update as expected

Plain authored ternaries ARE the idiom for conditional rendering — the
transformer lowers them to `ifElse()` for you, so you usually do not need to
author `ifElse()` directly. See
[Conditional Rendering](../../common/patterns/conditional.md).

```typescript
// Shown inside a pattern body.
// Preferred - the transformer handles this
{showDetails ? <div>Details</div> : null}

// Also fine in attributes and other value positions
<span style={item.done ? { textDecoration: "line-through" } : {}}>
  {item.title}
</span>
```

If a conditional section still misbehaves, check:

- **Eager branch evaluation:** both branches of the lowered `ifElse()` are
  evaluated as arguments, so property access on a nullable reactive value
  inside a branch can crash even when the condition is falsy. See
  [Eager Ternary Branch Evaluation](gotchas/eager-ternary-branch-evaluation.md).
- **Composed pattern cells:** condition cells taken directly from a composed
  sub-pattern can hang the piece. See
  [ifElse with Composed Pattern Cells](gotchas/quick.md#ifelse-with-composed-pattern-cells).
- **Unusual sites:** inspect the lowering with
  `deno task cf check <pattern>.tsx --show-transformed` rather than guessing.

## Variable Scoping in Reactive Contexts

**Issue:** Can't access variable from outer scope in `computed()`

**Problem:** Variables from outer scopes aren't accessible in nested reactive contexts

```typescript
// Shown inside a pattern body.
{categories.map((category) => (
  <div>
    {computed(() =>
      items.filter(i => i.category === category)  // category not accessible!
    )}
  </div>
))}
```

**Solution:** Pre-compute grouped data — but watch the receiver shape inside
the inner `.map(...)`. ⚠️ `(reactiveCall() ?? plain).map(...)` nested in
another `.map((row) => ...)` aborts pattern construction by hiding the cell
from the ts-transformer; see
[gotchas/closure-capture-in-nested-map.md](gotchas/closure-capture-in-nested-map.md).
The safe pre-bake is a top-level computed of plain data — the `?? []`
fallback below is a plain-array fallback, NOT a reactive-call wrapper:

```typescript
// Shown inside a pattern body.
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
    {/* Safe: `groupedItems[category]` is plain JS by the time the outer
        `categories.map` reaches it. */}
    {(groupedItems[category] ?? []).map(item => (
      <div>{item.title}</div>
    ))}
  </div>
))}
```

If `groupedItems` were itself something you'd read with `.get()`, hoist the
per-category list to its own top-level computed and map *that* directly —
don't write `(groupedItems.get() ?? {})[category]?.map(...)` inside the row
callback.

**Related issue with lift():**

The same scoping limitation applies to `lift()`. See @common/concepts/reactivity.md for the workaround pattern and explanation of frame-based execution.

## See Also

- @common/concepts/reactivity.md - Reactivity system fundamentals
- @common/components/COMPONENTS.md - Component binding patterns
- @common/components/CELL_CONTEXT.md - Debugging cell values
