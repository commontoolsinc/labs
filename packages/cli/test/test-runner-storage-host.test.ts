/**
 * Guard for `TestRunnerOptions.storageHost`: the runner runs against a
 * caller-supplied identity and store, records what the run instantiates, and
 * leaves that store OPEN and readable once the run returns.
 *
 * The caller this exists for is the pattern-vintage capture
 * (`tasks/pattern-vintage-run.ts`), which snapshots the store afterwards — so
 * "the store survives and holds what the pattern reached" is the contract, and
 * it is checked here rather than only through the gate that consumes it.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { runTestPattern } from "../lib/test-runner.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/storage-host");

/** Pinned, because an id that differs every run cannot be addressed again. */
const RESULT_CAUSE = { cliStorageHost: "counter" };

const SCHEMA = {
  type: "object",
  properties: { count: { type: "number" } },
} as const;

describe(
  "runTestPattern with a caller-supplied storage host",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("leaves the store readable, holding what the run wrote", async () => {
      const identity = await Identity.fromPassphrase("cli storage host test");
      const storageManager = StorageManager.emulate({ as: identity });
      const instantiated: string[] = [];

      const result = await runTestPattern(
        resolve(FIXTURES, "counter.test.tsx"),
        {
          root: FIXTURES,
          storageHost: {
            identity,
            storageManager,
            resultCause: RESULT_CAUSE,
            onPatternInstantiated: (i) => instantiated.push(i.identity),
          },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.results.filter((r) => !r.passed && !r.skipped)).toEqual([]);
      // The observer is how the capture learns what to replay later; a run that
      // recorded nothing would produce a fixture with no update targets.
      expect(instantiated.length).toBeGreaterThan(0);

      // The runner tore its own runtime down but did NOT close this manager, so
      // a fresh runtime over it reads the state the handlers wrote — two bumps,
      // durable, addressable by the cause the caller pinned.
      const reader = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      const root = reader.getCell<{ count: number }>(
        identity.did(),
        RESULT_CAUSE,
        SCHEMA,
      );
      await root.sync();
      expect(root.get()?.count).toBe(2);

      // The caller owns the close, which is the other half of the contract.
      await reader.dispose();
    });
  },
);
