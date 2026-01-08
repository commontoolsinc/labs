# Repository Guidelines for AI Agents

This repository represents the Common Tools runtime: a fully integrated,
reactive runtime and execution environment for user-created programs. These
programs are known as patterns and somewhat similar to Solid.js components. Each
pattern is comprised of reactive `Cell`s stored in `Space`s (defined by a DID).
These cells enable durable communication between patterns. The reactivity is
enabled by subscribing to the result of a query, defined by the schemas/type
signatures.

## Pace Layers

This repository contains many packages that compose and stack to create the
Common Tools product.

1. Foundation: api, runtime, identity, memory
2. System: schema-generator, iframe-sandbox, ts-transformers, js-compiler,
   js-sandbox
3. Capabilities: charm, html, llm
4. Operation: background-charm-service, cli
5. Deployed Product: toolshed, shell
6. User Interface: ui
7. End-User Programs: home-schemas, patterns

## Pattern Development

If you are developing patterns, use Claude Skills (pattern-dev) to do the work.

### Useful Recipe/Pattern documentation

**Start here:**

- `docs/common/PATTERNS.md` - Main tutorial with examples, levels, and common
  patterns (START HERE for learning)
- `docs/common/COMPONENTS.md` - UI component reference with bidirectional
  binding and event handling

**Core concepts:**

- `docs/common/REACTIVITY.md` - Cell system, computed(), reactivity mental
  models (when Writable<> is needed for write access)
- `docs/common/TYPES_AND_SCHEMAS.md` - Type system, Cell<> vs OpaqueRef<>,
  Default<>, when to use [ID]

**Workflow:**

- `docs/development/DEBUGGING.md` - Error reference, debugging workflows,
  troubleshooting
- `docs/common/LLM.md` - Using generateText and generateObject for LLM
  integration

**Reference:**

- `packages/patterns/INDEX.md` - Catalog of all pattern examples with summaries,
  data types, and keywords

**Important:** Ignore the top level `recipes` folder - it is defunct.

## Runtime Development

If you are developing runtime code, read the following documentation:

- `docs/common/RUNTIME.md` - Running servers, testing, and runtime package
  overview
- `docs/development/DEVELOPMENT.md` - Coding style, design principles, and best
  practices
- `docs/development/UI_TESTING.md` - How to work with shadow dom in our
  integration tests
- `docs/development/LOCAL_DEV_SERVERS.md` - **CRITICAL**: How to start local dev
  servers correctly (use `dev-local` for shell, not `dev`)
