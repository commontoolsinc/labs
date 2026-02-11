# Debugging Workflow

## 5-Step Debugging Process

### 1. Check TypeScript Errors

```bash
deno task ct check pattern.tsx --no-run
```

Fix all type errors before deploying. Most issues are caught here.

### 2. Match Error to Doc

- **Type errors** - [@writeable](../../common/concepts/types-and-schemas/writeable.md)
- **Reactivity issues** - [@reactivity](../../common/concepts/reactivity.md)
- **Component questions** - [@COMPONENTS](../../common/components/COMPONENTS.md)
- **Pattern examples** - [@index](../../../packages/patterns/index.md)

### 3. Inspect Cell Values

Use `<ct-cell-context>` for on-demand value inspection:

```tsx
<ct-cell-context $cell={result} label="Result">
  <div>{result.value}</div>
</ct-cell-context>
```

Hold **Alt** and hover to access debugging toolbar (val, id, watch/unwatch).

### 4. Inspect Deployed Piece

```bash
deno task ct piece inspect --identity key.json --api-url URL --space SPACE --piece ID
```

### 5. Simplify Until It Works

1. Comment out code until you have a minimal working pattern
2. Add back features one at a time
3. Test after each addition

## Quick Fixes

| Problem | Fix |
|---------|-----|
| Can't call `.set()` | Add `Writable<T>` to type signature |
| Filter not updating | Use `computed(() => items.filter(...))` |
| Checkbox not syncing | Use `$checked` not `checked` |
| Style not applying | Check element type (object vs string syntax) |
| LLM in handler | Move `generateText` to pattern body |
| UI blocking | Use `fetchData` instead of `await` in handlers |

## 6. Check Logger Stats

Use `globalThis.commontools` in the browser console to inspect runtime metrics:

```javascript
// See which loggers exist and their call counts
commontools.getLoggerCountsBreakdown()

// Check timing stats (IPC latency, cell operations, etc.)
commontools.getTimingStatsBreakdown()

// Check for actions with invalid inputs (schema mismatches)
commontools.getLoggerFlagsBreakdown()

// Enable a disabled logger for more detail
commontools.logger["runner"].disabled = false
commontools.logger["runner"].level = "debug"
```

See [console-commands](./console-commands.md) for the full reference.

## See Also

- [@CELL_CONTEXT](../../common/components/CELL_CONTEXT.md) - Cell debugging tool details
- [Logger System](./logger-system.md) - Logger architecture and API
- [Console Commands](./console-commands.md) - Browser console reference
- [cli-debugging](./cli-debugging.md) - CLI-based debugging workflows
- [testing](./testing.md) - Testing patterns locally and deployed
