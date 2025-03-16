# Background Charm Service

A robust service for running background charms with integration capabilities.

## Available Integrations

The service can be run with various integrations:

- `gmail`: Google Mail integration
- `gcal`: Google Calendar integration (coming soon)

## Creating a New Integration

To add a new integration:

1. Create a new TypeScript file in the `src/integrations/` directory named after your integration (e.g., `src/integrations/gcal.ts`)
2. Implement the `Integration` interface:

```typescript
import { Integration } from "../types.ts";

export class MyIntegration implements Integration {
  id = "my-integration-id"; // Used for --integration flag
  name = "My Integration";

  async initialize(): Promise<void> {
    // Initialization logic
  }

  getIntegrationConfig(): IntegrationCellConfig {
    return {
      id: this.id,
      name: this.name,
      spaceId: "system", // Update as needed
      cellId: "my-integration-cell",
      fetchCharms: () => this.fetchMyIntegrationCharms(),
      isValidIntegrationCharm: (charm) => this.isValidCharm(charm),
    };
  }

  // Add helper methods as needed
}

// Export an instance of the integration
export default new MyIntegration();
```

3. The integration will be automatically discovered and registered.

## Development

### Prerequisites

- Deno 1.40.0 or later

### Running the Service

Without integration:
```
deno task start
```

With Gmail integration:
```
deno task gmail
```

With GCal integration:
```
deno task gcal
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