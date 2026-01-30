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
- Test complete workflows (runtime, storage, pieces)
- Use `console.log` for output and `Deno.exit(1)` for failures
- Run as part of CI against deployed backend

**Adding integration tests:**

When adding runtime features, consider adding integration tests to `packages/runner/integration/` that verify the feature works end-to-end. See existing tests like `basic-persistence.test.ts` or `array_push.test.ts` for examples.
