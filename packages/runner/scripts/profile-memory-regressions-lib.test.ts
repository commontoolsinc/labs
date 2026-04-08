import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createBenchPhaseMetricsTracker } from "./profile-memory-regressions-lib.ts";

describe("createBenchPhaseMetricsTracker", () => {
  it("averages using measured runs rather than a caller-provided iteration count", () => {
    const tracker = createBenchPhaseMetricsTracker();

    tracker.phaseTotals.setupMs += 10;
    tracker.phaseTotals.loopMs += 40;
    tracker.recordRun();
    tracker.recordRun();

    expect(tracker.metrics()).toEqual({
      phaseTotalsMs: {
        setupMs: 10,
        prepareMs: 0,
        firstCommitMs: 0,
        loopMs: 40,
        cleanupCommitMs: 0,
        disposeMs: 0,
      },
      phaseAvgMs: {
        setupMs: 5,
        prepareMs: 0,
        firstCommitMs: 0,
        loopMs: 20,
        cleanupCommitMs: 0,
        disposeMs: 0,
      },
    });
  });

  it("drops warmup totals when reset before measured runs", () => {
    const tracker = createBenchPhaseMetricsTracker();

    tracker.phaseTotals.setupMs += 100;
    tracker.phaseTotals.loopMs += 200;
    tracker.recordRun();

    tracker.reset();

    tracker.phaseTotals.setupMs += 30;
    tracker.phaseTotals.loopMs += 90;
    tracker.recordRun();
    tracker.recordRun();
    tracker.recordRun();

    expect(tracker.metrics()).toEqual({
      phaseTotalsMs: {
        setupMs: 30,
        prepareMs: 0,
        firstCommitMs: 0,
        loopMs: 90,
        cleanupCommitMs: 0,
        disposeMs: 0,
      },
      phaseAvgMs: {
        setupMs: 10,
        prepareMs: 0,
        firstCommitMs: 0,
        loopMs: 30,
        cleanupCommitMs: 0,
        disposeMs: 0,
      },
    });
  });
});
