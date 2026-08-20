/**
 * Guard for `--timing-measures-out`, whose whole value is that the file it
 * writes describes the run rather than a fragment of it.
 *
 * Each test file starts by clearing the performance timeline, so a capture read
 * once at the end of a multi-file run keeps only the last file and reports its
 * count as though it were the run's. That is invisible in a passing run — the
 * tests still pass, the file still exists, and only the numbers are wrong —
 * which is why it is pinned here rather than left to a reading of the code.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";
import {
  getTimingMeasuresState,
  TIMING_MEASURE_PREFIX,
} from "@commonfabric/utils/logger";

const FIXTURES = resolve(import.meta.dirname!, "fixtures/step-kinds");
const FIXTURE = resolve(FIXTURES, "marker-step.test.tsx");

interface Written {
  name: string;
  startTime: number;
  duration: number;
}

async function runCapturing(paths: string | string[]): Promise<Written[]> {
  const out = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await runTests(paths, { root: FIXTURES, timingMeasuresOut: out });
    return JSON.parse(await Deno.readTextFile(out)) as Written[];
  } finally {
    await Deno.remove(out);
  }
}

describe(
  "test-runner timing measures",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("writes the spans a run emitted, each carrying the logger's prefix", async () => {
      const written = await runCapturing(FIXTURE);

      expect(written.length).toBeGreaterThan(0);
      expect(
        written.every((entry) => entry.name.startsWith(TIMING_MEASURE_PREFIX)),
      ).toBe(true);
      // Intervals are the point of emitting these at all: without them the
      // statistics already say how long and how often.
      expect(written.every((entry) => entry.duration >= 0)).toBe(true);
    });

    it("keeps every file's spans when several are run", async () => {
      const single = await runCapturing(FIXTURE);
      const double = await runCapturing([FIXTURE, FIXTURE]);

      // The same file twice, so the second run should hold about twice the
      // spans. Reading the timeline once at the end instead of draining per
      // file would leave it holding roughly the same as one.
      expect(double.length).toBeGreaterThan(single.length * 1.5);
    });

    it("leaves emission as it found it", async () => {
      const before = getTimingMeasuresState().enabled;
      await runCapturing(FIXTURE);
      // Emission is process-global; a run that borrows it owes it back, or
      // every later run in the process pays for a capture nobody reads.
      expect(getTimingMeasuresState().enabled).toBe(before);
    });

    it("emits nothing when the option is absent", async () => {
      await runTests(FIXTURE, { root: FIXTURES });
      expect(
        performance.getEntriesByType("measure").some((entry) =>
          entry.name.startsWith(TIMING_MEASURE_PREFIX)
        ),
      ).toBe(false);
    });
  },
);
