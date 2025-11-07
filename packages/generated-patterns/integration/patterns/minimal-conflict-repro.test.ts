import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

/**
 * Minimal test to reproduce ConflictError warnings during parallel test execution.
 *
 * ## Root Cause
 * The pattern-harness.ts uses a SHARED DID for all tests:
 *   `const signer = await Identity.fromPassphrase("pattern integration harness");`
 *   `const space = signer.did();`
 *
 * When many tests run in parallel (via `--parallel` flag), they all:
 * 1. Create their own StorageManager instances with the shared signer
 * 2. Write to storage under the same DID space
 * 3. Dispose/cleanup simultaneously when tests finish
 *
 * The conflicts occur during the cleanup phase (visible in "post-test output")
 * when multiple parallel test workers try to update the same storage entities
 * simultaneously, causing transaction conflicts.
 *
 * ## Example Error
 * ```
 * [WARN][storage.cache::18:27:06.149] Transaction failed ConflictError:
 * The application/json of of:baedreicrwwkqxoov4q75gbg4uf7mgly37r5gzpdzibhfg2qh2kgr6w7bve
 * in did:key:z6MkgoBAqGfjfZrnExo9gAp5m6sawZuhiaHTWzh5VUc7cuj5
 * was expected to be ba4jcacpfpcm32lrqf6e3crpyx7e5o335vnbbxc5crzumyyrva3vwtuxh,
 * but it is ba4jcalk5w62amt54etn2vgei2xmf42thgxbpfcezby6ukcopnajlgyqd
 * ```
 *
 * ## To Observe
 * Run the full test suite with parallel execution:
 *   `deno task integration`
 *
 * The conflicts appear in stdout (not stderr) as [WARN][storage.cache] messages.
 * Running this single test file in isolation may not reproduce the conflicts
 * because it requires the timing overlap of many tests cleaning up simultaneously.
 *
 * ## Expected Behavior
 * In a full test run with --parallel, you should see approximately 40-50
 * ConflictError warnings in the output, all for the same entity ID, all
 * happening during cleanup after tests complete.
 */

// Simple counter pattern for testing
export const minimalCounterScenario: PatternIntegrationScenario<
  { value?: number }
> = {
  name: "minimal counter for conflict reproduction",
  module: new URL("./simple-counter.pattern.ts", import.meta.url),
  exportName: "simpleCounter",
  argument: { value: 0 },
  steps: [
    { expect: [{ path: "value", value: 0 }] },
    {
      events: [{ stream: "increment", payload: { amount: 1 } }],
      expect: [{ path: "value", value: 1 }],
    },
  ],
};

// Run multiple instances of the same test in parallel
// Each will create its own runtime/storage but share the same DID space
// The parallel disposal during cleanup creates the conflict errors
describe("minimal-conflict-repro", () => {
  // More instances increase likelihood of conflicts
  // But may not reproduce them in isolation - needs full suite timing overlap
  for (let i = 0; i < 20; i++) {
    it(`instance ${i}`, async () => {
      await runPatternScenario(minimalCounterScenario);
    });
  }
});
