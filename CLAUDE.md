# Development Guide

## Build & Test Commands

- Check typings: `deno task check`
- Run all tests: `deno task test-all`
- Run single test: `deno test path/to/test.ts`
- Run specific package tests: `cd package-name && deno task test`

## Code Style Guidelines

### Formatting

- Line width: 80 characters
- Indentation: 2 spaces
- Semicolons: required
- Double quotes for strings
- ALWAYS Auto-format with: `deno fmt`

### TypeScript

- Export types explicitly with `export type { ... }`
- Use descriptive JSDoc comments for public interfaces
- Prefer strong typing with interfaces/types over any

### Imports

- Group imports by source (std lib, external, internal)
- Prefer named exports over default exports
- Use package names for internal imports
- Use destructuring for multiple imports from same source

### Error Handling

- Use descriptive error messages
- Properly propagate errors with async/await
- Document error scenarios with JSDoc

### Testing

- Use `@std/testing/bdd` (describe/it) for test structure
- Use `@std/expect` for assertions
- Name tests descriptively
