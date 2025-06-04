# Background Charm Service Development Guide

## Build & Test Commands

- Run service: `deno task start`
- Run with Gmail integration: `deno task gmail:kv`
- Run with Gmail integration (legacy): `deno task gmail`
- Initialize integration cells: `deno task initialize`
- Initialize specific integration: `deno task initialize:gmail` or `deno task initialize:gcal`
- Run tests: `deno task test`
- Run specific test: `deno test src/path/to/test.ts`
- Check typings: `deno task check`
- Format code: `deno fmt`
- Lint code: `deno lint`

## Working with Integrations

### Adding a New Integration

1. Create a new file in `src/integrations/` named after your integration (e.g., `myservice.ts`)
2. Implement the `Integration` interface:

```typescript
import { Charm } from "@commontools/charm";
import { Cell } from "@commontools/runner";
import type { DID } from "@commontools/identity";
import { Integration, IntegrationCellConfig } from "../types.ts";
import { log } from "../utils.ts";

export class MyServiceIntegration implements Integration {
  id = "myservice"; // This will be used for --integration flag
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

  // Helper methods
  private async fetchMyServiceCharms(): Promise<
    { space: DID; charmId: string }[]
  > {
    // Implementation
    return [];
  }

  private isValidCharm(charm: Cell<Charm>): boolean {
    // Validation logic
    return true;
  }
}

// Export an instance of the integration
export default new MyServiceIntegration();
```

3. The integration will be automatically discovered and registered
4. Update deno.json to add shortcut task: `"myservice": "deno run -A src/cli.ts --integration=myservice"`

## Code Style Guidelines

### Formatting

- Indentation: 2 spaces
- Semicolons: required
- Double quotes for strings
- Line width: ~80 characters
- Use `deno fmt` for auto-formatting

### TypeScript

- Strong typing with explicit interfaces
- Prefer interfaces over type aliases for object types
- Export types explicitly with `export type { ... }`
- Use JSDoc comments with `@param` and `@returns` tags
- Avoid `any` type, use `unknown` when type is uncertain

### Naming & Imports

- Classes: PascalCase (BackgroundCharmService)
- Functions/variables: camelCase (processCharm)
- Constants: UPPER_SNAKE_CASE (TOOLSHED_URL)
- Group imports by source (std lib, external, internal)
- Prefer named exports over default exports

### Error Handling

- Use try/catch with descriptive error messages
- Include context (like charm IDs) in error logs
- Properly propagate errors in async functions
- Use typed error classes for specific error scenarios

### Testing

- Write unit tests for critical functions
- Use descriptive test names that explain the expected behavior
- Mock external dependencies when testing handlers and services
