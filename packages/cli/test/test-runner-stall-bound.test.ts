/**
 * Contract test for `--timeout` as a stall bound: a step's settle is bounded
 * by the gap between two signs of runtime progress, not by its whole length.
 * `stall-watchdog.test.ts` pins the watchdog itself, including that it fires;
 * what a fixture can show is the other half, a settle that outruns the bound
 * and passes because the scheduler never went quiet.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/settle");

describe(
  "`--timeout` as a stall bound",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("passes a render step whose settle outruns the bound while the scheduler keeps running", async () => {
      // The fixture's render settles in a few seconds of back-to-back
      // scheduler runs, each far shorter than the bound. A flat bound of one
      // second fails it; a stall bound of one second does not.
      const { passed, failed, results } = await runTests(
        resolve(FIXTURES, "slow-fan-out.test.tsx"),
        { root: FIXTURES, timeout: 1000 },
      );
      expect(failed).toBe(0);
      expect(passed).toBe(1);
      expect(results[0].results.map((r) => r.error)).toEqual([undefined]);
    });
  },
);
