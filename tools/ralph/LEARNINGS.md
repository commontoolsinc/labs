# Pattern Development Learnings

This document captures learnings and tips discovered while developing patterns
with the Common Tools framework.

## API Usage Tips

- Use `derive` as a convenience wrapper around `lift`: `derive(x, x => x+1)` is
  equivalent to `lift(x => x+1)(x)`
- Prefer `Default<type, value>` in type declarations over `.setDefault`
- Avoid deprecated APIs: `compute` and `render`

## Working with Arrays in Cells

- If you have a cell that stores an array, you cannot directly use `.filter()`
  or `.slice()` on the cell
- Cells DO support `.map()` for iteration
- To manipulate arrays, use one of these approaches:
  - `get()` to extract the raw JavaScript array
  - `derive()` to create a derived value from the array
  - `lift()` to transform the array functionally
- Example: `derive(myArrayCell, arr => arr.filter(item => item.active))`

## Conditional Rendering with ifElse

- Use `ifElse(condition, trueValue, falseValue)` for conditional rendering in UI
- Import from commontools: `import { ifElse } from "commontools"`
- Works with cells directly - no need to call `.get()`
- Examples:
  - Display text: `{ifElse(enabled, "ON", "OFF")}`
  - Show/hide elements: `{ifElse(hasData, <DataView />, <EmptyState />)}`
  - Dynamic values: `{ifElse(!items?.length, "No items", items)}`
- Commonly used for toggling UI based on boolean cells or checking array lengths

## Pattern Design Guidelines

- Keep patterns offline-friendly (no network or LLM dependencies)
- Follow existing conventions from the patterns directory
- Use CTS APIs: `handler`, `pattern`, `lift`, `str`, `cell`, `createCell`

## Testing Notes

- Run tests with: `deno test --allow-env --allow-read --allow-write --allow-ffi`
- Format code with `deno fmt` before committing
- Only build one test case at a time

## Common Issues and Solutions

### Pattern File Structure

- Pattern files use `.pattern.ts` extension for non-UI patterns and
  `.pattern.tsx` for UI patterns
- Scenario files use `.ts` extension and export a `scenarios` array
