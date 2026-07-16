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

## Documentation Lifecycle

Documentation is split into two categories with different obligations. The full
rules are in `docs/README.md`; the short version:

- **Live** documentation (everything outside `docs/history/`) describes the
  current system or pending plans. If your change alters behavior that a live
  document describes, update that document in the same change.
- **Historical** documentation (`docs/history/`) holds point-in-time records:
  audits, reports, investigation findings, executed plans, superseded designs.
  Never edit their content, and never treat them as descriptions of the current
  system.
- The test for which is which: if the system changed, would someone edit this
  document, or write a new one and leave this one alone? Edit it — live. Write a
  new one — historical.
- When you produce a point-in-time artifact (a report on completed work, an
  audit, a post-mortem), create it in `docs/history/` with the metadata header
  defined in `docs/history/README.md`.
- When a live plan or design reaches "done" or is abandoned — for example, your
  change lands its last phase — archive it to `docs/history/` following the
  procedure in `docs/README.md`.
- TypeScript and TSX code blocks under `docs/` are type-checked in CI by
  `deno task check-docs`. A block selects the scaffold it compiles inside with
  an opening context comment; `docs/check.md` defines that vocabulary, which is
  not derivable from the source.

## Engineering principles and coding style

### Avoid timeouts, retry loops, and sleeps

Timeouts cause flakiness because they put an upper bound on success: anything
that would have eventually completed cannot complete once it hits the timeout.

Retry loops mask errors: anything that should have succeeded first time now gets
missed because if it succeeds sometimes.

Sleeps are flaky and expensive: they increase the floor on the amount of time
operations take, and they rely on unpredictable timings to align for success.

Avoid all three; when you see them in existing code, point them out and suggest
starting an agent to remove them.

For tests, `docs/development/waiting-in-tests.md` is the canonical guidance. It
names the event-driven primitives to reach for instead of a poll, and the
specific cases where a bounded poll is the honest tool — read it before removing
one, so you don't strip a wait the repo keeps on purpose.

### Pattern Development

If you are developing patterns, use the repo-local `pattern-dev` skill at
`skills/pattern-dev/SKILL.md`. `skills/` is the canonical authored source. Codex
discovers the repo-local skill mirror through `.agents/skills/`, and Claude
compatibility continues to use `.claude/skills/`.

When authoring or reviewing a skill itself, read
`docs/development/skill-authoring.md` — what belongs in a skill (non-derivable
map & values) versus what just constrains the agent (procedure a capable model
already does). `docs/development/skill-audit.md` covers what keeps those facts
honest, including the `deno task check-skill-facts` tripwire that fails CI when
a path or import a skill cites stops resolving.

For Topics on Estuary, use the repo-local skill at `skills/topics/SKILL.md`.

#### Useful Pattern documentation

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

### Runtime Development

If you are developing runtime code, read the following documentation:

- `docs/development/DEVELOPMENT.md` - Coding style, design principles, and best
  practices
- `docs/development/LOCAL_DEV_SERVERS.md` - **CRITICAL**: How to start local dev
  servers correctly (use `dev-local` for shell, not `dev`)
- `docs/development/TESTING.md` - Running the test suites and the general unit
  and integration test structure; hub that links the other testing docs
- `docs/development/waiting-in-tests.md` - Waiting on a real event instead of
  polling: the primitives to use.
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
  layers. Its neighbour `mergeable-collection-writes.md` covers why the
  mergeable ops exist and what they do to conflict detection; read it before
  changing how a handler writes to a list
- `docs/development/UI_TESTING.md` - How to work with shadow dom in our
  integration tests
- `docs/development/EXPERIMENTAL_OPTIONS.md` - The central registry of every
  experimental flag (runtime experimental options, CFC enforcement dials,
  storage and memory-protocol capability flags, shell dogfood toggles): what
  each gates, its default, its planned end state, and its removal path. Read it
  before adding, changing, or removing any experimental flag, and update it in
  the same change.
- `docs/development/debugging/` - Runtime errors, type errors, and
  troubleshooting
- `docs/specs/ts-transformer/README.md` - **CTS transformer specs**: map of the
  pattern-language spec, lowering contract, and behavior spec (schema mapping:
  `docs/specs/schema-generator/ts_to_json_schema_mapping.md`). Working in those
  packages? Start at `packages/ts-transformers/AGENTS.md` /
  `packages/schema-generator/AGENTS.md`

When investigating transformer behavior, inspect the emitted output directly
before inferring from source code alone:

```bash
deno task cf check <pattern-or-fixture>.tsx --show-transformed --no-run
```

#### Adding New Packages

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
