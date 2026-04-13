## Prefer Plain Ternaries

Use regular ternary operators directly in normal pattern code. On current main,
the transformer handles ordinary authored ternaries in JSX and most other
common value-expression positions, so you usually do not need to author
`ifElse()` directly.

```tsx
// JSX expressions
{show ? <div>Content</div> : null}

// JSX prop/text values
<button disabled={loading}>
  {loading ? "Loading..." : "Load"}
</button>
<div style={{ opacity: done ? 0.6 : 1 }}>
  {done ? "Done" : "Todo"}
</div>

// Variable initializers
const modalTitle = editing ? "Edit Person" : "Add Person";

// Nested ternaries work too
{score >= 90 ? "A" : score >= 80 ? "B" : "C"}
```

This includes JSX expressions, common returned values, variable initializers,
and many callback-local expressions. If you're debugging a less common site,
inspect the emitted source with
`deno task cf check <pattern>.tsx --show-transformed` rather than guessing
about the lowering.

## Keep `computed()` for Data, Not UI Gating

Inside a `computed()` body, ternaries and logical operators stay plain
JavaScript even when nested inside returned JSX. That means
`Writable<boolean>` values are still just truthy objects there.

Use plain ternaries in normal pattern code instead of wrapping JSX in
`computed()`. If you're unsure whether a site lowers the way you expect,
inspect it with
`deno task cf check <pattern>.tsx --show-transformed`.

## See Also

- [computed()](../concepts/computed/computed.md) — when to derive data vs gate UI
- [View Switching](./view-switching.md) — switching between entire sub-patterns or cell references
