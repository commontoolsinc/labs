# Common Tools Platform

**Common Labs** - Radioactive experiments. Turn back! You will find no API
stability here.

![A loom, by Midjourney](./docs/images/loom.jpg)

## What is Common Tools?

Common Tools is a nascent distributed computing platform that provides both a
runtime and storage layer. The design allows instrumentation of all information
flow in the system, enabling safe & private collaboration at scale.

### Core Concepts

**Patterns** are reactive programs that can be linked together to create data
and program networks. They're written in TypeScript/JSX and run in a secure
sandbox environment. Patterns can:

- Process and transform data
- Render interactive UIs using `ct-` prefixed components
- React to changes from linked patterns
- Connect to external APIs

**Pieces** are deployed instances of patterns running in CommonTools spaces.
Pieces can be linked together to create complex workflows where data flows
automatically between connected components.

**Spaces** are collaborative environments where pieces live and interact. Users
can run their own spaces or use hosted versions.

## Quick Start (Development)

1. Install [Deno 2](https://docs.deno.com/runtime/getting_started/installation/)
2. Clone this repo
3. Start local dev servers: `./scripts/start-local-dev.sh`
4. Access the application at <http://localhost:8000>

For Claude Code users, run `/deps` to verify prerequisites and
`/start-local-dev` to start the dev servers. See
[LOCAL_DEV_SERVERS.md](./docs/development/LOCAL_DEV_SERVERS.md) for
troubleshooting.

## Architecture

This is a multi-package monorepo with several key components:

**Backend ([Toolshed](./packages/toolshed))**: The hosted platform backend,
written in Deno2, that provides the distributed runtime and storage.

**Frontend ([Shell](./packages/shell))**: A web client interface written with
Lit Web Components for interacting with CommonTools spaces.

**CLI (ct)**: Command-line interface for managing pieces, linking patterns, and
deploying to spaces. Run `deno task ct --help` for command reference.

**UI Components ([packages/ui](./packages/ui))**: Custom VDOM layer and `ct-`
prefixed components for pattern UIs.

**Examples & Patterns ([packages/patterns](./packages/patterns))**: Example
patterns for building with CommonTools.

**Pattern Development**: Patterns can be developed using LLM assistance with the
`/pattern-dev` skill. See [Pattern Documentation](./docs/common/) for patterns,
components, and handlers.

## Development & Integrations

### Claude Code Skills & Commands

This repository includes Claude Code skills and commands for common workflows:

- `/pattern-dev` - Develop patterns with LLM assistance
- `/pattern-test` - Write and run pattern tests
- `/pattern-deploy` - Deploy patterns and test with CLI
- `/start-local-dev` - Start local dev servers
- `/deps` - Dependency and integration setup
- `/fix-issue` - Fix a specific issue
- `/oracle` - Investigate how things actually work

### Dependencies & Integrations

**Required**:

- [Deno 2](https://docs.deno.com/runtime/getting_started/installation/) -
  Runtime for backend and tooling

**Recommended Integrations**:

- [GitHub CLI](https://github.com/cli/cli) - For PR and issue workflows
- Claude Code MCP integrations (run `/deps` in Claude Code for setup):
  - Playwright MCP for browser-based pattern testing

### Development Practices

- **CI/CD**: All changes must pass automated checks before merging
- **Testing**: Tests are critical - run with `deno task test`
- **Linting**: Use `deno task check` for type checking
- **Formatting**: Always run `deno fmt` before committing
- See [CLAUDE.md](./CLAUDE.md) for detailed coding guidelines

## Running the backend

For a more detailed guide, see
[./packages/toolshed/README.md](./packages/toolshed/README.md).

```bash
cd ./packages/toolshed
deno task dev
```

By default the backend will run at <http://localhost:8000>

## Running the frontend

**Recommended:** Use `./scripts/start-local-dev.sh` to start both backend and
frontend together. See
[LOCAL_DEV_SERVERS.md](./docs/development/LOCAL_DEV_SERVERS.md) for details.

**Manual setup** (if you need to run servers separately):

```bash
# Against local backend (use dev-local, NOT dev)
cd ./packages/shell
TOOLSHED_PORT=8000 deno task dev-local
```

**Important:** `deno task dev` points to the production backend. Use
`deno task dev-local` when running against a local Toolshed instance.

The frontend dev server runs at <http://localhost:5173>. Access the application
at <http://localhost:8000>, where toolshed proxies to shell.

If you are not running a local backend, you can point to the cloud:

```shell
cd ./packages/shell
deno task dev
```
