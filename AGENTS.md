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

1. Foundation: api, data-model, runner, identity, memory
2. System: schema-generator, iframe-sandbox, ts-transformers, js-compiler
3. Capabilities: piece, html, llm
4. Operation: background-piece-service, cli, fuse, state-inspector, cf-harness
5. Deployed Product: toolshed, shell, lib-shell, runtime-client
6. User Interface: ui
7. End-User Programs: home-schemas, patterns

Support and test packages (utils, test-support, deno-web-test, integration,
generated-patterns, content-hash, leb128, felt, static, vendor-astral,
fs-sync-example) sit outside the layer stack.

## Documentation: live vs. historical

Documentation in this repository is split into two kinds, and the split is
load-bearing. See [`docs/README.md`](docs/README.md) for the map and
[`docs/history/README.md`](docs/history/README.md) for the frozen archive.

- **Live** documentation describes what the repo currently contains or intends
  to contain — specs, concepts, guides, conventions, tutorials, and plans not
  yet carried out. It lives everywhere under `docs/` except `docs/history/`, and
  alongside the code it documents. **Keep it up to date:** when you change
  behaviour, update the live docs that describe it in the same change.
- **Historical** documentation is a point-in-time record — an executed plan, a
  completed migration, an audit or investigation, a decision record, a removed
  feature's design. It lives under `docs/history/`. **Never edit it to reflect
  new reality;** it describes the past on purpose. If reality has moved on, write
  a new live document instead of rewriting the record.

The test for which is which: if the system changed, would someone edit this
document, or write a new one? Edit it → live. Write a new one and leave this
alone → historical.

**When you create a historical artifact** — a writeup of a migration, a report
on a plan you executed, an audit, an investigation's findings, a decision record
— put it under `docs/history/`, mirroring where it would otherwise live, and
start it (immediately under the title) with this exact header:

```
> **Historical — not maintained.** Created: YYYY-MM-DD.
> <one line on why it is historical>. See `docs/history/README.md` for what "historical" means here.
```

`Created` is the date you authored it. Do not leave such artifacts in the live
tree.

**When a live document becomes historical** — a plan you executed, a migration
that completed, a spec whose feature was removed or superseded — move it: add the
header above, relocate it under `docs/history/` (mirroring its path), fix inbound
links, and add an entry to the index in `docs/history/README.md`.

## Pattern Development

If you are developing patterns, use the repo-local `pattern-dev` skill at
`skills/pattern-dev/SKILL.md`. `skills/` is the canonical authored source. Codex
discovers the repo-local skill mirror through `.agents/skills/`, and Claude
compatibility continues to use `.claude/skills/`.

When authoring or reviewing a skill itself, read
`docs/development/skill-authoring.md` — what belongs in a skill (non-derivable
map & values) versus what just constrains the agent (procedure a capable model
already does).

### Useful Pattern documentation

**Start here:**

- `docs/common/README.md` - Overview of the pattern system and index of all
  pattern documentation
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
  data types, and keywords. Check its "Status tiers" section before imitating
  any pattern — only `exemplar` entries are style references.

**Important:** Ignore the `packages/patterns/deprecated` folder - it is defunct.

## Runtime Development

If you are developing runtime code, read the following documentation:

- `docs/development/DEVELOPMENT.md` - Coding style, design principles, and best
  practices
- `docs/development/LOCAL_DEV_SERVERS.md` - **CRITICAL**: How to start local dev
  servers correctly (use `dev-local` for shell, not `dev`)
- `docs/development/TESTING.md` - Running the test suites and the general unit
  and integration test structure; hub that links the other testing docs
- `docs/development/CI_PERFORMANCE.md` - When to stop or revisit CI wall-time
  splitting/rebalancing work
- `docs/development/COVERAGE.md` - The two coverage mechanisms (V8 runtime
  coverage and transformer-based pattern coverage), which CI job collects which,
  and why the pattern integration jobs do not set `CF_PATTERN_COVERAGE_DIR`
- `docs/development/LLM_TESTING.md` - Testing patterns and server routes that
  call the LLM (test-environment guard, mocks, conversation fixtures)
- `docs/development/patch-operations.md` - The patch-operation family (the
  single logical changes a commit carries), the registries that define each op
  once, and how to add a new one across the memory / runner / api / transformer
  layers
- `docs/development/UI_TESTING.md` - How to work with shadow dom in our
  integration tests
- `docs/development/debugging/` - Runtime errors, type errors, and
  troubleshooting

When investigating transformer behavior, inspect the emitted output directly
before inferring from source code alone:

```bash
deno task cf check <pattern-or-fixture>.tsx --show-transformed --no-run
```

The transformed output is dense. Pipe it into `cf view` for an interactive,
syntax-aware pager (less-like) that colours builders, schemas, closures and type
positions, and lets you navigate the structure tree (`wasd`), search (`/`) and
peek definitions. The text shown is verbatim — colour only:

```bash
deno task cf check <pattern>.tsx --show-transformed --no-run | deno task cf view
```

### Adding New Packages

When adding a new workspace package:

1. Add the package path (e.g., `./packages/my-package`) to the root `deno.jsonc`
   `"workspace"` array.
2. The package's `deno.jsonc` **must** include a `"tasks"` object with a
   `"test"` entry. Use `"deno test"` if the package has tests, or
   `"echo 'No tests defined.'"` as a stub for packages without tests yet.

This is required because the root test runner (`tasks/test.ts`) iterates all
workspace packages and runs `deno task test` in each. If a package has no test
task, Deno falls back to the root workspace's test task, which re-runs the
entire suite recursively — causing exponential process spawning and CI timeouts.

See `packages/utils/deno.jsonc` for an example of a correctly configured
package.
