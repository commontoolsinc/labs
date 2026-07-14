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
// Shown at module scope.
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
// Shown for illustration only.
#!/usr/bin/env -S deno run -A

import { Runtime } from "@commonfabric/runner";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { env } from "@commonfabric/integration";
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
- Connect to real API using `env.API_URL` from `@commonfabric/integration`
- Test complete workflows (runtime, storage, pieces)
- Use `console.log` for output and `Deno.exit(1)` for failures
- Run as part of CI against deployed backend

**Adding integration tests:**

When adding runtime features, consider adding integration tests to `packages/runner/integration/` that verify the feature works end-to-end. See existing tests like `basic-persistence.test.ts` or `array_push.test.ts` for examples.

### Recording browser integration tests as video demos

Selected `patterns` and `shell` browser integration tests can be recorded with
the same local servers, browser identities, UI events, waits, assertions, and
cleanup used by the normal integration suite:

```bash
deno task demo patterns cfc-render-policy-demo
deno task demo patterns lunch-poll-vote --output=tmp/demos/lunch-poll.mp4
```

The file filter must resolve to exactly one `*.test.ts` file. The command runs
that complete file because its `it` blocks may share suite setup and browser
state. It writes a test-named MP4 (for example, `lunch-poll-vote.mp4`) and a
versioned diagnostic manifest beneath `tmp/demos/`; `--output=PATH` copies the
final MP4 to a chosen location.

FFmpeg must be installed and available as `ffmpeg`, or its path must be set in
`FFMPEG`. Normal integration tests do not require FFmpeg. Useful options are
`--keep-frames`, `--viewport=WIDTHxHEIGHT`, and `--port-offset=N`.

Presentation mode modifies the existing browser interaction paths rather than
using demo-only clicks or typing. Inputs type with a readable character delay,
clicks show an injected cursor, and labeled scenario steps appear as captions.
All presentation behavior is disabled during `deno task integration`.

Tests with multiple `ShellIntegration` instances retain their independent
browsers and identities. Each page is recorded against one shared timeline and
the streams are composed afterward: two participants are side by side, while
three or four use a 2-by-2 grid. Configure stable labels and colors through the
shell's `presentation` metadata.

If a test, browser capture, or FFmpeg encode fails, the command exits nonzero
and retains its manifest and available intermediate streams under the printed
run directory.

## Related documentation

- [waitfor-migration.md](waitfor-migration.md) — waiting in tests: prefer
  primitives that resolve on a real event over polling with a timeout. This
  doc records the migration off the polling `waitFor` helper, and maintains
  the list of deliberate exceptions (bounded polls that are the honest
  observation) plus the remaining migratable tail — read it before adding a
  poll or re-migrating one of the exceptions.
- [COVERAGE.md](COVERAGE.md) — how CI measures coverage. It explains the two
  mechanisms (Deno's V8 coverage for runtime code, and transformer-based
  coverage for authored patterns) and how both feed the coverage-debt gate.
- [CI_PERFORMANCE.md](CI_PERFORMANCE.md) — the CI wall-time policy, and the
  coverage-debt baseline and ratchet markers that gate a pull request.
- [LLM_TESTING.md](LLM_TESTING.md) — testing patterns and server routes that
  call the LLM, including the test-environment guard and conversation fixtures.
- [UI_TESTING.md](UI_TESTING.md) — testing shadow DOM components in browser
  integration tests.
- [../common/workflows/pattern-testing.md](../common/workflows/pattern-testing.md)
  — writing and running pattern tests with `cf test`. The agent-oriented version
  is [../common/ai/pattern-testing-guide.md](../common/ai/pattern-testing-guide.md),
  and the design reference is [../specs/PATTERN_TESTING_SPEC.md](../specs/PATTERN_TESTING_SPEC.md).
