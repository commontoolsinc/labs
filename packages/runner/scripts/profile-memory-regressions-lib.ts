export type PhaseTotals = {
  setupMs: number;
  prepareMs: number;
  firstCommitMs: number;
  loopMs: number;
  cleanupCommitMs: number;
  disposeMs: number;
};

function createEmptyPhaseTotals(): PhaseTotals {
  return {
    setupMs: 0,
    prepareMs: 0,
    firstCommitMs: 0,
    loopMs: 0,
    cleanupCommitMs: 0,
    disposeMs: 0,
  };
}

function clonePhaseTotals(phaseTotals: PhaseTotals): PhaseTotals {
  return { ...phaseTotals };
}

function averagePhaseTotals(
  phaseTotals: PhaseTotals,
  runs: number,
): PhaseTotals {
  const divisor = Math.max(runs, 1);
  return Object.fromEntries(
    Object.entries(phaseTotals).map(([name, total]) => [name, total / divisor]),
  ) as PhaseTotals;
}

export function createBenchPhaseMetricsTracker() {
  const phaseTotals = createEmptyPhaseTotals();
  let measuredRuns = 0;

  return {
    phaseTotals,
    recordRun() {
      measuredRuns += 1;
    },
    reset() {
      measuredRuns = 0;
      Object.assign(phaseTotals, createEmptyPhaseTotals());
    },
    metrics() {
      return {
        phaseTotalsMs: clonePhaseTotals(phaseTotals),
        phaseAvgMs: averagePhaseTotals(phaseTotals, measuredRuns),
      };
    },
  };
}
