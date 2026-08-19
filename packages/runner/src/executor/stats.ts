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
  /** Demanded roots that reached the TERMINAL not-loadable state
   * (server-execution v2 stage P2-F, the OW19 demand-cycle design): the
   * root's doc is confirmed synced from the durable store and carries
   * no pattern meta, so the demand cycle STOPS retrying it — no more
   * per-cycle churn — until a commit touching one of the load's
   * observed docs re-arms it (the not-yet vs never distinction).
   * Counted per terminalization, so a root that re-arms and
   * terminalizes again counts again. */
  structureLoadTerminal: number;
  /** Terminal roots RE-ARMED by a commit touching one of their observed
   * docs (the OW19 re-arm half): the root returns to the pending set
   * and the next cycle retries its load — this is what keeps the
   * terminal state safe for the creation race (a not-yet-created
   * piece's instantiation commit re-arms and then loads). */
  structureLoadRearmed: number;
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
  /** Served navigate-intent transactions whose seal FAILED — resolved
   * `{ error }` or rejected (navigate-to.ts's intent-commit arms,
   * independent review NOTE-b). Every failure requeues the owning
   * event (owner review P1-2: the seal wrapper's noteSealFailure —
   * conflict AND isolated classes alike), so the count is a pure
   * health signal: a growing count means intent seals are failing and
   * the loop is burning re-drains on them, never that navigations are
   * being lost. */
  servedIntentSealFailures: number;
  /** Park-time runtime disposes that overran their deadline and were
   * abandoned (park LIVENESS, the lunch-wall containment): a hung
   * dispose must never wedge `whenParked` and every recovery chained
   * behind it. Nonzero says a serving runtime refused to tear down —
   * loud in logs, counted here. */
  parkDisposeTimeouts: number;
  /** Failure-park re-activations delayed by the host's streak backoff
   * (a permanently-failing space must reactivate at a bounded rate,
   * not as fast as admissions arrive). */
  reactivationBackoffs: number;
  /** Foreign-space writes refused at wave ACCUMULATION (serving-loop.md
   * §3d, RULED 2026-08-14 (c); Phase 5 keeps the counter for the
   * accept gate's refusals): action-scoped — the writing action fails,
   * the wave and the loop keep serving. Nonzero names either a
   * carriage-less foreign write (a pattern materializing ambient
   * service-identity state — the lunch-wall class) or an UNGRANTED one
   * (an acting identity reaching for a space it holds no structural
   * grant on — protocol.md §2b's authorization predicate). */
  foreignWriteRefusals: number;
  /** Foreign co-hosted ENGINE resolutions that FAILED at the wave's
   * commit step (Phase 5, the F1b isolation): the failing space's
   * contributions withdraw action-scoped (events requeue, derivations
   * drop) and the wave commits the rest — the home space never parks
   * for one unresolvable foreign target. Counted per failed space per
   * wave; a growing count names a foreign store that persistently
   * cannot open (disk trouble, or a provisioning target with an
   * unusable path). */
  foreignEngineFailures: number;
  /** Server-execution v2 fan-out stage B (design §B5, RULED 2026-08-16
   * accept-and-count): derivation runs under the wave-level FALLBACK
   * identity — an action NOBODY demands with an identity — that
   * discovered a scope narrower than `space`. Such a run wrote the
   * SERVICE identity's instance (`user:<serviceDID>`), an inert row no
   * client's applicable set includes: accepted, counted here, never
   * delivered as anyone's instance. A demanded piece never lands here
   * (the service identity runs NO demanded work); a growing count names
   * an eager/idle-scheduled narrowing node no principal watches. */
  undemandedNarrowingRuns: number;
  /** Fan-out stage B's early-emit guard (design §F risk 4, RULED
   * 2026-08-16 fail-closed): a demanded derivation run that EMITTED an
   * event before its scope ratchet had moved — the emission carried a
   * broader (lesser) actor than the run's final discovered scope
   * implies — is REFUSED at the seal and withdrawn; the node's ratchet
   * has learned the scope, so the retry emits correctly attributed.
   * Never silently sessionless. Counted per refusal. */
  earlyEmitRefusals: number;
  /** Fan-out stage B's ARRIVAL RE-ARMS (design §A): demand-registry
   * passes that found a new (principal, session) demander for a root
   * and re-armed the narrowed nodes beneath it for that demander. */
  demandArrivals: number;
  /** max over active spaces of (store head seq − W). */
  watermarkLag: number;
  /** The (d′) `demand` counter block (serving-loop.md §7; stage-C design
   * §6 W4). Demand is memory v2's tracked-ids closure and the demand walk
   * is deleted, so there is NO `walkRuns` counter — its absence is T9′'s
   * structural witness. `demandedRows` = rows the last pass saw (the
   * exposed closure size); `demandedInstances` = distinct registry keys
   * (current / max — the demanded instance count and its peak);
   * `demandedPairs` = total (key, demanding-pair) entries; the standing
   * demand-root set (`demandedWriters` current / max);
   * `demandRootEnters` / `demandRootLeaves` ACCUMULATED across the space's
   * whole life (park and reactivation included — held here, not read from
   * the current runtime's counters, which reset on a fresh runtime);
   * `notCurrentRearms` (per-key not-current-for-pair re-arms, accumulated);
   * `demandPasses` and `demandPassMs` (the pass's O(rows) reconcile cost —
   * the pass must stay delta-cheap, W0 obligation (i)); `pushGrowthWakes`
   * (the new push-time notify's count) and `watchWakes` (the pre-existing
   * `session.watch.set` / `.add` notifies). `demandArrivals` is the
   * pre-existing top-level `servingLoop.demandArrivals` counter (the
   * root-level arrival re-arm's count), not duplicated here. */
  demand: {
    demandedRows: number;
    demandedInstances: number;
    demandedInstancesMax: number;
    demandedPairs: number;
    demandedWriters: number;
    demandedWritersMax: number;
    demandRootEnters: number;
    demandRootLeaves: number;
    notCurrentRearms: number;
    demandPasses: number;
    demandPassMs: number;
    pushGrowthWakes: number;
    watchWakes: number;
  };
  /** SERVER SETTLE per authored input (serving-loop.md §7; stage-C design
   * §6 W4's metric): from the authored commit's ADMISSION on the server
   * (its seq, `enqueueCommit`) to W COVERING it (the wave commit whose
   * `derivedThrough` ≥ seq). Bounded per-space series; `class` splits the
   * VALUE-ONLY path from the STRUCTURAL-GROWTH path (a push-growth demand
   * wake fired between admission and coverage). `waves` = committed
   * waves between admission and coverage (the T2′/T3′ cycle count). W4's
   * quiet acceptance run reads p50/p95 from this series. */
  settle: {
    series: Array<{
      space: string;
      seq: number;
      admittedAt: number;
      coveredAt: number;
      ms: number;
      waves: number;
      cycles: number;
      growthWakes: number;
      class: "value-only" | "structural-growth";
      eventAppend: boolean;
    }>;
    dropped: number;
  };
  events: {
    appended: number;
    processed: number;
    coalescedPerWaveMax: number;
    skippedIdempotent: number;
    /** Stage C tuning (T3's companion guard): drain passes that found a
     * pending entry whose EARLIER drain copy is still queued or in flight
     * in the serving scheduler (its dispatch has not reached its commit
     * callback yet) and did NOT queue it again. With an honest flush
     * deadline (T3) a cycle routinely ends before a just-drained event
     * has run, and the post-commit re-arm re-drains the still-pending
     * entry next cycle — pre-guard that queued a second copy per cut
     * cycle (4× dispatch of the lockdown toggle on the two-browsers gate;
     * #5969's re-scan variant, (β)). Counted per skipped re-queue; a count
     * that grows without `processed` settling names a drain copy that
     * never completes. */
    drainInFlightSkips: number;
  };
  memo: { hits: number; misses: number; inflight: number };
  outbox: {
    queued: number;
    completed: number;
    failed: number;
    /** Phase 6 (serving-loop.md §5's per-space budgets): dispatch
     * holds — an admitted network effect waiting on the outstanding
     * cap or an egress-rate token. Growth under load is the budget
     * WORKING (the runaway degrades its own space), not a failure. */
    budgetDeferrals: number;
  };
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
  structureLoadTerminal: 0,
  structureLoadRearmed: 0,
  watermarkClamped: 0,
  unstampedSealRefusals: 0,
  servedIntentSealFailures: 0,
  parkDisposeTimeouts: 0,
  reactivationBackoffs: 0,
  foreignWriteRefusals: 0,
  foreignEngineFailures: 0,
  undemandedNarrowingRuns: 0,
  earlyEmitRefusals: 0,
  demandArrivals: 0,
  watermarkLag: 0,
  demand: {
    demandedRows: 0,
    demandedInstances: 0,
    demandedInstancesMax: 0,
    demandedPairs: 0,
    demandedWriters: 0,
    demandedWritersMax: 0,
    demandRootEnters: 0,
    demandRootLeaves: 0,
    notCurrentRearms: 0,
    demandPasses: 0,
    demandPassMs: 0,
    pushGrowthWakes: 0,
    watchWakes: 0,
  },
  settle: { series: [], dropped: 0 },
  events: {
    appended: 0,
    processed: 0,
    coalescedPerWaveMax: 0,
    skippedIdempotent: 0,
    drainInFlightSkips: 0,
  },
  memo: { hits: 0, misses: 0, inflight: 0 },
  outbox: { queued: 0, completed: 0, failed: 0, budgetDeferrals: 0 },
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
