// The serving loop's counters (server-execution v2 stage F,
// serving-loop.md §7): exposed via the existing `/api/health/stats`
// shape as the `servingLoop` block. Implemented WITH the loop, not
// after — every phase gate in the plan reads these counters, and tests
// MUST assert on counters, not logs. The §3 amplification metric is
// computable from counters alone:
// `derivedCommits / (authoredSeen − effectAcks)`.
//
// Stage boundaries, stated so zeros read as design rather than gaps:
// `events.*` counts nothing until Phase 3 lands events-down, `memo.*`
// and `outbox.*` nothing until stage G lands the effect channel, and
// `effectAcks` nothing until Phase 4's effect-channel acks exist.

export type ServingLoopStats = {
  activeSpaces: number;
  waves: number;
  wavesBudgetExhausted: number;
  supersededWrites: number;
  authoredSeen: number;
  effectAcks: number;
  derivedCommits: number;
  /** max over active spaces of (store head seq − W). */
  watermarkLag: number;
  events: {
    appended: number;
    processed: number;
    coalescedPerWaveMax: number;
    skippedIdempotent: number;
  };
  memo: { hits: number; misses: number; inflight: number };
  outbox: { queued: number; completed: number; failed: number };
  lease: { held: number; lost: number };
};

export const emptyServingLoopStats = (): ServingLoopStats => ({
  activeSpaces: 0,
  waves: 0,
  wavesBudgetExhausted: 0,
  supersededWrites: 0,
  authoredSeen: 0,
  effectAcks: 0,
  derivedCommits: 0,
  watermarkLag: 0,
  events: {
    appended: 0,
    processed: 0,
    coalescedPerWaveMax: 0,
    skippedIdempotent: 0,
  },
  memo: { hits: 0, misses: 0, inflight: 0 },
  outbox: { queued: 0, completed: 0, failed: 0 },
  lease: { held: 0, lost: 0 },
});

// One provider per process (the ExecutorHost registers itself); the
// health route reads through this seam so toolshed needs no reference to
// the host instance.
let servingLoopStatsProvider: (() => ServingLoopStats) | undefined;

export const registerServingLoopStatsProvider = (
  provider: (() => ServingLoopStats) | undefined,
): void => {
  servingLoopStatsProvider = provider;
};

/** The current counters, or undefined when no ExecutorHost runs in this
 * process (the OFF arm; the health route omits the block then). */
export const getServingLoopStats = (): ServingLoopStats | undefined =>
  servingLoopStatsProvider?.();
