# Background Piece Service

## Overview

The background-piece-service polls registered pieces and triggers their
`bgUpdater` handlers server-side. This enables scheduled/background tasks in
pieces without requiring the browser to be open.

**Key concepts:**

- Polls registered pieces every 60 seconds (default)
- Sends `{}` to the piece's `bgUpdater` Stream on each poll
- The `bgUpdater` handler executes server-side, not in browser

---

## Running Locally (For Testing bgUpdater)

Use this when you're developing a piece with `bgUpdater` and want to test
server-side execution.

### Prerequisites

1. Local dev servers running (see `docs/development/LOCAL_DEV_SERVERS.md`)
2. Binaries built: `deno task build-binaries` (from labs root)

### Setup Steps

```bash
# 1. From labs root, ensure dev servers are running
./scripts/restart-local-dev.sh

# 2. Set up admin piece (one-time, grants service access to system space)
cd packages/background-piece-service
OPERATOR_PASS="implicit trust" API_URL="http://localhost:8000" deno task add-admin-piece

# 3. Start the background service (from labs root)
cd ..
OPERATOR_PASS="implicit trust" API_URL="http://localhost:8000" ./dist/bg-piece-service
```

### Registering Pieces for Background Updates

Pieces must be registered before they receive polling:

```bash
# Register via curl
curl -X POST http://localhost:8000/api/integrations/bg \
  -H "Content-Type: application/json" \
  -d '{
    "pieceId": "fid1:abc...",
    "space": "did:key:z6Mk...",
    "integration": "my-test"
  }'
```

Or add `<cf-updater $state={someCell} integration="name" />` to your piece's UI.

**Getting space DID from space name:**

```
Space DID = Identity.fromPassphrase("common user").derive(spaceName).did()
```

### Verifying It Works

Watch the service output for:

```
Successfully executed piece did:key:.../fid1:abc...
```

### Troubleshooting

| Issue                                         | Solution                                     |
| --------------------------------------------- | -------------------------------------------- |
| `CompilerError: no exported member 'pattern'` | Rebuild binaries: `deno task build-binaries` |
| `AuthorizationError` on system space          | Run `add-admin-piece` step                   |
| Piece not being polled                        | Verify registration via curl                 |

---

## Developing the Service

Use this section when working on the background-piece-service code itself.

### Commands

| Command                         | Purpose                 |
| ------------------------------- | ----------------------- |
| `deno task start`               | Run service from source |
| `deno task help`                | Show service help       |
| `deno task add-admin-piece`     | Deploy the admin piece  |
| `deno task test`                | Run tests               |
| `deno test src/path/to/test.ts` | Run specific test       |
| `deno task check`               | Check typings           |
| `deno task fmt`                 | Format code             |
| `deno task lint`                | Lint code               |

---

## Code Style

- **Formatting**: 2 spaces, semicolons required, double quotes, ~80 char lines
- **Naming**: PascalCase classes, camelCase functions, UPPER_SNAKE_CASE
  constants
- **Types**: Prefer interfaces, export types explicitly, avoid `any`
- **Errors**: Try/catch with context (piece IDs), typed error classes
- **Testing**: Descriptive test names, mock external dependencies

Run `deno fmt` for auto-formatting.
