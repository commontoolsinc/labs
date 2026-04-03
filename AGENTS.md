# Repository Guidelines for AI Agents

This repository represents the Common Fabric runtime: a fully integrated,
reactive runtime and execution environment for user-created programs. These
programs are known as patterns and somewhat similar to Solid.js components. Each
pattern is comprised of reactive `Cell`s stored in `Space`s (defined by a DID).
These cells enable durable communication between patterns. The reactivity is
enabled by subscribing to the result of a query, defined by the schemas/type
signatures.

## Pace Layers

This repository contains many packages that compose and stack to create the
Common Fabric product.

1. Foundation: api, runtime, identity, memory
2. System: schema-generator, iframe-sandbox, ts-transformers, js-compiler,
   js-sandbox
3. Capabilities: piece, html, llm
4. Operation: background-piece-service, cli
5. Deployed Product: toolshed, shell
6. User Interface: ui
7. End-User Programs: home-schemas, patterns

## Pattern Development

If you are developing patterns, use the repo-local `pattern-dev` skill at
`skills/pattern-dev/SKILL.md`. `skills/` is the canonical authored source. Codex
discovers the repo-local skill mirror through `.agents/skills/`, and Claude
compatibility continues to use `.claude/skills/`.

### Useful Pattern documentation

**Start here:**

- `docs/common/INTRODUCTION.md` - Overview of the pattern system
- `packages/patterns/catalog/catalog.tsx` - Authoritative, type-checked
  component catalog; story files in `packages/patterns/catalog/stories/` show
  live usage for each component
- `docs/common/components/COMPONENTS.md` - UI component narrative reference with
  bidirectional binding and event handling

**Core concepts:**

- `docs/common/concepts/reactivity.md` - Cell system, reactivity mental models
- `docs/common/concepts/computed/` - computed(), lift(), derived values
- `docs/common/concepts/types-and-schemas/` - Type system, Writable<>, Default<>
- `docs/common/patterns/` - Common patterns (conditionals, composition, binding)

**Workflow:**

- `docs/development/debugging/` - Error reference, debugging workflows,
  troubleshooting
- `docs/common/capabilities/llm.md` - Using generateText and generateObject for
  LLM integration
- `docs/common/conventions/adding-pieces.md` - How to add pieces (use addPiece
  handler, not allPieces.push)

**Reference:**

- `packages/patterns/index.md` - Catalog of all pattern examples with summaries,
  data types, and keywords

**Important:** Ignore the top level `deprecated-patterns` folder - it is
defunct.

## Runtime Development

If you are developing runtime code, read the following documentation:

- `docs/development/DEVELOPMENT.md` - Coding style, design principles, and best
  practices
- `docs/development/LOCAL_DEV_SERVERS.md` - **CRITICAL**: How to start local dev
  servers correctly (use `dev-local` for shell, not `dev`)
- `docs/development/UI_TESTING.md` - How to work with shadow dom in our
  integration tests
- `docs/development/debugging/` - Runtime errors, type errors, and
  troubleshooting

### Adding New Packages

When adding a new workspace package:

1. Add the package path (e.g., `./packages/my-package`) to the root `deno.json`
   `"workspace"` array.
2. The package's `deno.json` **must** include a `"tasks"` object with a `"test"`
   entry. Use `"deno test"` if the package has tests, or
   `"echo 'No tests defined.'"` as a stub for packages without tests yet.

This is required because the root test runner (`tasks/test.ts`) iterates all
workspace packages and runs `deno task test` in each. If a package has no test
task, Deno falls back to the root workspace's test task, which re-runs the
entire suite recursively — causing exponential process spawning and CI timeouts.

See `packages/utils/deno.json` for an example of a correctly configured package.
