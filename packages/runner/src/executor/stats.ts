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
// via the outbox but report no hit events yet). A hit is a
// RE-EVALUATION that touched a settled effect node — not a suppressed
// fire: one settled node re-evaluated N times counts N hits with zero
// calls avoided, so Phase 2's gate arithmetic must not read memo.hits
// as "avoided calls". memo.misses counts
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
  /** Demanded-structure loads that THREW (serving-loop.md §1: a value
   * the server cannot serve is counted AND surfaced here, not just
   * logged). Counted per attempt; the loop retries the root on each
   * subsequent input-driven demand cycle until the load lands. */
  structureLoadFailures: number;
  /** Demanded-structure ensure attempts that returned FALSE — the root
   * carried no loadable pattern identity yet, typically the creation
   * race (the demand cycle ran before the piece's instantiation
   * commit applied to the serving replica). Counted per attempt, like
   * structureLoadFailures, and retried the same way: the missing meta
   * arrives as an input, which fires the retrying cycle. A count that
   * grows without settling flags a demanded root that never becomes
   * loadable (e.g. a plain value doc demanded as if it owned a
   * piece). */
  structureLoadDeferred: number;
  /** Waves whose W advance was CLAMPED below the input batch head
   * because inbound foreign novelty was still shadowed by a parked own
   * write (the settle input barrier, Phase 2 revisit (a):
   * `ISpaceReplica.unappliedForeignSeqFloor`). The clamp is honesty,
   * not a failure — W catches up the wave after the shadow clears — but
   * a count that grows without settling flags a wedged marker channel. */
  watermarkClamped: number;
  /** Write-carrying transactions REFUSED at the wave's seal because no
   * run context was stamped (serving-loop.md §3d, RULED 2026-08-05).
   * Structurally zero when every server-side commit path declares its
   * run context; any non-zero count names an undeclared commit path —
   * the class that wedged the resumed list builtins' recovery seeds
   * (the out-of-band editWithRetry retried the refusal without ever
   * landing, so the demanded derivation never materialized). Counted
   * here so the storm is a health-stats fact, not a log-grep. */
  unstampedSealRefusals: number;
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
  structureLoadDeferred: 0,
  watermarkClamped: 0,
  unstampedSealRefusals: 0,
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
