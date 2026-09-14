/**
 * Contract test for `--timeout` as a stall bound: a step's settle is bounded
 * by the gap between two signs of runtime progress, not by its whole length.
 * `stall-watchdog.test.ts` pins the watchdog itself, including that it fires;
 * what a fixture can show is the other half, a settle that outruns the bound
 * and passes because the scheduler never went quiet.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join, resolve } from "@std/path";
import { TIMING_MEASURE_PREFIX } from "@commonfabric/utils/logger";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/settle");

/** One span as the runner writes it to `timingMeasuresOut`. */
interface Written {
  name: string;
  duration: number;
}

describe(
  "`--timeout` as a stall bound",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("passes a render step whose settle outruns the bound while the scheduler keeps running", async () => {
      // The fixture's render settles in a couple of seconds of back-to-back
      // scheduler runs, each a few tens of milliseconds. The settle's own
      // span is read back so the case says what it pins: a settle longer
      // than the bound, which a bound on the whole settle would have failed.
      // On a machine fast enough to finish the settle inside the bound the
      // case says nothing, and fails rather than passing in silence.
      const bound = 500;
      const out = join(await Deno.makeTempDir(), "measures.json");
      const { passed, failed } = await runTests(
        resolve(FIXTURES, "slow-fan-out.test.tsx"),
        { root: FIXTURES, timeout: bound, timingMeasuresOut: out },
      );
      const written = JSON.parse(await Deno.readTextFile(out)) as Written[];
      const settle = written.filter((entry) =>
        entry.name.startsWith(
          `${TIMING_MEASURE_PREFIX}runTestPattern/step/render_1/settle#`,
        )
      );
      expect(settle.length).toBe(1);
      expect(settle[0].duration).toBeGreaterThan(bound);
      expect(failed).toBe(0);
      expect(passed).toBe(1);
    });
  },
);
