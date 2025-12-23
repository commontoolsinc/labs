<!-- @reviewed 2025-12-10 docs-rationalization -->

# Runtime Development Guide

This guide covers working on CommonTools runtime components including the backend (Toolshed), frontend (Shell), and core runtime packages.

## Architecture Overview

CommonTools consists of several runtime components:

- **Toolshed** (`packages/toolshed/`) - Backend API server providing distributed runtime and storage
- **Shell** (`packages/shell/`) - Web frontend for interacting with spaces
- **Runner** (`packages/runner/`) - Pattern runtime execution engine
- **Background Charm Service** (`packages/background-charm-service/`) - Background service for running charms in Deno workers
- **Storage** - Storage layer implementation (`packages/memory/`, `packages/runner/src/storage/`)
- **Identity** (`packages/identity/`) - Identity management and cryptographic key handling

## Running Development Servers

### Backend (Toolshed)

The backend runs on port 8000 by default.

```bash
cd packages/toolshed
SHELL_URL=http://localhost:5173 deno task dev
```
**Development Options: Toolshed pointing to cloud backend instead**
```bash
SHELL_URL=http://localhost:5173 API_URL=https://toolshed.saga-castor.ts.net/ deno task dev
```

**Environment Setup:**
- Copy `.env.example` to `.env` in the toolshed directory
- See `env.ts` for all available environment variables and defaults
- Default URL: http://localhost:8000

### Frontend (Shell)

The frontend dev server runs on port 5173 by default. Access the application at port 8000, which proxies to shell.

```bash
cd packages/shell
deno task dev-local
```

**Note:** Use `dev-local` (not `dev`) when running against a local Toolshed backend. The `dev` task points to the production backend.

### Background charm service
This is only needed if you are working on either the background charm service or need to support running background charms.
Default assumption is that its not needed.

How to start:
```bash
cd packages/background-charm-service
OPERATOR_PASS="implicit trust" API_URL="http://localhost:8000" deno task start
```


**Important:** For `*.ts.net` URLs, you must be connected to the CT network via Tailscale. Commands will hang or timeout if not connected.

### Restarting Servers

After making edits to runtime code, restart the shell server.

## Testing

### Running Tests

**From workspace root** (recommended):

```bash
# Run all tests (includes unit and integration)
deno task test

# Run tests for specific package
cd packages/runner
deno task test
```

**Important:** Always use `deno task test` from the root, NOT `deno test`, as the task includes necessary flags.

### Test Structure

- **Unit tests**: Use `@std/testing/bdd` (`describe`/`it`) with `@std/expect` for assertions
- **Integration tests**: Executable scripts that test end-to-end workflows against a running API
- **Test files**: Named `*.test.ts`

**Unit test example:**

```typescript
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

describe("Feature", () => {
  it("should do something", () => {
    expect(result).toBe(expected);
  });
});
```

**Integration test example:**

Integration tests are executable scripts that connect to a real backend and test full workflows. They are located in `packages/runner/integration/` and follow this pattern:

```typescript
#!/usr/bin/env -S deno run -A

import { Runtime } from "@commontools/runner";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { env } from "@commontools/integration";
const { API_URL } = env;

console.log("=== TEST: My Integration Test ===");

async function test() {
  const identity = await Identity.fromPassphrase("test operator");

  const runtime = new Runtime({
    apiUrl: new URL(API_URL),
    storageManager: StorageManager.open({
      as: identity,
      address: new URL("/api/storage/memory", API_URL),
    }),
  });

  // Test your workflow here
  // ...

  await runtime.dispose();

  // Return results or throw on failure
}

await test();
console.log("Done");
Deno.exit(0);
```

**Key characteristics of integration tests:**
- Start with shebang: `#!/usr/bin/env -S deno run -A`
- Connect to real API using `env.API_URL` from `@commontools/integration`
- Test complete workflows (runtime, storage, charms)
- Use `console.log` for output and `Deno.exit(1)` for failures
- Run as part of CI against deployed backend

**Adding integration tests:**

When adding runtime features, consider adding integration tests to `packages/runner/integration/` that verify the feature works end-to-end. See existing tests like `basic-persistence.test.ts` or `array_push.test.ts` for examples.

### Before Merging

Ensure all tests pass:

```bash
# Type checking
deno task check

# All tests
deno task test

# Formatting
deno fmt

# Linting
deno lint
```

## Key Runtime Packages

### Runner (`packages/runner/`)

The pattern runtime execution engine and sandbox coordinator.

- **Runtime** - Main runtime class for executing patterns
- **Storage** - Transaction model and data store layer
- **Builder** - Pattern builder API and construction utilities
- **Traverse** - Schema traversal and object management

### Memory (`packages/memory/`)

In-memory and persistent storage layer implementation.

### Identity (`packages/identity/`)

Identity management using Ed25519 cryptographic keys.

```bash
# Create new identity
deno task ct id new > identity.key
```

## Common Development Tasks

**Common issues:**
- Servers not picking up changes → Restart servers
- Tests failing after changes → Check that all tests pass, fix before proceeding
- Type errors → Run `deno task check` from root
- Port already in use → Kill existing deno processes with `pkill -9 deno`

### Working with Storage

The storage system uses MVCC transactions:

- See `packages/runner/src/storage/transaction-explainer.md` for transaction model details
- See `packages/runner/src/storage/transaction-implementation-guide.md` for implementation guide

## Module Graph Considerations

Runtime code runs in multiple environments:

- Browsers (Vite built)
- Browsers (deno-web-test>esbuild Built)
- Browsers (eval'd patterns)
- Deno (scripts and servers)
- Deno (eval'd patterns)
- Deno Workers
- Deno workers (eval'd patterns)

See [DEVELOPMENT.md](./DEVELOPMENT.md) for detailed module graph best practices.

## CI/CD

All changes must pass automated checks before merging:

- Type checking (`deno task check`)
- All tests (`deno task test`)
- Code formatting (`deno fmt`)
- Linting (`deno lint`)

The CI pipeline runs these checks automatically on PRs.
