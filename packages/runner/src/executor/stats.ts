// The serving loop's counters (server-execution v2 stage F,
// serving-loop.md §7): exposed via the existing `/api/health/stats`
// shape as the `servingLoop` block. Implemented WITH the loop, not
// after — every phase gate in the plan reads these counters, and tests
// MUST assert on counters, not logs. The §3 amplification metric is
// computable from counters alone:
// `derivedCommits / (authoredSeen − effectAcks)`.
//
// Stage boundaries, stated so zeros read as design rather than gaps:
// `events.*` counts nothing until Phase 3 lands events-down, and
// `effectAcks` nothing until Phase 4's effect-channel acks exist.
// `memo.*` and `outbox.*` are LIVE since stage G: memo.hits counts
// builtin evaluations that resolved from the stored request hash
// (serving-loop.md §4's hit rule; reported for the fetch*, generate*
// and sqliteQuery families — fetchProgram and llmDialog count misses
// via the outbox but report no hit events yet). Each hit is one
// stored-key RESOLUTION per §4's hit rule — the stored result (or
// error-shaped result) IS the node's value and no effect fires: one
// avoided external call at that evaluation. The granularity caveat
// for Phase 2's gate arithmetic: hits count per EVALUATION, not per
// distinct request — one settled node re-evaluated N times counts N
// hits — so hit/miss ratios compare resolutions to admissions, never
// "N distinct requests suppressed". (In-flight dedupe of a live key
// is neither: attachment, not a hit.) memo.misses counts
// effects admitted to the outbox (every deferred post-commit effect —
// the serving posture's only producers today are the effectful
// builtins' requests), memo.inflight the live entries;
// outbox.queued/completed track admissions and settled effect work,
// and outbox.failed counts INFRASTRUCTURE failures (a flush throw, a
// rejected work promise, an LT4 deterministic append rejection) —
// effect-level failures commit error-shaped RESULTS per §4 and are
// memo-visible, not outbox failures.

export type ServingLoopStats = {
  activeSpaces: number;
  waves: number;
  wavesBudgetExhausted: number;
  supersededWrites: number;
  authoredSeen: number;
  effectAcks: number;
  derivedCommits: number;
  /** Demanded-structure loads that failed (serving-loop.md §1's ON-arm
   * bring-up posture: a value the server cannot serve stays
   * client-derived until Phase 2 hardens the load path — counted AND
   * surfaced here, not just logged). */
  structureLoadFailures: number;
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
  structureLoadFailures: 0,
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
