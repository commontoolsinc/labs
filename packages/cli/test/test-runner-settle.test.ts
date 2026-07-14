/**
 * Guard for the `{ settle: true }` test step: the runner waits for full
 * settlement (`runtime.settled()`) between steps, honors `skip`, and the step is
 * transparent to the reported results (it is neither an action nor an
 * assertion). Mirrors test-runner-console-capture.test.ts.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/settle");

function fixture(name: string): string {
  return resolve(FIXTURES, name);
}

describe(
  "`{ settle: true }` test step",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("runs a full settle between steps and is transparent to results", async () => {
      const { passed, failed, results } = await runTests(
        fixture("settle-step.test.tsx"),
        { root: FIXTURES },
      );
      // Only the single assertion is reported; the settle steps add nothing.
      expect(failed).toBe(0);
      expect(passed).toBe(1);
      const stepResults = results.flatMap((r) => r.results);
      expect(stepResults.length).toBe(1);
      expect(stepResults.every((r) => !r.name.startsWith("settle_"))).toBe(
        true,
      );
    });

    it("rejects a step with no supported discriminant", async () => {
      const { results } = await runTests(
        fixture("invalid-step.test.tsx"),
        { root: FIXTURES },
      );
      expect(results[0].error ?? "").toContain(
        "must have an 'action', 'assertion', 'render', or 'settle'",
      );
    });
  },
);
