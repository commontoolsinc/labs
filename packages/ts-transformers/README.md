# @commontools/ts-transformers

This package hosts CommonTools TypeScript AST transformers. It provides a shared
transformation context, import management utilities, and modular rule
implementations that can be reused by the runtime and tooling layers.

The initial scaffold focuses on core infrastructure. Transformers from
`@commontools/js-runtime` will migrate here incrementally alongside new
architecture work (e.g. OpaqueRef parity and closures support).

## Scripts

All commands are driven via `deno task`:

- `deno task test` — run transformer tests (placeholder until suites land)
- `deno task check` — type-check sources under `src/`
- `deno task fmt` — format source and future test files
- `deno task lint` — lint source and future test files

## Status

The package currently exports core context and import management helpers used to
compose future transformer rule sets. Production transformers will be ported in
subsequent phases.
