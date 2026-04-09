## Prefer Plain Ternaries

Use regular ternary operators in authored pattern code when the conditional
result flows into JSX or returned pattern values. The transformer lowers many
common expression sites automatically.

```tsx
// JSX children
{show ? <div>Content</div> : null}

// Text labels and prop/style values
<button disabled={loading}>
  {loading ? "Loading..." : "Load"}
</button>
<div style={{ opacity: done ? 0.6 : 1 }}>
  {done ? "Done" : "Todo"}
</div>

// Local aliases used by JSX
const modalTitle = editing ? "Edit Person" : "Add Person";

// Nested ternaries work too
{score >= 90 ? "A" : score >= 80 ? "B" : "C"}
```

Common lowered sites include:

- JSX children
- prop values
- inline text and template literals
- style/object property values
- local consts later consumed by JSX
- returned object fields

You usually do not need to author `ifElse()` directly for render-time
conditionals.

## Keep `computed()` for Data, Not UI Gating

Inside a `computed()` body, ternaries are plain JavaScript, not transformer
lowered conditionals. That means `Writable<boolean>` values are just truthy
objects there.

Use plain ternaries in authored expression positions instead of wrapping JSX in
`computed()`. If you're unsure whether a site lowers the way you expect, inspect
it with `deno task cf check <pattern>.tsx --show-transformed`.

## See Also

- [computed()](../concepts/computed/computed.md) — when to derive data vs gate UI
- [View Switching](./view-switching.md) — switching between entire sub-patterns or cell references
