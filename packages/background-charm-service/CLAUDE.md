# Background Charm Service

## Overview

The background-charm-service polls registered charms and triggers their
`bgUpdater` handlers server-side. This enables scheduled/background tasks in
charms without requiring the browser to be open.

**Key concepts:**

- Polls registered charms every 60 seconds (default)
- Sends `{}` to the charm's `bgUpdater` Stream on each poll
- The `bgUpdater` handler executes server-side, not in browser

---

## Running Locally (For Testing bgUpdater)

Use this when you're developing a charm with `bgUpdater` and want to test
server-side execution.

### Prerequisites

1. Local dev servers running (see `docs/development/LOCAL_DEV_SERVERS.md`)
2. Binaries built: `deno task build-binaries` (from labs root)

### Setup Steps

```bash
# 1. From labs root, ensure dev servers are running
./scripts/restart-local-dev.sh

# 2. Set up admin charm (one-time, grants service access to system space)
cd packages/background-charm-service
OPERATOR_PASS="implicit trust" API_URL="http://localhost:8000" deno task add-admin-charm

# 3. Start the background service (from labs root)
cd ..
OPERATOR_PASS="implicit trust" API_URL="http://localhost:8000" ./dist/bg-charm-service
```

### Registering Charms for Background Updates

Charms must be registered before they receive polling:

```bash
# Register via curl
curl -X POST http://localhost:8000/api/integrations/bg \
  -H "Content-Type: application/json" \
  -d '{
    "pieceId": "baedrei...",
    "space": "did:key:z6Mk...",
    "integration": "my-test"
  }'
```

Or add `<ct-updater $state={someCell} integration="name" />` to your charm's UI.

**Getting space DID from space name:**

```
Space DID = Identity.fromPassphrase("common user").derive(spaceName).did()
```

### Verifying It Works

Watch the service output for:

```
Successfully executed charm did:key:.../baedrei...
```

### Troubleshooting

| Issue                                         | Solution                                     |
| --------------------------------------------- | -------------------------------------------- |
| `CompilerError: no exported member 'pattern'` | Rebuild binaries: `deno task build-binaries` |
| `AuthorizationError` on system space          | Run `add-admin-charm` step                   |
| Charm not being polled                        | Verify registration via curl                 |

---

## Developing the Service

Use this section when working on the background-charm-service code itself.

### Commands

| Command                         | Purpose                 |
| ------------------------------- | ----------------------- |
| `deno task start`               | Run service from source |
| `deno task test`                | Run tests               |
| `deno test src/path/to/test.ts` | Run specific test       |
| `deno task check`               | Check typings           |
| `deno fmt`                      | Format code             |
| `deno lint`                     | Lint code               |

### Integration-Specific Commands

| Command                      | Purpose                                |
| ---------------------------- | -------------------------------------- |
| `deno task gmail:kv`         | Run with Gmail integration             |
| `deno task gmail`            | Run with Gmail integration (legacy)    |
| `deno task initialize`       | Initialize integration cells           |
| `deno task initialize:gmail` | Initialize Gmail integration           |
| `deno task initialize:gcal`  | Initialize Google Calendar integration |

---

## Adding a New Integration

Create a new file in `src/integrations/` named after your integration (e.g.,
`myservice.ts`):

```typescript
import { Charm } from "@commontools/piece";
import { Cell } from "@commontools/runner";
import type { DID } from "@commontools/identity";
import { Integration, IntegrationCellConfig } from "../types.ts";
import { log } from "../utils.ts";

export class MyServiceIntegration implements Integration {
  id = "myservice"; // Used for --integration flag
  name = "My Service Integration";

  async initialize(): Promise<void> {
    // Initialization logic
  }

  getIntegrationConfig(): IntegrationCellConfig {
    return {
      id: this.id,
      name: this.name,
      spaceId: "system",
      cellId: "myservice-integration-charms",
      fetchCharms: () => this.fetchMyServiceCharms(),
      isValidIntegrationCharm: (charm) => this.isValidCharm(charm),
    };
  }

  private async fetchMyServiceCharms(): Promise<
    { space: DID; pieceId: string }[]
  > {
    // Implementation
    return [];
  }

  private isValidCharm(charm: Cell<Charm>): boolean {
    // Validation logic
    return true;
  }
}

export default new MyServiceIntegration();
```

Then add a shortcut task to `deno.json`:

```json
"myservice": "deno run -A src/cli.ts --integration=myservice"
```

---

## Code Style

- **Formatting**: 2 spaces, semicolons required, double quotes, ~80 char lines
- **Naming**: PascalCase classes, camelCase functions, UPPER_SNAKE_CASE
  constants
- **Types**: Prefer interfaces, export types explicitly, avoid `any`
- **Errors**: Try/catch with context (charm IDs), typed error classes
- **Testing**: Descriptive test names, mock external dependencies

Run `deno fmt` for auto-formatting.
