# Background Charm Service

A robust service for running background charms with integration capabilities and
health monitoring.

## Overview

The Background Charm Service runs charms in the background with:

- Persistent job queue using Deno KV
- Worker pooling for efficient charm execution
- Automatic error handling and retry logic
- Integration with external services (Gmail, GCal, etc.)
- Comprehensive logging and monitoring

## Available Integrations

The service can be run with various integrations:

- `gmail`: Google Mail integration
- `gcal`: Google Calendar integration (partially implemented)
- `manual`: Run specific charms defined via command line

## Creating a New Integration

To add a new integration:

1. Create a new TypeScript file in the `src/integrations/` directory named after
   your integration (e.g., `src/integrations/gcal.ts`)
2. Implement the `Integration` interface:

```typescript
import { Charm } from "@commontools/charm";
import { Cell } from "@commontools/runner";
import type { DID } from "@commontools/identity";
import { Integration, IntegrationCellConfig } from "../types.ts";

export class MyIntegration implements Integration {
  id = "my-integration-id"; // Used for --integration flag
  name = "My Integration";

  async initialize(): Promise<void> {
    // Initialization logic
  }

  private async fetchMyIntegrationCharms(): Promise<
    { space: DID; charmId: string }[]
  > {
    // Return array of charms to execute
    return [];
  }

  private isValidCharm(charm: Cell<Charm>): boolean {
    // Validate charm has required keys/properties
    return true;
  }

  getIntegrationConfig(): IntegrationCellConfig {
    return {
      id: this.id,
      name: this.name,
      spaceId: "system", // Update as needed
      cellCauseName: "my-integration-cell",
      fetchCharms: () => this.fetchMyIntegrationCharms(),
      isValidIntegrationCharm: (charm) => this.isValidCharm(charm),
    };
  }
}

// Export the integration instance
export default new MyIntegration();
```

3. The integration will be automatically discovered and registered.

## Development

### Prerequisites

- Deno 1.40.0 or later

### Command Line Options

```
Background Charm Service
A robust service for running charms in the background with health monitoring

Usage: deno run --unstable-kv -A --unstable-worker-options src/cli.ts [options]

Options:
  --charms=<space/charm>,*   Comma-separated list of space/charm IDs
  --interval=<seconds>       Update interval in seconds (default: 60)
  --failures=<number>        Disable after N consecutive failures (default: 5)
  --log-interval=<seconds>   Log status interval in seconds (default: 300)
  --integration=<name>          Integration to run (default: gmail)
                             Available: gmail, gcal
  --initialize               Initialize integration cell
  --max-concurrent=<number>  Max concurrent jobs (default: 5)
  --max-retries=<number>     Max retry attempts for failed jobs (default: 3)
  --help                     Show this help message
```

### Running the Service

Run the service with the default integration (Gmail):

```
deno task start
```

With Gmail integration:

```
deno task gmail
```

With Google Calendar integration:

```
deno task gcal
```

With manual charm list:

```
deno run --unstable-kv -A --unstable-worker-options src/cli.ts --charms=space1/charm1,space2/charm2
```

### Initializing Integration Cells

Initialize the current integration:

```
deno task initialize
```

Initialize a specific integration:

```
deno task initialize:gmail
deno task initialize:gcal
```

### Testing

Run tests:

```
deno task test
```

Check TypeScript:

```
deno task check
```
