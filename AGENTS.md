# Repository Guidelines for Codex

The instructions in this document apply to the entire repository.

## Build & Test

- Check typings with `deno task check`.
- Run all tests using `deno task test-all`.
- To run a single test file use `deno test path/to/test.ts`.
- To test a specific package, `cd` into the package directory and run
  `deno task test`.

## Formatting

- Line width is **80 characters**.
- Indent with **2 spaces**.
- **Semicolons are required.**
- Use **double quotes** for strings.
- Always run `deno fmt` before committing.

## TypeScript

- Export types explicitly using `export type { ... }`.
- Provide descriptive JSDoc comments on public interfaces.
- Prefer strong typing with interfaces or types instead of `any`.

## Imports

- Group imports by source: standard library, external, then internal.
- Prefer named exports over default exports.
- Use package names for internal imports.
- Destructure when importing multiple names from the same module.

## Error Handling

- Write descriptive error messages.
- Propagate errors using async/await.
- Document possible errors in JSDoc.

## Testing

- Structure tests with `@std/testing/bdd` (`describe`/`it`).
- Use `@std/expect` for assertions.
- Give tests descriptive names.
