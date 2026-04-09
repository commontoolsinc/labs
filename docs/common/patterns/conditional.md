## Prefer Plain Ternaries

Use regular ternary operators at supported lowered value-expression sites. The
transformer recognizes a shared set of authored container kinds, not just JSX.

```tsx
// JSX expressions
{show ? <div>Content</div> : null}

// Returned object property values
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

The main author-facing buckets are:

- JSX expressions
- top-level pattern-body value-expression sites:
  - returned object property values
  - variable initializers
  - call arguments
  - array elements
  - return expressions
- callback-local value-expression sites inside supported reactive collection
  callbacks

In transformer source terms, those correspond to the current container kinds
`jsx-expression`, `return-expression`, `variable-initializer`,
`call-argument`, `object-property`, and `array-element`.

You usually do not need to author `ifElse()` directly for render-time
conditionals or simple conditional values in those sites. Authored helper
control flow remains supported when it is the clearest way to express the code.

## Keep `computed()` for Data, Not UI Gating

Inside a `computed()` body, the callback body itself is not a blanket lowered
value-expression site. Ternaries there are plain JavaScript unless they occur
inside a nested supported lowered site such as JSX. That means
`Writable<boolean>` values are just truthy objects there.

Use plain ternaries at supported lowered value-expression sites instead of
wrapping JSX in `computed()`. If you're unsure whether a site lowers the way
you expect, inspect it with
`deno task cf check <pattern>.tsx --show-transformed`.

## See Also

- [computed()](../concepts/computed/computed.md) — when to derive data vs gate UI
- [View Switching](./view-switching.md) — switching between entire sub-patterns or cell references
