# Pattern Development Learnings

This document captures learnings and tips discovered while developing patterns
with the Common Tools framework.

## API Usage Tips

- Use `derive` as a convenience wrapper around `lift`: `derive(x, x => x+1)` is
  equivalent to `lift(x => x+1)(x)`
- Prefer `Default<type, value>` in type declarations over `.setDefault`
- Avoid deprecated APIs: `compute` and `render`

## Pattern Design Guidelines

- Keep patterns offline-friendly (no network or LLM dependencies)
- Follow existing conventions from the patterns directory
- Use CTS APIs: `handler`, `recipe`, `lift`, `str`, `cell`, `createCell`

## Testing Notes

- Run tests with: `deno test --allow-env --allow-read --allow-write --allow-ffi`
- Format code with `deno fmt` before committing
- Only build one test case at a time

## Common Issues and Solutions

### Pattern File Structure

- Pattern files use `.pattern.ts` extension for non-UI patterns and
  `.pattern.tsx` for UI patterns
- Scenario files use `.ts` extension and export a `scenarios` array
