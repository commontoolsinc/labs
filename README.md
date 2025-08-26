# Common Tools Platform

**Common Labs** - Radioactive experiments. Turn back! You will find no API
stability here.

![A loom, by Midjourney](./docs/images/loom.jpg)

## What is Common Tools?

Common Tools is a nascent distributed computing platform that provides both a runtime and
storage layer. The design allows instrumentation of all information flow in the system,
enabling safe & private collaboration at scale.

### Core Concepts

**Recipes** are reactive programs that can be linked together to create data and
program networks. They're written in TypeScript/JSX and run in a secure sandbox
environment. Recipes can:

- Process and transform data
- Render interactive UIs using `ct-` prefixed components
- React to changes from linked recipes
- Connect to external APIs

**Charms** are deployed instances of recipes running in CommonTools spaces.
Charms can be linked together to create complex workflows where data flows
automatically between connected components.

**Spaces** are collaborative environments where charms live and interact. Users
can run their own spaces or use hosted versions.

## Quick Start (Development)

Check out the repo, install `deno` and `claude` and then run `/onboarding`
within Claude Code.

## Architecture

This is a multi-package monorepo with several key components:

**Backend ([Toolshed](./packages/toolshed))**: The hosted platform backend,
written in Deno2, that provides the distributed runtime and storage.

**Frontend ([Shell](./packages/shell))**: A web client interface written with
Lit Web Components for interacting with CommonTools spaces.

**CLI (CT Binary)**: Command-line interface for managing charms, linking
recipes, and deploying to spaces. See
[CT Usage Guide](./.claude/commands/common/ct.md).

**UI Components ([packages/ui](./packages/ui))**: Custom VDOM layer and `ct-`
prefixed components for recipe UIs.

**Examples & Patterns ([packages/patterns](./packages/patterns))**: Example
recipes and common patterns for building with CommonTools.

**Recipe Development**: Recipes can be developed using LLM assistance with
commands like `/imagine-recipe`, `/recipe-dev`, and `/explore-recipe`.

## Development & Integrations

### Claude Code Commands

This repository includes many Claude Code commands in
[`.claude/commands/`](./.claude/commands/) for common workflows:

- `/recipe-dev` - Work on existing recipes with LLM assistance
- `/imagine-recipe` - Create new recipes from ideas
- `/explore-recipe` - Test recipes interactively with Playwright
- `/linear` - Task management integration
- `/deps` - Dependency and integration setup
- And many more - see the commands directory

### Dependencies & Integrations

**Required**:

- [Deno 2](https://docs.deno.com/runtime/getting_started/installation/) -
  Runtime for backend and tooling

**Recommended Integrations**:

- [GitHub CLI](https://github.com/cli/cli) - For PR and issue workflows
- [Claude Code MCP integrations](./deps.md):
  - Linear Server MCP for task management
  - Playwright MCP for browser-based recipe testing

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

Run the dev server

```bash
cd ./packages/shell
deno task dev
```

By default, the frontend will run at <http://localhost:5173>, and it will point
to a local backend running at <http://localhost:8000>.

If you are not actively making updates to the backend, you can also point to the
backend running in the cloud, by running the following command:

```shell
TOOLSHED_API_URL=https://toolshed.saga-castor.ts.net/ deno task dev
```
