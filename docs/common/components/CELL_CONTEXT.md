<!-- @reviewed 2025-12-10 docs-rationalization -->

`<ct-cell-context>` designates a region of the page as pertaining to a particular cell. This creates a tree of cells annotating the entire interaction—like an accessibility tree, but for data. Currently used for debugging and inspection; future features will build on this structure.

# Automatic Injection

Every `[UI]` render is automatically wrapped in `ct-cell-context`. You get top-level piece debugging for free without any code changes.

# When to Use Manually

Add `ct-cell-context` sparingly—typically 1-2 per pattern at most. Use it for values that are:

- Important but otherwise difficult to access
- Intermediate calculations or API responses
- Values you'd otherwise debug with `console.log`

This is better than adding a `computed` with `console.log` because inspection is conditional—users can watch and unwatch values on demand rather than flooding the console.

```tsx
<ct-cell-context $cell={result} label="Calculation Result">
  <div>{result.value}</div>
</ct-cell-context>
```

# API

- `$cell` - The Cell to associate with this region
- `label` - Human-readable name shown in the toolbar (optional)
- `inline` - Display as inline-block instead of block (optional)

# Debugging

Hold **Alt** and hover over a cell context region to see the debugging toolbar:

- **val** - Log the cell value to console and set `globalThis.$cell` to the cell, making it accessible via the console for inspection (similar to Chrome's `$0` for elements)
- **id** - Log the cell's full address
- **watch/unwatch** - Subscribe to value changes; updates appear in the debugger's Watch List

# When NOT to Use

- Don't wrap every cell—reserve for important values
- Don't use for trivial or obviously-accessible values
- If a value is already easy to inspect via the UI, you probably don't need this
