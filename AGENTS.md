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

Anything under `packages/` not named above — utilities, build tooling, test
support, internal dashboards, example code — sits outside the layer stack.

## Documentation Lifecycle

Whenever editing documentation, read [docs/README.md](docs/README.md) and follow
the rules therein. These include:

- **Live** documentation (everything outside `docs/history/`) describes the
  current system or pending plans. If your change alters behavior that a live
  document describes, update that document in the same change.
- Live documentation must be forward-looking, and should not refer to previous
  states of the repository or justify decisions based on past choices.
  Everything should stand on its own merits in a forward-looking fashion.
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
one, so you don't strip a wait the repo keeps on purpose. Its companion,
`docs/development/waiting-in-tests-rationale.md`, holds the analysis and case
studies behind those rules; read it when you need to know why a rule is what it
is, or before changing the wait machinery a rule describes.

### Pattern Development

If you are developing patterns, use the repo-local `pattern-dev` skill at
`skills/pattern-dev/SKILL.md`. `skills/` is the canonical authored source. Codex
discovers the repo-local skill mirror through `.agents/skills/`, and Claude
compatibility continues to use `.claude/skills/`.

`docs/common/README.md` indexes the pattern documentation; follow links from
there to what your task needs.

When authoring or reviewing a skill itself, read
`docs/development/skill-authoring.md` and `docs/development/skill-audit.md`.

For reading or changing Topics on Estuary, use `skills/topics/SKILL.md`.

**Important:** Ignore the `packages/patterns/deprecated` folder - it is defunct.

### Runtime Development

If you are developing runtime code, start with:

- `docs/development/DEVELOPMENT.md` - Coding style, design principles, and best
  practices
- `docs/development/LOCAL_DEV_SERVERS.md` - **CRITICAL**: How to start local dev
  servers correctly (use `dev-local` for shell, not `dev`)
- `docs/development/TESTING.md` - Running the test suites and the general unit
  and integration test structure; hub that links the other testing docs
- `docs/development/unit-test-coding-style.md` - How a unit test file is shaped:
  its location and name, the single top-level `describe()`, how an `it()`
  description is worded, `expect()` over `assert*()`, and the matcher traps that
  yield a test which cannot fail. Read it before writing a new test file; not
  every file in the tree follows it, so a neighbor is not evidence of it
- `docs/development/waiting-in-tests.md` - Waiting on a real event instead of
  polling: the primitives to reach for, and the specific cases where a bounded
  poll is the honest tool
- `docs/development/COVERAGE.md` - The two coverage mechanisms (V8 runtime
  coverage and transformer-based pattern coverage), which CI job collects which,
  and why the pattern integration jobs do not set `CF_PATTERN_COVERAGE_DIR`
- `docs/development/debugging/` - Runtime errors, type errors, and
  troubleshooting
- `docs/development/DEPENDENCIES.md` - Adding and rolling dependencies, required
  version pins, and dependency troubleshooting

Everything else is indexed rather than listed here. `docs/README.md` maps the
whole documentation tree. `docs/development/README.md` indexes the rest of the
development documentation: configuration, benchmarks, deploying, the
continuous-integration policies, and so on. `docs/features/README.md` indexes
one document per feature or per aspect of the runtime — collection writes,
identity, ingest, host embedding, and the rest. Read the relevant one before you
change a subsystem you have not worked on before.

Three obligations that are easy to miss:

- `docs/README.md` governs everything this repository writes down. It says how
  to write a comment in code, how to write documentation, which spelling of
  English both use, and where a new document belongs. Read it before you write
  either.
- `docs/development/EXPERIMENTAL_OPTIONS.md` is the central registry of every
  experimental flag. Read it before adding, changing, or removing a flag, and
  update it in the same change.
- `docs/development/space-clone-rehearsal.md` is the procedure for rehearsing a
  pattern update against a writable copy of a real space. Read it before any
  `setsrc` against a space that holds real data.

Working in `packages/ts-transformers` or `packages/schema-generator`? Start at
that package's own `AGENTS.md`.

#### Adding New Packages

A new workspace package needs two edits, and the second one bites hard when it
is missed:

1. Its path added to the `"workspace"` array in the root `deno.jsonc`.
2. A `"tasks"` object in its own `deno.jsonc` carrying a `"test"` entry — either
   `"deno test"`, or `"echo 'No tests defined.'"` when it has no tests yet.
   Without one, `deno task test` falls through to the root workspace's task and
   re-runs the whole suite inside itself, spawning processes exponentially until
   CI times out. `packages/utils/deno.jsonc` is a correct example.

When the package needs a dependency, follow `docs/development/DEPENDENCIES.md`.

## Instructions for committing to this repository

Before committing, squashing, or otherwise getting a branch ready to be reviewed
or landed: Execute repo-wide `deno fmt --check` and `deno lint` checks, and run
all relevant tests.

When babysitting a PR through CI, look for codex review comments in addition to
failed CI jobs. When facing difficulties getting coverage checks to pass,
consider the information in `docs/development/COVERAGE.md`.

### Automated gates

`deno task check` type-checks a hand-maintained list of paths in
`tasks/check.sh`. Several workspace packages are absent from that list — `fuse`,
`lib-shell`, `schema-generator`, `data-model` and `state-inspector` among them —
so a green `deno task check` is not evidence that the tree type-checks. Run
`deno task test` in every package you touched.

Each of these gates fails CI on its own, and none of them run as part of
`deno task check`:

- `deno task check-no-waitfor` — a test that polls instead of waiting on a real
  event
- `deno task check-docs` — a TypeScript block under `docs/` that stopped
  compiling
- `deno task check-conflict-markers` — an unresolved merge-conflict marker left
  in a file, which `docs/` has no other mechanical gate against
- `deno task check-skill-facts` — a path or import cited by a skill, an
  `AGENTS.md`, or a rule that stopped resolving
- `deno task check-single-copy-deps`, `check-unused-deps`, `check-deno-pins` —
  dependency declarations across the workspace
- `deno task check-baselines-append-only` — a pattern baseline that was deleted
  rather than added to

The detail behind each of these lives in `.claude/rules/`, one file per kind of
file it governs. Claude Code loads the matching rule on its own when it reads a
file the rule names. An agent without that mechanism can read the rule directly
— they are ordinary Markdown, and `.claude/rules/README.md` says which covers
what.
