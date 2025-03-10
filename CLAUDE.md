# Deno Labs Codebase Guidelines

## Commands
* Run all tests: `deno task test-all`
* Run package tests: `cd <package-dir> && deno task test`
* Run specific test: `deno test path/to/file.test.ts`
* Run browser test: `deno run -A deno-web-test/cli.ts path/to/file.test.ts`
* Type check: `deno check` or `deno task check` (all packages)
* Lint: `deno lint` or `deno lint path/to/file.ts`
* Format: `deno fmt` or `deno fmt --check`
* Build jumble: `cd jumble && deno task build`
* Dev server: `cd <package-dir> && deno task dev`

## Style Guidelines
* **TypeScript**: Strong typing with minimal use of `any`
* **Formatting**: 2-space indentation, 80-char line width, semicolons
* **Imports**: Sort imports alphabetically by source
* **Naming**: camelCase for variables/functions, PascalCase for classes/components/types
* **Error Handling**: Prefer explicit error handling with descriptive messages
* **Comments**: Use JSDoc for functions and complex logic
* **React**: Functional components with hooks, explicit prop types
* **Testing**: Unit tests for core functionality, integration tests for critical paths