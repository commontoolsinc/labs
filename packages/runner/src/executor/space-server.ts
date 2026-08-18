// The SpaceServer (server-execution v2 stage F, serving-loop.md §1, §3):
// one committing runtime per ACTIVE space. It owns the lease (renewed on
// a timer — stage B's cycle finally gets its cadence), the serving
// Runtime (flag ON, builtins registered, the pattern-update posture
// flipped server-side — §3e), the accepted-commit subscription (the
// host's in-process feed — plane (d)), and the wave loop: wake on
// accepted commit, run the affected graph to fixpoint through the
// stage-D wave machinery, commit ONE derived transaction per wave
// carrying the watermark (protocol.md §4).
//
// What activation LOADS (RULED 2026-08-02): there is NO piece-start
// policy. The space is one lazy reactive graph; activation loads graph
// structure sufficient to resolve the DEMANDED values (client
// subscriptions — the server's watch registry) and queued events — via
// `ensurePieceRunning`, the sanctioned prior art (the no-handler
// auto-load path), per demanded root, never "instantiate the pieces" as
// a step of its own. Undemanded derivations stay dirty-unmaterialized
// indefinitely.
//
// Phase-1 bounds, stated (the stage cut, plan Phase 1):
// - no events on the wire until Phase 3 (the event seam exists in the
//   wave machinery; this loop has no producers to drain), so
//   `events.*` counters stay 0 and the activation criterion
//   "undelivered events" has no instances yet;
// - demand at OFF-arm cardinality: per-run demanded identities plug in
//   at `#stampRun` (M1's seam); in Phase 1 the loop serves the graph
//   under its wave identity.
//
// Stage G lands the effect channel (serving-loop.md §4–§5): sealed
// post-commit effects defer to the per-space outbox and fire after the
// wave commit; effectful builtins' writebacks — marked with their
// effect key — commit as their OWN derived-class COMPLETION commits
// (never through the wave: §4's "never passes through §3d's sealing"),
// annotated from the outbox carriage captured at the original run's
// seal; the durable outbound-append rows deliver and retire through
// the outbox; `memo.*`/`outbox.*` counters are live.

import {
  type AdmittedCommitNotice,
  type Server as MemoryServer,
} from "@commonfabric/memory/v2/server";
import * as Engine from "@commonfabric/memory/v2/engine";
import type {
  StreamEventEntry,
  StreamEventsDocValue,
} from "@commonfabric/memory/v2";
import type { OutboxAppendRow } from "@commonfabric/memory/v2/execution-outbox";

/** Consecutive cold-view deferrals before a drained event hardens into
 * events.md §5's DROP (see #eventDeferrals). A deferral re-arms the
 * scan from the NEXT INPUT (the creation commit arriving) or, absent
 * input, from a real-time backstop tick — never synchronously, so the
 * retry budget cannot be consumed back-to-back inside one quiet
 * moment (verdict blocker, 2026-08-12: all eight deferrals used to
 * run in immediate succession and permanently drop an event whose
 * creation input was milliseconds away). */
const EVENT_DEFERRAL_DROP_THRESHOLD = 8;

/** The deferral backstop cadence: with NO input arriving at all, a
 * deferred event retries once per tick and hardens into the DROP
 * after the full budget — bounded unrunnable-event cleanup (the park
 * criterion needs the drop) without racing the creation window. */
const EVENT_DEFERRAL_REARM_MS = 250;
import {
  markRuntimeInjectedEventKeys,
  sanitizeRuntimeInjectedEventKeys,
} from "../cell.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import {
  EXECUTION_LEASE_RENEW_INTERVAL_MS,
  ExecutionLeaseCycle,
  executionLeaseHolder,
} from "@commonfabric/memory/v2/execution-lease";
import {
  selectForeignBasisRows,
  selectStaleBasisInstances,
} from "@commonfabric/memory/v2/scheduler-basis";
import { getLogger } from "@commonfabric/utils/logger";
import type { Runtime, ServerRunInfo } from "../runtime.ts";
import type {
  IExtendedStorageTransaction,
  IStorageTransaction,
  ITransactionSealSink,
  MemorySpace,
  NativeStorageCommit,
  Result,
  SealedCommitVerdict,
  SealedNativeCommit,
  TransactionSealDestination,
  Unit,
} from "../storage/interface.ts";
import type { CommitError } from "../storage/interface.ts";
import {
  ensurePieceRunningVerdict,
  type EnsurePieceVerdict,
} from "../ensure-piece-running.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  waveRunContextOf,
  type WaveWriteAnnotation,
} from "./wave.ts";
import { EngineWaveCommitSink } from "./engine-wave-sink.ts";
import { readWatermarkSeq, watermarkDocLink } from "./watermark.ts";
import type { ServingLoopStats } from "./stats.ts";
import { type SealedEffectBatch, SpaceOutbox } from "./outbox.ts";
import { effectCompletionKeyOf } from "./effect-completion.ts";
import { markRendererTrustedEvent } from "../cfc/ui-contract.ts";
import {
  identityOfScopeKey,
  resolveScopeKey,
  type ScopeKeyIdentity,
  SERVER_EXECUTION_EFFECTS_DOC_ID,
  SERVER_EXECUTION_WATERMARK_DOC_ID,
} from "@commonfabric/memory/v2";
import type { PostCommitSideEffect } from "../cfc/types.ts";

const logger = getLogger("space-server", { enabled: true, level: "warn" });

/** The sanctioned internal stamp kind's durable action id (serving-loop.md
 * §3d, RULED 2026-08-05: stage F names the kinds when it installs the
 * seal destination). */
const WATERMARK_ACTION_ID = "server-execution/watermark";

/** The acked-effect retirement's durable action id (Phase 4,
 * protocol.md §5: "the next wave retires acked entries" — a
 * bookkeeping-stamped wave write among protocol.md §1's
 * service-identity writes; serving-loop.md §3d names it with the
 * watermark advance). */
const EFFECTS_RETIREMENT_ACTION_ID = "server-execution/effects-retirement";

export type SpaceServerPolicy = {
  /** serving-loop.md §3's consequence-flush deadline T_flush (order
   * 50–100 ms; a policy knob tuned in Phase 6 — the toolshed bootstrap
   * reads SERVER_EXECUTION_FLUSH_DEADLINE_MS). */
  flushDeadlineMs?: number;
  /** Phase 6 (serving-loop.md §5's per-space budgets; README §3.8):
   * cap on dispatched-but-unsettled NETWORK effects per space —
   * "outstanding LLM calls". Undefined = unbounded. */
  maxOutstandingEffects?: number;
  /** Phase 6: per-space network-effect egress pacing (dispatches per
   * second, token bucket). Undefined = unpaced. */
  egressRatePerSecond?: number;
  /** serving-loop.md §1's IDLE_PARK_MS. */
  idleParkMs?: number;
  renewIntervalMs?: number;
  /** Deadline on the park's runtime dispose (park LIVENESS): a serving
   * runtime killed mid-wave can hang `runtime.dispose()` forever, and a
   * park gated on it never resolves `whenParked` — wedging every
   * chained recovery. On overrun the dispose is abandoned (loudly,
   * counted) and the park completes anyway. */
  parkDisposeTimeoutMs?: number;
  /** The host's failure-park re-activation backoff (read by the
   * ExecutorHost, not the SpaceServer): after N consecutive
   * `loop-failed` parks of one space, its next re-activation is delayed
   * `min(base·2^(N−1), max)` — a permanently failing space rebuilds at
   * a bounded rate instead of once per admission. A successfully
   * committed wave clears the streak. */
  failureParkBackoffBaseMs?: number;
  failureParkBackoffMaxMs?: number;
};

export type SpaceServerOptions = {
  space: MemorySpace;
  server: MemoryServer;
  engine: Engine.Engine;
  /** The service identity (DID) the DR1 holder is minted from — also the
   * loopback session's principal, which is what the read-row admission
   * matches (protocol.md §2). */
  serviceIdentity: string;
  /** Build the serving runtime over the LOOPBACK storage plane
   * (serving-loop.md §1 plane (a)). The factory owns auth and options;
   * the SpaceServer asserts the posture (flag ON) and flips the
   * pattern-update posture is the factory's duty (§3e — pass
   * `systemPatternAutoUpdate: true`). */
  createRuntime: () => Promise<{
    runtime: Runtime;
    dispose: () => Promise<void>;
  }>;
  /** The process-lifetime localSeq counter for this space's wave sink
   * (engine-wave-sink.ts's replay keying — the host owns it). */
  localSeqRef: { value: number };
  /** The host's shared counters (serving-loop.md §7). */
  stats: ServingLoopStats;
  policy?: SpaceServerPolicy;
  onParked?: (reason: string) => void;
  /** Fired on each successfully committed wave — the host's
   * failure-streak reset signal (real served progress, as opposed to an
   * activation that merely got as far as building a runtime). */
  onWaveCommitted?: () => void;
};

const DEFAULT_FLUSH_DEADLINE_MS = 100;
const DEFAULT_IDLE_PARK_MS = 30_000;
const DEFAULT_PARK_DISPOSE_TIMEOUT_MS = 5_000;

/**
 * Phase 5's foreign re-mark decision (serving-loop.md §3b's cross-space
 * bullet; §6 step 2): the (action, instance) set whose recorded FOREIGN
 * inputs moved — each basis row whose `entity_space` is not the home
 * space is judged against THAT space's own co-hosted engine's head,
 * exactly like the home scan judges home rows. Returns only instances
 * NOT already in `alreadyStale` (the home scan's findings), in row
 * order. Extracted from the activation scan so the decision is
 * unit-pinned (the F5 fix — the catch in `activate` converts any
 * breakage here into a `basis-foreign-remark-failed` warn, an
 * invisible-by-design degradation, so the helper itself must hold the
 * test surface).
 */
export async function selectForeignStaleInstances(
  engine: Engine.Engine,
  scope: { branch: string; space: string },
  engineForSpace: (space: MemorySpace) => Promise<Engine.Engine>,
  alreadyStale: ReadonlyArray<{ action: string; actionScopeKey: string }>,
): Promise<Array<{ action: string; actionScopeKey: string }>> {
  const foreignRows = selectForeignBasisRows(engine, scope);
  const staleKeys = new Set(
    alreadyStale.map((entry) => `${entry.action}\0${entry.actionScopeKey}`),
  );
  const added: Array<{ action: string; actionScopeKey: string }> = [];
  for (const row of foreignRows) {
    const key = `${row.action}\0${row.actionScopeKey}`;
    if (staleKeys.has(key)) continue;
    const foreignEngine = await engineForSpace(row.entitySpace as MemorySpace);
    const head = Engine.selectDocHead(foreignEngine, {
      id: row.entity,
      scopeKey: row.entityScopeKey,
    });
    if (head > row.seq) {
      staleKeys.add(key);
      added.push({
        action: row.action,
        actionScopeKey: row.actionScopeKey,
      });
    }
  }
  return added;
}

/** The well-known never-a-piece id classes excluded from piece demand
 * (RULED 2026-08-07): a `computed:` doc is a derivation result, a
 * `cid:` doc is a content-addressed bundle, and the watermark doc is
 * the settledness subscription — none can ever carry `patternIdentity`
 * meta, so an `ensurePieceRunning` attempt (and its retry churn) is
 * structurally futile. Remaining `of:` ids are NOT distinguishable by
 * id class (a not-yet-created piece and a never-a-piece value doc look
 * alike) — the complete terminal-state design is the owed follow-up. */
/** The dedupe key of a demanding (principal, session) pair in the
 * registry (stage B): both components, so two sessions of one user are
 * two demanders (a node beneath the root may narrow to session for that
 * user). */
const demanderPairKey = (identity: ScopeKeyIdentity): string =>
  `${identity.principal ?? ""}\0${
    identity.sessionId === undefined ? "" : String(identity.sessionId)
  }`;

/** The demand wake's coalescing grace (stage B): a watch-set change waits
 * this long before it runs a demand pass, so a burst of watches (a shell's
 * boot, a creator syncing its new piece) costs one pass and lands after
 * the creator's own setup commits. Well under the flush deadline. */
const DEMAND_WAKE_GRACE_MS = 300;

const neverAPieceRootId = (id: string): boolean =>
  id === SERVER_EXECUTION_WATERMARK_DOC_ID ||
  // Phase 4: the effects doc is a session-scoped VALUE doc every
  // flag-ON client subscribes to (protocol.md §5) — it can never carry
  // `patternIdentity` meta, so piece demand for it is structurally
  // futile (the same never-a-piece class as the watermark doc).
  id === SERVER_EXECUTION_EFFECTS_DOC_ID ||
  id.startsWith("computed:") ||
  id.startsWith("cid:");

/**
 * One space's serving loop. The SpaceServer IS the seal destination — a
 * stable dispatcher over rotating wave accumulators, so an action tx
 * that commits between waves opens the next wave rather than erroring
 * (natural double-buffering: commits arriving mid-wave belong to the
 * NEXT wave, serving-loop.md §3).
 */
export class SpaceServer implements TransactionSealDestination {
  readonly #options: SpaceServerOptions;
  readonly #holder: string;
  #lease: ExecutionLeaseCycle | undefined;
  #runtime: Runtime | undefined;
  #disposeRuntime: (() => Promise<void>) | undefined;
  #sink: EngineWaveCommitSink | undefined;
  #renewTimer: ReturnType<typeof setInterval> | undefined;
  #currentWave: WaveAccumulator | undefined;
  #sealChain: Promise<unknown> = Promise.resolve();
  #feed: AdmittedCommitNotice[] = [];
  #feedArrived: PromiseWithResolvers<void> | undefined;
  // A shadow flip that fired while no input waiter was installed
  // (r3739416418): consumed by the next #waitForInput so the wake is
  // never dropped between cycles.
  #pendingShadowFlipWake = false;
  #inputHead = 0;
  /** Highest NON-self-echo seq drained — the watermark's advance
   * target. The loop's own derived commits return on the feed above W
   * and must not count as coverage-owed input, or every wave commit
   * would trigger a watermark-only successor chasing its own seq — a
   * self-inflicted commit storm (the v1 failure class §7's
   * amplification budget exists to catch). */
  #coverageHead = 0;
  #watermark = 0;
  #active = false;
  #loopRunning = false;
  #parkRequested = false;
  readonly #parked = Promise.withResolvers<void>();
  #idleSince: number | undefined;
  #demandedRoots = new Set<string>();
  /** Demanded roots whose `ensurePieceRunning` has not yet SUCCEEDED —
   * it returned false (typically the creation race: the demand cycle
   * ran before the piece's `patternIdentity` meta applied to the
   * serving replica) or threw. Re-attempted once per demand cycle
   * until the load lands OR the root TERMINALIZES (below): cycles are
   * input-driven, and the missing meta arrives as an input (the
   * instantiation commit), which fires the cycle that retries —
   * bounded, no timers. Without this set a root attempted once before
   * its meta existed stayed in `#demandedRoots` forever and the piece
   * never started server-side (waves committed watermark-only while
   * `waitForSettled` claimed the derivation current). */
  readonly #pendingStructureLoads = new Set<string>();
  /** The TERMINAL not-loadable roots (stage P2-F, the OW19 demand-cycle
   * design — RULED direction 2026-08-07): a demanded root whose doc is
   * confirmed SYNCED from the durable store and still carries no
   * pattern meta stops retrying — no per-cycle churn — keyed by demand
   * key, valued with the load's observed doc ids. A commit touching an
   * observed doc RE-ARMS the root (back to `#pendingStructureLoads`),
   * which is what distinguishes not-yet (a creation race whose
   * instantiation commit arrives later) from never (a plain value doc
   * demanded as if it owned a piece). The ruled id-class exclusion
   * (computed:/cid:/watermark) already keeps the structurally-futile
   * classes out of piece demand entirely; this covers the remaining
   * `of:` ids, which id classes cannot split. */
  readonly #terminalStructureLoads = new Map<string, ReadonlySet<string>>();
  /** The single-flighted demand-structure load pass (stage P2-F): the
   * wave cycle races it against the flush deadline; a pass outliving
   * its wave keeps running and later cycles join it. */
  #structureLoadPass: Promise<void> | undefined;
  /** Re-armed roots whose retry waits for the CURRENT cycle's settle
   * (frame application) before re-entering `#pendingStructureLoads` —
   * retrying inside the re-arming cycle reads the replica's stale
   * pre-commit state and re-terminalizes the root. Promoted at the
   * settle boundary; the promotion latches a wake so a then-quiet
   * space retries promptly instead of sitting out the idle window. */
  readonly #rearmedAwaitingSettle = new Set<string>();
  /** Level-converted wake for the promotion above (the same latch
   * shape as the shadow-flip wake): set when re-armed roots became
   * retryable mid-cycle, consumed by the next #waitForInput. */
  #pendingStructureRetryWake = false;
  /** Level-converted demand wake (stage B): a session's watch set
   * changed (or a session opened) and the grace elapsed; consumed by the
   * next #waitForInput. */
  #pendingDemandWake = false;
  /** The demand wake's grace timer (see noteDemandChanged). */
  #demandWakeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Wave-bound seals CHAINED but not yet applied (the F4 fix, as a
   * LEVEL): seal() returns after arming the seal chain, so a seal
   * landing in a cycle's last microtasks — after the closing wave
   * detached — is invisible to #hasWork()'s contribution count until
   * the chain runs, and the edge-triggered wake fired into no waiter;
   * the loop then armed and slept out the idle window over real work.
   * Counting chained-not-yet-applied seals makes #hasWork() see them:
   * a pre-detach seal drains before its own cycle's commit barrier
   * (`await #sealChain`), so it adds no spurious cycle, while a
   * post-detach seal keeps the loop running one more cycle — the
   * deterministic wake the removed host fan-out had provided
   * incidentally. */
  #pendingWaveSeals = 0;
  /** The activation scan's head: records at or below it are covered
   * by the basis re-mark and never drained (activation filters the
   * queued feed the same way). Late-arrival accounting keys off it. */
  #activationScanHead = 0;
  /** Exact-once guard for LATE records (seq ≤ inputHead at drain —
   * the two-producer notice race documented in #drainFeed): recently
   * drained seqs, insertion-ordered, pruned at a bound that far
   * exceeds any realistic in-process reorder window. */
  readonly #drainedLateWindow = new Set<number>();
  /** Live readers per demanded root — DEMAND ITSELF (serving-loop.md
   * §1: "a subscription to a value recomputes that value and its
   * upstream"): the sink is what pulls the demanded value through the
   * scheduler's pull-based laziness. Released on park. */
  readonly #demandSinks = new Map<string, () => void>();
  /** The DEMANDERS per demand key (server-execution v2 Phase 2, M1's
   * demand carriage — scopes.md §5: the demand supplies the run
   * identity; fan-out stage B: identity on SPACE-scoped demand rows too
   * — scopes.md §2's mechanism sentence, RULED 2026-08-16: a
   * principal's demand at a broad address is demand for THAT principal's
   * instance of every node that narrows beneath it). Keyed by demand key
   * (one per root INSTANCE the structure load and the demand walk
   * address), valued with EVERY (principal, session) pair whose watch
   * names that key — a space root demanded by two users holds both
   * pairs; a user-scoped root demanded by two sessions of one user holds
   * both sessions (a node beneath it may narrow to session for that
   * user). The run SUPPLY reads this: the scheduler resolves an
   * action's demand roots through `#demandersFor` and derives the
   * instance set from the demanders and its own known-scope ratchet
   * (scheduler/fan-out.ts). Anonymous sessions (no principal) register
   * the key — structure and walk — but own no instance and are not
   * demanders. */
  readonly #demandersByKey = new Map<string, Map<string, ScopeKeyIdentity>>();
  /** Demand key → the piece root doc id its structure load RESOLVED to
   * (stage P2-F): a demanded root may be an argument/derived doc whose
   * owning piece `ensurePieceRunning` discovers by following the result
   * chain; the run supply must find the demand's identity from that
   * PIECE's actions too, not only when the demand names the piece root
   * itself. Entries retire with their demand key. */
  readonly #pieceRootByDemandKey = new Map<string, string>();
  /** The stage-G effect channel (serving-loop.md §4–§5). */
  #outbox: SpaceOutbox | undefined;
  /** A drain left undelivered rows behind (transport-class failure):
   * the next wave cycle re-drains even without fresh appends. */
  #outboxDrainOwed = false;
  /** Phase 3 (events-down): an event-append admission (or a wave's
   * requeue) owes the next wave a stream-sidecar scan — the drain
   * input (serving-loop.md §3's event-append classification; §6
   * step 4's reprocess scan is the same move at activation). */
  #eventScanOwed = false;
  /** Phase 4 (protocol.md §5): an effects-doc-touching authored commit
   * (an ack) — or activation (a crash between ack and retirement must
   * still retire) — owes the next wave the acked-entry retirement scan.
   * Cleared only when the scan finds nothing retirable, so a dropped
   * retirement write (the bookkeeping conflict class's drop-whole arm,
   * serving-loop.md §3d) self-heals on the following cycle. */
  #effectsRetirementOwed = false;
  /** Consequence-notice seals in flight (the error/drop/skip arms):
   * awaited before the wave closes so their marks ride THIS wave. */
  readonly #eventNoticeWork = new Set<Promise<unknown>>();
  /** Consecutive DEFERRALS per eventId (cold-view piece loads). The
   * deferral arm exists for the creation race (OW19's conflation
   * caution: a not-yet-created piece and a never-startable one are
   * indistinguishable by id), so a bounded number of waves must pass
   * before a deferral hardens into events.md §5's DROP — the race
   * resolves within a few input-driven cycles, while a permanently
   * unstartable piece would otherwise re-drain forever (no notice, no
   * park). Cleared on activation (a fresh runtime re-tries from
   * scratch) and on any non-deferred outcome. */
  readonly #eventDeferrals = new Map<string, number>();
  /** The deferral backstop timer (see EVENT_DEFERRAL_REARM_MS): armed
   * when a drain pass left deferred/transient work behind, so the scan
   * re-arms after a REAL wait even when no input ever arrives. Input
   * arriving first promotes the owed scan immediately (#drainFeed). */
  #deferredRescanTimer: ReturnType<typeof setTimeout> | undefined;
  /** Post-commit effects of sealed transactions, deferred per wave
   * (serving-loop.md §3: effects hand to the outbox POST-commit, never
   * at seal). Admitted to the outbox after the wave's commit step;
   * discarded when the wave is abandoned (the park path — the runtime
   * dies with it, the crash-equivalent covered by memo re-miss). */
  readonly #pendingEffectsByWave = new Map<
    WaveAccumulator,
    SealedEffectBatch[]
  >();
  /** Which wave each sealed tx closed into — set at seal, consumed by
   * deferSealedEffects (which runs after the seal resolved, when the
   * wave may already have rotated). */
  readonly #waveByTx = new WeakMap<object, WaveAccumulator>();

  constructor(options: SpaceServerOptions) {
    this.#options = options;
    this.#holder = executionLeaseHolder(options.serviceIdentity);
  }

  get space(): MemorySpace {
    return this.#options.space;
  }

  get holder(): string {
    return this.#holder;
  }

  get active(): boolean {
    return this.#active;
  }

  get watermark(): number {
    return this.#watermark;
  }

  /** Resolves when this SpaceServer has fully parked (lease released,
   * runtime disposed). The host chains re-activation on it when a
   * session-open or admission races a park in progress. */
  get whenParked(): Promise<void> {
    return this.#parked.promise;
  }

  /** Store head minus W — the per-space input to §7's watermarkLag. */
  get watermarkLag(): number {
    return Math.max(
      0,
      Engine.serverSeq(this.#options.engine) - this.#watermark,
    );
  }

  /**
   * Activate (serving-loop.md §3 "on activate"): acquire the lease (else
   * park), build the serving runtime, read W, re-mark the dirty frontier
   * from the basis index, and subscribe from the head the index scan ran
   * against — the host feeds records from its admission observer, and
   * records at or below the scan head are covered by the re-mark.
   */
  async activate(): Promise<boolean> {
    if (this.#active) return true;
    const { engine, space } = this.#options;
    const lease = new ExecutionLeaseCycle({
      engine,
      space,
      holder: this.#holder,
    });
    if (!lease.acquire()) {
      this.#options.onParked?.("lease-unavailable");
      return false;
    }
    this.#lease = lease;
    this.#options.stats.lease.held += 1;

    let runtime: Runtime;
    let dispose: () => Promise<void>;
    try {
      ({ runtime, dispose } = await this.#options.createRuntime());
    } catch (error) {
      // A failed activation must not strand the acquired lease row for
      // the TTL — a successor (or this host's retry) should be able to
      // acquire immediately.
      lease.release();
      this.#lease = undefined;
      throw error;
    }
    if (runtime.experimental.serverExecution !== true) {
      await dispose();
      lease.release();
      this.#lease = undefined;
      throw new Error(
        "SpaceServer runtime must run with serverExecution enabled " +
          "(serving-loop.md §3: flag ON, server posture)",
      );
    }
    if (runtime.servingPosture !== true) {
      await dispose();
      lease.release();
      this.#lease = undefined;
      throw new Error(
        "SpaceServer runtime must be constructed with servingPosture " +
          "(serving-loop.md §3): without it the Phase-2 speculation " +
          "overlay is the runtime's default seal destination and its " +
          "factory-time structure loads would divert instead of " +
          "committing through the loopback plane",
      );
    }
    this.#runtime = runtime;
    this.#disposeRuntime = dispose;
    this.#sink = new EngineWaveCommitSink({
      engineFor: (s) => s === space ? engine : this.#foreignEngineFor(s),
      sessionId: this.#holder,
      localSeqRef: this.#options.localSeqRef,
      // The stage-G sqlite discharge: folded sqlite ops in wave batches
      // attach their cell-db file(s) through the memory server's own
      // machinery (same validations as the transact path), keyed by the
      // accumulator's per-run scope keys.
      sqliteAttachmentsFor: (s, operations, scopeKeyByOpIndex) =>
        this.#options.server.attachWaveCommitSqliteDbs(
          s === space ? engine : this.#foreignEngineFor(s),
          s,
          operations,
          scopeKeyByOpIndex,
        ),
    });
    // The effect channel (stage G, serving-loop.md §4–§5). Phase 6
    // threads the per-space egress budgets (§5's outstanding-effect cap
    // + egress rate) from the policy.
    const outbox = new SpaceOutbox({
      stats: this.#options.stats,
      space: this.#options.space,
      server: this.#options.server,
      engine,
      sessionId: this.#holder,
      localSeqRef: this.#options.localSeqRef,
      ...(this.#options.policy?.maxOutstandingEffects !== undefined ||
          this.#options.policy?.egressRatePerSecond !== undefined
        ? {
          budget: {
            ...(this.#options.policy?.maxOutstandingEffects !== undefined
              ? {
                maxOutstandingEffects: this.#options.policy
                  .maxOutstandingEffects,
              }
              : {}),
            ...(this.#options.policy?.egressRatePerSecond !== undefined
              ? {
                egressRatePerSecond: this.#options.policy.egressRatePerSecond,
              }
              : {}),
          },
        }
        : {}),
    });
    this.#outbox = outbox;
    runtime.asyncWorkObserver = (work) => outbox.observeAsyncWork(work);
    runtime.effectMemoObserver = (event) => {
      if (event.kind === "superseded") {
        this.#options.stats.outbox.superseded += 1;
        return;
      }
      this.#options.stats.memo.hits += 1;
    };
    // Stage P2-F (the F1 fold-in, RULED 2026-08-13): a piece-start
    // setup/instantiation commit that fails on this serving runtime —
    // refused at the seal, withdrawn by the wave, rejected — is a
    // demanded-structure load that failed ASYNCHRONOUSLY (the start
    // path is fire-and-forget by design). Count it where the demand
    // cycle's synchronous failures already count, so the swallowed-
    // refusal class is a health-stats fact, never a log grep.
    runtime.pieceStartCommitFailureObserver = ({ actionId, error }) => {
      this.#options.stats.structureLoadFailures += 1;
      logger.warn("piece-start-commit-failed", () => [
        `piece-start commit ${actionId} failed on the serving runtime; ` +
        "counted structureLoadFailures (stage P2-F, F1)",
        error,
      ]);
    };
    // The shadow-flip WAKE (Phase 2's settle input barrier): a clamped
    // wave's floor lifts when the replica's parked promotion flips the
    // shadowed foreign value visible — a dirtiness with NO admitted
    // commit behind it (the commit was drained waves ago; only its
    // VISIBILITY changed), so nothing on the feed ends the loop's input
    // wait and a then-quiet space would sit out the idle window with W
    // still clamped. The replica's flip path resolves the wait
    // directly; the woken cycle derives over the foreign value and W
    // catches up. The wake also LATCHES (review thread r3739416418):
    // edge-triggered alone it was dropped whenever the flip fired while
    // no waiter was installed (mid-cycle), and the next #waitForInput
    // then slept the full idle window anyway; the latch converts the
    // edge to a level the next wait consumes.
    runtime.storageManager.open(space).replica.shadowFlipObserver = () => {
      this.#pendingShadowFlipWake = true;
      this.#feedArrived?.resolve();
    };

    // Phase 4 (builtins.md §4, LT3): the served navigateTo's
    // connectivity check — the intent write requires the acting session
    // CONNECTED to this (computing) space.
    runtime.connectedSessionProbe = (principal, sessionId) =>
      this.#options.server.hasLiveSessionFor(space, principal, sessionId);
    // §7's servedIntentSealFailures (independent review NOTE-b): the
    // builtin logs the failure either way; the serving loop owns the
    // counter.
    runtime.notifyServedIntentSealFailure = () => {
      this.#options.stats.servedIntentSealFailures += 1;
    };
    // Phase 4 (protocol.md §5): arm the acked-effect retirement scan —
    // a crash between an ack and its retirement re-owes the scan here.
    this.#effectsRetirementOwed = true;

    // W = read watermark doc (0 if absent).
    this.#watermark = readWatermarkSeq(engine);

    // Recovery/warm start are the same move (serving-loop.md §6 step 2):
    // the activation scan computes the stale (action, instance) set
    // from the basis index and SURFACES it (counted, logged). Phase-1
    // truth, stated plainly: the scan does not yet seed scheduler
    // dirtiness — a fresh runtime holds no materialized graph to mark,
    // and recovery CORRECTNESS rides recompute-on-demand (a demanded
    // pull recomputes regardless, which is what makes the fresh-start
    // path sound). The index's skip-still-current warm-start VALUE
    // materializes when a later stage carries a materialized graph
    // across activation.
    const scanHead = Engine.serverSeq(engine);
    const { stale, foreignReadInstances } = selectStaleBasisInstances(
      engine,
      { branch: "", space },
    );
    // Phase 5's foreign re-mark (serving-loop.md §3b's cross-space
    // bullet; §6 step 2): recorded FOREIGN inputs are judged against
    // their own space's co-hosted engine — same surfacing posture as
    // the home scan (counted and logged; recovery correctness rides
    // recompute-on-demand over the fresh runtime either way, so a
    // failed foreign-head resolution degrades to conservative
    // surfacing, never a wedge).
    if (foreignReadInstances.length > 0) {
      try {
        stale.push(
          ...await selectForeignStaleInstances(
            engine,
            { branch: "", space },
            (foreignSpace) => this.#options.server.engineForSpace(foreignSpace),
            stale,
          ),
        );
      } catch (error) {
        logger.warn("basis-foreign-remark-failed", () => [
          `${foreignReadInstances.length} basis instance(s) carry ` +
          "cross-space reads and the foreign re-mark failed; " +
          "recompute-on-demand covers them (serving-loop.md §6 step 2)",
          error,
        ]);
      }
    }
    logger.info?.("activate", () => [
      `space ${space} activated: W=${this.#watermark} scanHead=${scanHead} ` +
      `staleInstances=${stale.length}`,
    ]);
    // §6 step 4 (Phase 3): undelivered events — stream head past the
    // per-stream eventWatermark — reprocess. The scan is the same
    // discovery the per-wave drain runs; activation only ARMS it.
    this.#eventDeferrals.clear();
    const pendingEventDocs = Engine.selectPendingStreamEventDocs(engine);
    if (pendingEventDocs.length > 0) {
      this.#eventScanOwed = true;
      // Scan-covered appends never reach #drainFeed (the subscribe-from-
      // scan-head filter drops their notices), so §7's `appended` counts
      // them here.
      this.#options.stats.events.appended += pendingEventDocs.reduce(
        (total, doc) => total + doc.entries.length,
        0,
      );
      logger.info?.("activate-events", () => [
        `space ${space}: ${pendingEventDocs.length} stream(s) hold ` +
        "undelivered events; reprocess armed (serving-loop.md §6 step 4)",
      ]);
    }
    // Subscribe from the scan head: drop queued records the scan covers.
    this.#feed = this.#feed.filter((record) => record.seq > scanHead);
    this.#activationScanHead = Math.max(scanHead, this.#watermark);
    this.#inputHead = Math.max(this.#inputHead, scanHead, this.#watermark);
    this.#coverageHead = Math.max(this.#coverageHead, scanHead);

    // serving-loop.md §6 step 5: RE-SEND pending durable outbound-append
    // rows — a crash between a wave commit (which wrote the rows) and
    // their delivery re-sends here; duplicates dedupe at the target's
    // eventId horizon. Co-hosted delivery is an engine commit, not a
    // network await.
    try {
      const drained = await outbox.deliverPendingAppends();
      this.#outboxDrainOwed = drained.remaining > 0;
    } catch (error) {
      // Arm the owed re-drain (the stage-G review's M-B): rows a failed
      // activation re-send leaves behind must ride the NEXT wave's
      // drain, not wait for the next appends-carrying wave or another
      // re-activation.
      this.#outboxDrainOwed = true;
      logger.warn("activation-resend-failed", () => [
        "outbox re-send on activation failed; rows kept for the next " +
        "drain (serving-loop.md §6 step 5)",
        error,
      ]);
    }

    // The seal destination + the §3d run stamper (stage F names the
    // sanctioned internal stamp kinds when installing the destination:
    // "bookkeeping", used by the watermark write below) + the
    // per-(action × instance) run-supply resolver (stage P2-F): the
    // scheduler consults it at the reactive-action choke point and runs
    // a demanded action once per instance, stamped from the demand
    // registry through the seam above.
    runtime.installSealDestination(this, {
      runStamper: (tx, info) => this.#stampRun(tx, info),
      runDemanderResolver: (pieceRootIds) => this.#demandersFor(pieceRootIds),
    });

    // Stage B's renew cadence, finally driven (serving-loop.md §2).
    const renewMs = this.#options.policy?.renewIntervalMs ??
      EXECUTION_LEASE_RENEW_INTERVAL_MS;
    this.#renewTimer = setInterval(() => this.#renew(), renewMs);

    this.#active = true;
    this.#options.stats.activeSpaces += 1;
    void this.#loop();
    return true;
  }

  /** Resolved co-hosted engines for FOREIGN spaces this loop's waves
   * provision into (protocol.md §2b — Phase 5). Populated by
   * #resolveForeignEngines ahead of each commit step; the sink's
   * engineFor lookup is synchronous, so a miss here is a sequencing
   * bug, not a recoverable state. Cleared on park (a re-activation
   * re-resolves — engines may have been closed meanwhile). */
  readonly #foreignEngines = new Map<MemorySpace, Engine.Engine>();

  #foreignEngineFor(space: MemorySpace): Engine.Engine {
    const engine = this.#foreignEngines.get(space);
    if (engine === undefined) {
      // The commit-step backstop (serving-loop.md §3d): reachable only
      // if a foreign batch bypassed #resolveForeignEngines — the
      // accumulation gate admits sanctioned crossings and the cycle
      // resolves their engines before commitWave, so this names a bug.
      throw new Error(
        `no resolved co-hosted engine for foreign space ${space}: the ` +
          "wave commit step runs after #resolveForeignEngines " +
          "(protocol.md §2b; serving-loop.md §3d's commit-step backstop)",
      );
    }
    return engine;
  }

  /** Resolve the co-hosted engines for a closing wave's foreign spaces
   * (Phase 5): same host, same process — store sequencing, not a
   * network await (protocol.md §2b). Failure is isolated PER SPACE
   * (the F1b fix): a space whose engine cannot resolve fails exactly
   * the contributions targeting it (wave.failForeignSpace — requeue
   * for events, drop for derivations; counted) and the wave commits
   * the rest. Before this isolation the un-caught await threw out of
   * the cycle — loop-failed → park + backoff for the HOME space, the
   * exact "space outage from one misdirected materialization" class
   * the RULED 2026-08-14 (c) accumulation refusal was built to
   * prevent, re-opened at the commit step. */
  async #resolveForeignEngines(wave: WaveAccumulator): Promise<void> {
    for (const space of wave.foreignSpaces) {
      if (this.#foreignEngines.has(space)) continue;
      try {
        this.#foreignEngines.set(
          space,
          await this.#options.server.engineForSpace(space),
        );
      } catch (error) {
        this.#options.stats.foreignEngineFailures += 1;
        logger.warn("foreign-engine-resolution-failed", () => [
          `co-hosted engine for foreign space ${space} failed to ` +
          "resolve; failing its contributions action-scoped and " +
          "committing the rest of the wave (protocol.md §2b; " +
          "serving-loop.md §3d's failure isolation)",
          error,
        ]);
        wave.failForeignSpace(
          space,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  /** The host's in-process feed (plane (d)): every admitted commit for
   * this space, own derived commits included (skipped by class + holder
   * below — serving-loop.md §3's self-echo rule). */
  enqueueCommit(record: AdmittedCommitNotice): void {
    this.#feed.push(record);
    this.#feedArrived?.resolve();
  }

  /** A session opened or its demand may have changed: reconsider the
   * demanded roots on a cycle SOON. LEVEL-converted with a GRACE
   * (fan-out stage B, the arrival re-arm's trigger): the note arms a
   * short timer (DEMAND_WAKE_GRACE_MS) and, when it fires, latches a
   * cycle — so a note landing MID-CYCLE (no input waiter installed, or a
   * demand pass that already read the roots in flight) is not lost (the
   * same latch shape as the shadow-flip and structure-retry wakes), and
   * a BURST of watch changes (a shell opening dozens of watches at boot;
   * a piece's creator syncing what it just created) coalesces into ONE
   * demand pass that runs after the burst — the creator's own setup
   * commits get a head start over the loop's first structure load and
   * derivations of that piece (protocol.md §4: a fresh subscription's
   * recompute lands in a LATER derived commit; arrival is later demand).
   * Input-driven cycles are unaffected (they run their pass regardless). */
  noteDemandChanged(): void {
    if (this.#demandWakeTimer !== undefined) return;
    this.#demandWakeTimer = setTimeout(() => {
      this.#demandWakeTimer = undefined;
      this.#pendingDemandWake = true;
      this.#feedArrived?.resolve();
    }, DEMAND_WAKE_GRACE_MS);
  }

  // ---- TransactionSealDestination ----

  seal(tx: IExtendedStorageTransaction): Promise<Result<Unit, CommitError>> {
    // Effect-COMPLETION routing (stage G, serving-loop.md §4): a marked
    // writeback of a served effect commits as its OWN derived-class
    // commit — it never enters a wave (§4's "never passes through §3d's
    // sealing"; the run is long over when the response arrives, so no
    // stamp exists to seal under). Serialized on the same chain as wave
    // seals: both mutate the replica overlay through sealNative.
    const completionKey = effectCompletionKeyOf(tx);
    if (completionKey !== undefined) {
      const committed = this.#sealChain.then(() =>
        this.#commitEffectCompletion(tx, completionKey)
      );
      this.#sealChain = committed.then(() => undefined, () => undefined);
      return committed;
    }
    const wave = this.#openWave();
    this.#waveByTx.set(tx, wave);
    const sealed = this.#sealChain.then(() => wave.seal(tx)).then(
      (result) => {
        if (result.error !== undefined) {
          // An EVENT-STAMPED tx that failed its seal requeues its
          // event (owner review P1-2): the served navigateTo's intent
          // tx is a separate event-handler-stamped tx, and an isolated
          // seal failure must not leave the event consequenced-clean
          // with the intent lost. Noted INSIDE the seal chain, so the
          // flush's pre-commit `await #sealChain` barrier guarantees
          // the mark precedes commitWave. Non-event contexts note
          // nothing (noteSealFailure filters).
          wave.noteSealFailure(waveRunContextOf(tx));
        }
        return result;
      },
    );
    this.#sealChain = sealed.then(() => undefined, () => undefined);
    // The F4 window: a seal chained during the cycle's last microtasks
    // (after wave-detach) is not yet APPLIED when #hasWork() evaluates
    // — count it as pending work until the chain settles, so the loop
    // runs one more cycle instead of sleeping out the idle window over
    // a real contribution (correctness was never at stake — the
    // wait's timeout commits the pending wave — but the wake should
    // be deterministic, not eventually-timed). A pre-detach seal
    // drains before its own cycle's `await #sealChain`, adding no
    // extra cycle.
    this.#pendingWaveSeals += 1;
    const sealApplied = () => {
      this.#pendingWaveSeals -= 1;
    };
    sealed.then(sealApplied, sealApplied);
    // The scheduler runs autonomously off storage notifications: a seal
    // can arrive while the loop waits for input, and the wave it opened
    // must be committed — wake the loop.
    this.#feedArrived?.resolve();
    return sealed;
  }

  /**
   * Stage a cross-space event append onto the CURRENT wave for the run
   * owning `tx` (Phase 3; events.md §2's cross-space arm — the append
   * travels via the outbox as an authored commit, and the acting
   * identity travels WITH it). Dispatched from the send site
   * (cell.ts's serving branch) through the runtime's installed
   * destination.
   */
  stageOutboundAppend(
    tx: IExtendedStorageTransaction,
    row: OutboxAppendRow,
  ): void {
    const wave = this.#openWave();
    this.#waveByTx.set(tx, wave);
    wave.enqueueOutboundAppend(tx, row);
    this.#feedArrived?.resolve();
  }

  /**
   * TransactionSealDestination (stage G): take ownership of a sealed
   * transaction's post-commit effects — the loop hands external effects
   * to the outbox POST-wave-commit (serving-loop.md §3), never at seal,
   * where "ok" only means accepted into a wave. Effects of an abandoned
   * wave are discarded with it (park — the runtime dies, the
   * crash-equivalent path memo re-miss covers).
   */
  deferSealedEffects(
    tx: IExtendedStorageTransaction,
    effects: readonly PostCommitSideEffect[],
  ): boolean {
    const wave = this.#waveByTx.get(tx);
    if (wave === undefined) return false;
    if (!this.#active || this.#outbox === undefined || wave.closed) {
      // The park-race straggler (the stage-G review's m-3): a tx that
      // sealed into a wave this server has since abandoned — or whose
      // commit resolves while the space is parking/parked — hands its
      // effects over AFTER the park cleared #pendingEffectsByWave,
      // possibly after a REACTIVATION rebuilt the outbox. OWN AND DROP
      // them (return true, store nothing): the abandoned wave's
      // effects are the intended crash-equivalent path §4/§6 already
      // cover (the effect re-misses from its memo key on demand), an
      // inline flush here would fire network work for a contribution
      // that never committed, and the pre-fix re-created map entry —
      // keyed by a wave no cycle will ever consume — leaked the wave
      // and its transactions for the server's lifetime.
      return true;
    }
    let pending = this.#pendingEffectsByWave.get(wave);
    if (pending === undefined) {
      pending = [];
      this.#pendingEffectsByWave.set(wave, pending);
    }
    pending.push({ tx, effects, context: waveRunContextOf(tx) });
    // Wake the loop: an effect-only batch (all-no-op tx — no
    // contribution) is otherwise invisible to it, and a handoff that
    // lands while the loop sits in #waitForInput would sleep out the
    // full idle window before the wave closes (round-2 thread 1).
    this.#feedArrived?.resolve();
    return true;
  }

  /** DIAGNOSTIC (tests): how many waves currently hold deferred effect
   * batches — the m-3 leak pin (a park-race straggler must not
   * re-create an entry nothing consumes). */
  get deferredEffectWaveCount(): number {
    return this.#pendingEffectsByWave.size;
  }

  /** DIAGNOSTIC (tests): the demanding identities recorded for a root
   * doc across its demand keys — M1's demand carriage (Phase 2), space
   * roots included (stage B). Two principals demanding one root yield
   * two entries; two sessions of one principal yield two. */
  demandedIdentitiesOf(id: string): ScopeKeyIdentity[] {
    const identities: ScopeKeyIdentity[] = [];
    for (const [key, demanders] of this.#demandersByKey) {
      if (key.endsWith(`\0${id}`)) identities.push(...demanders.values());
    }
    return identities;
  }

  #openWave(): WaveAccumulator {
    if (this.#currentWave === undefined) {
      const { engine, space } = this.#options;
      const runtime = this.#runtime!;
      this.#currentWave = new WaveAccumulator({
        space,
        basisSeq: Engine.serverSeq(engine),
        // The wave-level identity fallback: the serving session's own.
        // Per-run demanded identities arrive via #stampRun's run
        // contexts (M1), which take precedence per contribution.
        scopeKeyIdentity: runtime.scopeKeyIdentity,
        replicaFor: (s) => runtime.storageManager.open(s).replica,
        lease: this.#lease,
        // §3d refusals are COUNTED (§7): a non-zero count names an
        // undeclared commit path — the class that wedged the resumed
        // list builtins' recovery seeds until they stamped bookkeeping.
        onUnstampedSeal: () => {
          this.#options.stats.unstampedSealRefusals += 1;
        },
        // Fan-out stage B's counters (stats.ts): the early-emit guard's
        // fail-closed refusals, and design §B5's accept-and-count
        // undemanded narrowing runs.
        onEarlyEmitRefusal: () => {
          this.#options.stats.earlyEmitRefusals += 1;
        },
        onUndemandedNarrowing: () => {
          this.#options.stats.undemandedNarrowingRuns += 1;
        },
        // The Phase-5 serving posture (serving-loop.md §3d; protocol.md
        // §2b): foreign-space writes are ADMITTED at accumulation IFF
        // the sealing run carries the §2b delegated carriage (acting
        // identity + capabilityRef — the sanctioned `.inSpace`/
        // provisioning shape, which #stampRun supplies for served runs
        // acting as a principal) AND the acting identity holds a
        // structural write grant for the TARGET space (the probe
        // below — the F1 fix: carriage alone is minted for every
        // acting run and authorizes nothing). A carriage-less OR
        // ungranted foreign write — the lunch-wall class: a run
        // resolving against the SERVICE identity's ambient state, or
        // one reaching for a space its actor holds no authority
        // over — refuses action-scoped, loud, and counted into §7's
        // foreignWriteRefusals.
        foreignWrites: "accept",
        // The co-hosted memory server's structural grant supply
        // (protocol.md §2b): owner-by-identity (the actor's own home
        // space), fresh-store creation (§2b's sanctioned provisioning,
        // DID-shape-checked), or the target's own ACL granting the
        // actor WRITE — fail-closed otherwise. The refusal reason is
        // logged here; the wave's refusal message stays generic.
        foreignWriteGrant: async (foreignSpace, acting) => {
          const verdict = await this.#options.server
            .foreignWriteAuthorityFor(foreignSpace, acting.user);
          if (!verdict.granted) {
            logger.warn("foreign-write-ungranted", () => [
              `foreign write to ${foreignSpace} by acting identity ` +
              `${acting.user} holds no structural grant: ` +
              `${verdict.reason} (protocol.md §2b)`,
            ]);
          }
          return verdict.granted;
        },
        onForeignWriteRefusal: () => {
          this.#options.stats.foreignWriteRefusals += 1;
        },
      });
    }
    return this.#currentWave;
  }

  /** serving-loop.md §3d's stamping duty: the scheduler hands every run
   * here. Per-run demanded identities (M1) PASS THROUGH this seam
   * (Phase 2): a run whose ServerRunInfo carries a demand-supplied
   * identity resolves its scoped reads, result cells, seal, basis rows,
   * and outbox carriage against THAT instance; a run without one keeps
   * the wave-level identity (the cardinality-1 fallback). The SUPPLY
   * side landed with stage P2-F: the scheduler consults
   * `#runInstancesFor` (installed beside this stamper) and runs a
   * demanded action once per instance, filling these fields per run.
   *
   * ATTRIBUTION (protocol.md §1; fan-out stage B, RULED 2026-08-16 —
   * design §F): a run's RESOLUTION identity and its ATTRIBUTION are two
   * things. The demand-supplied pair resolves the run's scoped
   * addresses (a full pair, so a narrower read it discovers still names
   * a real demanded instance). What the run ACTS AS is derived from the
   * scope it DISCOVERS by running — space → no actor; user → the user
   * (`firedAt.session = "server"` on its events); session → the pair —
   * settled at the seal from the transaction's read-scope ratchet
   * (wave.ts `settleScopeAttribution`) and, for a mid-run emission, at
   * the send site from the ratchet so far under the early-emit guard.
   * So a DERIVATION with a demanded identity is stamped
   * `attributionFromScope` and NO eager acting: a user-scoped instance
   * value belongs to all of the user's sessions and carries the user
   * only; a space node demanded by anyone carries none. HANDLER runs are
   * unchanged (the event's server-stamped `firedAt` is their explicit
   * actor — LD1; the in-process LT6 shape inherits the origin's pair).
   * Never for `bookkeeping`: the loop's own writes are service-identity
   * writes that carry addressing and NO acting principal (protocol.md
   * §1's "The SpaceServer's own writes"). */
  #stampRun(tx: IExtendedStorageTransaction, info: ServerRunInfo): void {
    const principal = info.scopeKeyIdentity?.principal;
    const attributionFromScope = info.kind === "derivation" &&
      info.acting === undefined && principal !== undefined;
    const acting = info.kind !== "bookkeeping" && !attributionFromScope &&
        principal !== undefined
      ? {
        user: principal,
        ...(info.scopeKeyIdentity?.sessionId !== undefined
          ? { session: String(info.scopeKeyIdentity.sessionId) }
          : {}),
      }
      : undefined;
    stampWaveRunContext(tx, {
      actionId: info.actionId,
      kind: info.kind,
      ...(info.eventId !== undefined ? { eventId: info.eventId } : {}),
      // C8d's fold key (review 2026-08-11 M2): a same-wave cascade
      // child carries its emitter's eventId; the wave's requeue
      // closure folds the child into the requeued parent's rollback.
      ...(info.parentEventId !== undefined
        ? { parentEventId: info.parentEventId }
        : {}),
      ...(info.scopeKeyIdentity !== undefined
        ? { scopeKeyIdentity: info.scopeKeyIdentity }
        : {}),
      ...(info.actionScopeKey !== undefined
        ? { actionScopeKey: info.actionScopeKey }
        : {}),
      // Precedence: an EXPLICIT acting carriage (Phase 3's dispatch
      // reads it off the event's server-stamped `firedAt`) is the
      // event's own durable actor and wins; a HANDLER inheriting a
      // demanded pair (the in-process LT6 shape) carries it; a
      // DERIVATION's acting is settled from its discovered scope.
      ...(info.acting !== undefined
        ? { acting: info.acting }
        : acting !== undefined
        ? { acting }
        : {}),
      ...(attributionFromScope ? { attributionFromScope: true } : {}),
      // Phase 5 (protocol.md §2b's sanctioned crossing): a served run
      // acting AS a principal carries the delegated GRANT alongside its
      // actor, so its provisioning writes (a handler's `.inSpace`
      // creation, a demanded wish's home-space bootstrap) are
      // admissible at the wave's accept gate and at the target's
      // delegated admission. Structural presence, following the FP1
      // outbox precedent (`stream-append:<sidecarId>`): grant
      // RESOLUTION against per-doc grants is the OW13 owed hardening —
      // no per-doc grant store exists yet. Never for bookkeeping (the
      // loop's own writes carry no acting principal, protocol.md §1),
      // and never without an actor (a carriage-less foreign write
      // refuses at accumulation, by design).
      // A derivation attributed from its scope mints its
      // `demanded-run:<user>` carriage at the seal alongside its acting
      // (settleScopeAttribution) — none while unnarrowed.
      ...(info.kind !== "bookkeeping" &&
          (info.acting !== undefined || acting !== undefined)
        ? {
          capabilityRef: info.kind === "event-handler"
            ? `event-consequence:${info.eventId ?? "unidentified"}`
            : `demanded-run:${(info.acting ?? acting)!.user}`,
        }
        : {}),
      ...(info.streamEntry !== undefined
        ? { streamEntry: info.streamEntry }
        : {}),
    });
    if (info.streamEntry !== undefined) {
      // Phase 3 (events.md §4): the entry's `consequenced` mark rides
      // the handler's OWN transaction — sealed with its consequences,
      // rolled back with them (a thrown handler aborts the tx; a
      // requeued contribution withdraws whole), so the mark can never
      // outlive or precede the consequences it stands for. Written
      // BEFORE the handler runs; order within one tx is immaterial.
      // The per-stream `eventWatermark` is NOT written here: the
      // engine recomputes it from the contiguous consequenced frontier
      // inside the wave commit's own transaction (applyCommitTransaction
      // — a requeued entry holds it back, matching the model).
      try {
        this.#runtime!.getCellFromLink<boolean>({
          space: this.space,
          id: info.streamEntry.sidecarId as never,
          scope: "space",
          path: [
            "entries",
            String(info.streamEntry.index),
            "consequenced",
          ],
        }).withTx(tx).set(true);
      } catch (error) {
        // The mark IS the exactly-once record (events.md §4: no window
        // where an event is both consumed and replayable). Letting the
        // handler's consequences commit UNMARKED would re-run them on
        // the next drain — double consequences. Abort the tx instead:
        // the dispatch's error arm seals the error consequence (the
        // notice tx re-attempts the mark), and if that fails too the
        // entry simply stays pending — re-drained, never doubled.
        logger.warn("event-mark-failed", () => [
          `consequenced mark for ${info.eventId} failed at stamp time; ` +
          "aborting the handler tx (unmarked consequences would " +
          "re-run — events.md §4)",
          error,
        ]);
        tx.abort(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }

  /** The per-(action × instance) run supply's resolver (stage P2-F,
   * reshaped by fan-out stage B), installed beside the stamper: the
   * DEMANDERS of an action's DEMAND ROOTS — its piece root plus the
   * ancestor piece roots that instantiated it (Phase 7;
   * `SchedulerObservationIdentity.demandRootIds`: a nested pattern node
   * or result-as-pattern child is demanded through the OUTER piece a
   * client watches, and pre-Phase-7 its scoped derivations fell to the
   * service identity's instances) — from the demand registry: entries
   * whose demand key names one of the roots directly plus entries whose
   * structure load RESOLVED to one (`#pieceRootByDemandKey`), every
   * (principal, session) pair deduped. Space-scoped demand rows carry
   * their demanders too (stage B): the scheduler derives the instance
   * set from these pairs and the node's own known-scope ratchet — a
   * space node runs once (as a demander, never as the service), a
   * narrowed one per demanding principal or session. Only when NO
   * principal demands the roots does the run keep the wave-level
   * fallback (design §B5). Additionally, the current event's actor is a
   * TRANSIENT demander of the piece its event targets (RULED
   * 2026-08-16, design §B5): preflight recomputes a dirty scoped input
   * for the actor's OWN instance even if the actor watches nothing. */
  #demandersFor(pieceRootIds: readonly string[]): ScopeKeyIdentity[] {
    const demanders = new Map<string, ScopeKeyIdentity>();
    const roots = new Set(pieceRootIds);
    for (const [key, pairs] of this.#demandersByKey) {
      const keyRoot = key.slice(key.indexOf("\0") + 1);
      const resolvedRoot = this.#pieceRootByDemandKey.get(key);
      const matches = roots.has(keyRoot) ||
        (resolvedRoot !== undefined && roots.has(resolvedRoot));
      if (!matches) continue;
      for (const [pairKey, identity] of pairs) {
        if (!demanders.has(pairKey)) demanders.set(pairKey, identity);
      }
    }
    // The event actor as a TRANSIENT demander (RULED 2026-08-16, design
    // §B5 / §I.5): while a served event is queued for dispatch, its
    // `firedAt` pair counts as a demander of the event's TARGET piece,
    // so the dispatch's preflight recompute of a dirty scoped input
    // materializes the ACTOR's own instance even if the actor watches
    // nothing (the actor is entitled to it — the append was admitted
    // under their authority; never another principal's — no
    // reverse-FP2). The scheduler owns the queue and reports the pairs.
    for (
      const identity of this.#runtime?.scheduler.transientEventDemandersFor(
        pieceRootIds,
      ) ?? []
    ) {
      if (identity.principal === undefined) continue;
      const pairKey = demanderPairKey(identity);
      if (!demanders.has(pairKey)) demanders.set(pairKey, identity);
    }
    return [...demanders.values()];
  }

  /**
   * The effect-COMPLETION commit (stage G, serving-loop.md §4's miss
   * rule): a served effect's writeback — result + `requestHash`, the
   * claim/pending markers, error-shaped results — commits as ONE
   * derived-class commit of its own. It never passes §3d's sealing (no
   * wave, no basis rows, no run stamp — the run is long over when the
   * response arrives); its identity annotations are sourced from the
   * OUTBOX CARRIAGE captured at the original run's seal (necessarily
   * stamped, so completion commits inherit stamped provenance
   * transitively — the 2026-08-05 clarification), falling back to the
   * wave-level identity where no entry is live (Phase 1's cardinality-1
   * posture, where the two are the same identity). The commit carries
   * `derivedThrough = W` (protocol.md §4: every derived commit carries
   * it; a completion advances nothing) and empty `consequenceOf`.
   * Result-cell dirtiness is injected IN-PROCESS by the sealNative
   * overlay promotion + the executor-commit report below; the
   * subscription's copy is an ordinary self-echo the loop skips.
   *
   * FP6's label carriage rides STRUCTURALLY: the writeback transaction
   * re-reads the request inputs (the hash guard), so the CFC ladder
   * derives the completion write's labels from the request basis
   * through the same per-transaction machinery as the OFF arm.
   *
   * A completion transaction that itself enqueues a post-commit effect
   * would flush INLINE at this seal (deferSealedEffects keys off the
   * wave a tx sealed into, and completions seal into none): no such
   * producer exists — the builtins' completions only write — and one
   * appearing should route through the outbox deliberately, not by
   * accident of this note going stale.
   */
  async #commitEffectCompletion(
    tx: IExtendedStorageTransaction,
    effectKey: string,
  ): Promise<Result<Unit, CommitError>> {
    const runtime = this.#runtime;
    const sink = this.#sink;
    const refuse = (message: string): Result<Unit, CommitError> => ({
      error: {
        name: "StorageTransactionAborted",
        message,
        reason: new Error("effect-completion-refused"),
      },
    });
    if (!this.#active || runtime === undefined || sink === undefined) {
      return refuse(
        "effect completion arrived while the space is parked; the " +
          "effect re-misses from its memo key on re-activation " +
          "(serving-loop.md §4, §6)",
      );
    }
    const inner = tx.tx;
    if (inner.sealInto === undefined) {
      return refuse("storage transaction does not support sealing");
    }
    const carriage = this.#outbox?.carriageFor(effectKey);
    const identity = carriage?.scopeKeyIdentity ?? runtime.scopeKeyIdentity;
    const sealedSpaces: Array<{
      space: MemorySpace;
      sealed: SealedNativeCommit;
      resolveVerdict: (verdict: SealedCommitVerdict) => void;
    }> = [];
    const collector: ITransactionSealSink = {
      sealSpaceCommit: (
        space: MemorySpace,
        native: NativeStorageCommit,
        source: IStorageTransaction,
      ): Promise<Result<Unit, CommitError>> => {
        const replica = runtime.storageManager.open(space).replica;
        if (replica.sealNative === undefined) {
          return Promise.resolve({
            error: {
              name: "StorageTransactionAborted",
              message: `space replica for ${space} does not support sealing`,
              reason: new Error("seal-unsupported"),
            },
          });
        }
        const { promise, resolve } = Promise.withResolvers<
          SealedCommitVerdict
        >();
        // Stage A (OW17): the completion's local pending layer lands on
        // the CARRIAGE identity's instances — the same instances its
        // engine rows are annotated with below — so the demanded run's
        // instance sees the served result locally at verdict, not only
        // through the wire. Residual, FLAGGED (not filled): the writeback
        // transaction itself is unstamped, so its hash-guard READS resolve
        // against the service's instances; a per-instance node's effect
        // completion is unpinned in this stage.
        const sealed = replica.sealNative(
          native,
          source,
          promise,
          carriage?.scopeKeyIdentity !== undefined
            ? { identity: carriage.scopeKeyIdentity }
            : undefined,
        );
        sealedSpaces.push({ space, sealed, resolveVerdict: resolve });
        return Promise.resolve({ ok: {} });
      },
    };
    const result = await inner.sealInto(collector);
    const withdrawAll = (message: string) => {
      for (const space of sealedSpaces) {
        space.resolveVerdict({ withdrawn: { message } });
      }
    };
    if (result.error) {
      withdrawAll(`effect completion seal failed: ${result.error.message}`);
      return result;
    }
    if (sealedSpaces.length === 0) {
      // Nothing to commit (all-no-op writeback) — done.
      return { ok: {} };
    }
    if (
      sealedSpaces.length > 1 ||
      sealedSpaces[0].space !== this.#options.space
    ) {
      withdrawAll(
        "effect completion may write only the serving space " +
          "(serving-loop.md §4; cross-space consequences leave only " +
          "as outbox appends — protocol.md §2b)",
      );
      return refuse(
        "effect completion wrote a foreign space; refused " +
          "(serving-loop.md §4)",
      );
    }
    const sealed = sealedSpaces[0];
    const operations = [...sealed.sealed.commit.operations];
    if (operations.some((operation) => operation.op === "sqlite")) {
      withdrawAll("effect completion carries folded sqlite ops; refused");
      return refuse(
        "effect completion transactions must not fold sqlite ops " +
          "(sqlite writes ride scheduler runs' wave batches)",
      );
    }
    const annotations: WaveWriteAnnotation[] = [];
    for (const [opIndex, operation] of operations.entries()) {
      // Unreachable after the refusal above; narrows the op type.
      if (operation.op === "sqlite") continue;
      const scoped = operation.scope !== undefined &&
        operation.scope !== "space";
      if (scoped || carriage?.acting !== undefined) {
        annotations.push({
          op: opIndex,
          ...(scoped
            ? { scopeKey: resolveScopeKey(operation.scope, identity) }
            : {}),
          ...(carriage?.acting !== undefined
            ? {
              actingUser: carriage.acting.user,
              ...(carriage.acting.session !== undefined
                ? { actingSession: carriage.acting.session }
                : {}),
            }
            : {}),
        });
      }
    }
    const outcome = await sink.commitWave({
      space: this.#options.space,
      home: true,
      // The completion's CAS basis is NOW: it writes only its own
      // result/claim docs, and a concurrent intrusion on them surfaces
      // as a conflict the writeback's retry loop re-decides against
      // fresh state (the hash guard re-reads inputs each attempt).
      basisSeq: Engine.serverSeq(this.#options.engine),
      rebasedHeads: [],
      operations,
      preconditions: [...sealed.sealed.commit.preconditions ?? []],
      annotations,
      consequenceOf: [],
      basisInstances: [],
      holder: this.#holder,
      derivedThrough: this.#watermark,
    });
    if (outcome.error) {
      withdrawAll(
        `effect completion commit rejected: ${outcome.error.message}`,
      );
      return refuse(
        `effect completion commit rejected: ${outcome.error.message}`,
      );
    }
    sealed.resolveVerdict({ committed: { seq: outcome.ok.seq } });
    // The B-1 read-consistency gate (serving-loop.md §4): hold the
    // effect's in-flight entry until THIS completion commit's writes
    // are READABLE by the serving runtime. The verdict above resolves
    // inline, but under parked accepts (CT-1927) the replica applies
    // the promotion only when a frame's catch-up marker covers it — a
    // window where a fresh transaction's reads can miss the
    // completion. Retiring the key inside that window let a stale
    // re-run's re-admit re-claim and egress a second time (the
    // captured double-fire); deferring retirement makes the re-admit
    // dedupe instead. Sequenced after `settled` — the park-or-confirm
    // decision runs inside the sealed commit's settlement.
    const replica = runtime.storageManager.open(this.#options.space).replica;
    if (replica.whenApplied !== undefined) {
      const localSeq = sealed.sealed.localSeq;
      this.#outbox?.deferRetirement(
        effectKey,
        // A locally-rejected settle (a route replacement racing the
        // verdict) still consults whenApplied on this replica —
        // benign: a replaced replica re-pulls durable state.
        sealed.sealed.settled
          .catch(() => undefined)
          .then(() => replica.whenApplied!(localSeq)),
      );
    }
    this.#options.stats.derivedCommits += 1;
    // In-process dirtiness + push (the §4 injection): report like a
    // wave commit — subscribers get the derived rows, the feed carries
    // the record, and the loop skips its own echo by class + holder.
    const records = Engine.selectCommitsSince(this.#options.engine, {
      fromSeq: outcome.ok.seq - 1,
      limit: 1,
    });
    const record = records.find((entry) => entry.seq === outcome.ok.seq);
    if (record !== undefined) {
      this.#options.server.noteExecutorCommit({
        space: this.#options.space,
        seq: record.seq,
        class: "derived",
        holder: this.#holder,
        sessionId: record.sessionId,
        writes: record.writes as AdmittedCommitNotice["writes"],
      });
    }
    return { ok: {} };
  }

  #renew(): void {
    const lease = this.#lease;
    if (lease === undefined || !this.#active) return;
    if (!lease.renew()) {
      // Stop committing immediately (serving-loop.md §2's MUST): the
      // tenure ended inside renew(), so an in-flight wave aborts at its
      // commit step. Then re-acquire or park. The reacquire keeps this
      // loop serving ONLY when no wave sealed under the lapsed tenure:
      // a wave that does abort at commit had its sealed derivations
      // WITHDRAWN, and nothing re-arms their producers in place (no
      // revert consumer; inputs unchanged), so #waveCycle parks the
      // space on that abort rather than letting a continued loop mint a
      // watermark-only advance over work that never re-ran.
      this.#options.stats.lease.lost += 1;
      logger.warn("lease-lost", () => [
        `space ${this.#options.space}: lease renewal failed; ` +
        "in-flight wave aborts (serving-loop.md §2)",
      ]);
      if (!lease.acquire()) {
        void this.park("lease-lost");
        return;
      }
      // Survived the blip in-process. Any push pass that ran inside it
      // judged this runtime's loopback session a FORMER holder and
      // withheld or retracted its foreign instances (protocol.md §2's
      // read row is live-lease admission); tell the co-hosted memory
      // server the lease is live again so the session's exemption
      // re-arms NOW — a full re-evaluation that re-delivers what the
      // blip withheld — rather than on the next unrelated write (fan-out
      // stage A's independent review, finding 1: the silent-stale half).
      this.#options.server.noteLeaseReacquired({
        space: this.#options.space,
        principal: this.#options.serviceIdentity,
      });
    }
  }

  // ---- the loop (serving-loop.md §3) ----

  async #loop(): Promise<void> {
    if (this.#loopRunning) return;
    this.#loopRunning = true;
    try {
      while (this.#active && !this.#parkRequested) {
        await this.#waveCycle();
        if (!this.#active || this.#parkRequested) break;
        if (!this.#hasWork()) {
          const idleParkMs = this.#options.policy?.idleParkMs ??
            DEFAULT_IDLE_PARK_MS;
          this.#idleSince ??= Date.now();
          if (
            Date.now() - this.#idleSince >= idleParkMs &&
            !this.#options.server.hasLiveSessionsForSpace(
              this.#options.space,
              // The loop's own loopback session is not client demand.
              { excludePrincipal: this.#options.serviceIdentity },
            ) &&
            this.#runtime?.scheduler.hasArmedGateWake() !== true &&
            // Phase 3: undelivered events keep the space ACTIVE
            // (serving-loop.md §1's criterion) — the direct-engine
            // check is bounded by the sidecar head prefix.
            Engine.selectPendingStreamEventDocs(this.#options.engine)
                .length === 0
          ) {
            // Park per the activation policy (serving-loop.md §1): no
            // live client session, no undelivered events, idle past
            // IDLE_PARK_MS, and no armed gate wake (runtime-mapping N9:
            // a pending gate wake is "not idle").
            void this.park("idle");
            break;
          }
          await this.#waitForInput(idleParkMs);
        } else {
          this.#idleSince = undefined;
        }
      }
    } catch (error) {
      logger.error("loop-failed", "serving loop failed", error);
      // Zombie guard: an ACTIVE space whose loop died would renew its
      // lease forever while serving nothing — no successor can acquire,
      // and no cycle ever runs. Park instead: the lease releases, and
      // the host's activation hooks (admission / session open) recover
      // the space with a fresh runtime — the same recovery arm as every
      // other abort (serving-loop.md §6 step 2's recompute-on-demand).
      await this.park("loop-failed");
    } finally {
      this.#loopRunning = false;
    }
  }

  #hasWork(): boolean {
    return this.#feed.length > 0 ||
      (this.#currentWave?.contributionCount ?? 0) > 0 ||
      // Chained-not-yet-applied wave seals (the F4 fix): real work the
      // contribution count cannot see yet.
      this.#pendingWaveSeals > 0 ||
      this.#eventScanOwed ||
      this.#effectsRetirementOwed ||
      // Deferred effect batches of the OPEN wave are work (round-2
      // thread 1): an effect-only tx (an all-no-op claim re-issue —
      // the §6 step 3 recovery shape) seals no contribution, so
      // without this the loop would sleep on a quiet space while the
      // batch starves, and an idle park would drop it.
      this.#currentWavePendingEffectCount() > 0;
  }

  #currentWavePendingEffectCount(): number {
    const wave = this.#currentWave;
    if (wave === undefined) return 0;
    return this.#pendingEffectsByWave.get(wave)?.length ?? 0;
  }

  /** Re-arm the event scan for DEFERRED (transient) drain outcomes —
   * never synchronously (verdict blocker, 2026-08-12): an immediate
   * `#eventScanOwed = true` makes `#hasWork()` spin the next wave at
   * once, consuming the whole deferral budget back-to-back before the
   * creation input can arrive. Instead the scan re-arms on the FIRST
   * of: new input (#drainFeed promotes it), or the real-time backstop
   * tick here (so a permanently unrunnable event still hardens into
   * the events.md §5 DROP and clears the park criterion). */
  #armDeferredRescan(): void {
    if (this.#deferredRescanTimer !== undefined) return;
    this.#deferredRescanTimer = setTimeout(() => {
      this.#deferredRescanTimer = undefined;
      if (!this.#active) return;
      this.#eventScanOwed = true;
      this.#feedArrived?.resolve();
    }, EVENT_DEFERRAL_REARM_MS);
  }

  async #waitForInput(maxMs: number): Promise<void> {
    if (this.#feed.length > 0) return;
    if (this.#pendingDemandWake) {
      // Consume the demand latch (stage B): a watch set changed since
      // the last demand pass began; run a cycle now so the pass sees the
      // arrival (or departure) instead of sleeping out the idle window.
      this.#pendingDemandWake = false;
      return;
    }
    if (this.#pendingStructureRetryWake) {
      // Consume the settle-gated retry latch (stage P2-F): re-armed
      // roots became retryable mid-cycle; run a cycle now so the
      // demand-load pass re-attempts them against the settled replica.
      this.#pendingStructureRetryWake = false;
      return;
    }
    if (this.#pendingShadowFlipWake) {
      // A flip fired while no waiter was installed (r3739416418):
      // consume the latch and run a cycle now — the floor has lifted
      // and the catch-up wave must not wait out the idle window.
      this.#pendingShadowFlipWake = false;
      return;
    }
    this.#feedArrived = Promise.withResolvers<void>();
    const timer = setTimeout(() => this.#feedArrived?.resolve(), maxMs);
    try {
      await this.#feedArrived.promise;
    } finally {
      clearTimeout(timer);
      this.#feedArrived = undefined;
    }
  }

  /** Drain the pending feed records into this cycle's input batch:
   * self-echoes (own derived commits, by class + holder) advance the
   * input head without any marking — their consequences are themselves
   * (serving-loop.md §3). Authored records count toward §7's
   * authoredSeen. Dirtiness itself travels the scheduler's existing
   * path: the loopback session's subscriptions deliver the commits'
   * doc changes, and storage notifications mark the graph dirty. */
  #drainFeed(): { batchHead: number } {
    for (const record of this.#feed) {
      // LATE records (stage P2-F, the sx2 unskip's flake diagnosis):
      // the feed has two in-process producers — the admission hook's
      // notify (async, after the transact's engine apply) and the
      // loop's own post-commit noteExecutorCommit (sync after the
      // sink's engine apply) — so a wave echo at seq S+1 can enqueue
      // BEFORE an in-flight authored commit's notice at seq S. The
      // old `seq <= inputHead ⇒ skip` guard silently dropped such a
      // record from ACCOUNTING (authoredSeen undercounted; a terminal
      // root's re-arm missed), though never from SERVING — the
      // authored commit's dirtiness rides the session frames, which
      // the settle's input barrier orders by seq regardless of notice
      // order, so W stayed honest. Late records therefore still COUNT
      // and RE-ARM (deduped exactly — each seq is delivered once per
      // producer; the bounded set below absorbs any replay overlap),
      // while the head/coverage math stays in-order only.
      const late = record.seq <= this.#inputHead;
      if (late) {
        if (record.seq <= this.#activationScanHead) continue;
        if (this.#drainedLateWindow.has(record.seq)) continue;
      }
      this.#drainedLateWindow.add(record.seq);
      while (this.#drainedLateWindow.size > 1024) {
        const oldest = this.#drainedLateWindow.values().next().value;
        if (oldest === undefined) break;
        this.#drainedLateWindow.delete(oldest);
      }
      if (!late) this.#inputHead = record.seq;
      // Skipped BEFORE the re-arm check below, deliberately: a
      // SELF-holder derived commit touching a terminal root's observed
      // docs does not re-arm it. Reachable only for a piece created
      // server-side WITHOUT a local start — no such path exists
      // (`runner.run` always starts locally), and FOREIGN derived
      // commits (holder ≠ self) do re-arm. If a start-less server-side
      // creation path ever appears, move this skip below the re-arm.
      const selfEcho = record.class === "derived" &&
        record.holder === this.#holder;
      if (selfEcho) continue;
      if (!late) this.#coverageHead = record.seq;
      if (record.class === "authored") {
        this.#options.stats.authoredSeen += 1;
        // Phase 4 (protocol.md §5; serving-loop.md §7): an authored
        // commit touching the effects doc is an effect-channel ACK —
        // counted so the amplification metric can exclude acks
        // (testing.md §4's `authoredSeen − effectAcks`), and the
        // next-wave retirement scan is armed.
        if (
          record.writes.some((write) =>
            write.id === SERVER_EXECUTION_EFFECTS_DOC_ID
          )
        ) {
          this.#options.stats.effectAcks += 1;
          this.#effectsRetirementOwed = true;
        }
      }
      // serving-loop.md §3: "if c.class == event-append: enqueue for
      // handler processing". The notice carries ids only; the drain
      // reads the STAMPED entries from the store (the scan below), so
      // the flag is the whole classification state.
      if (record.eventAppends !== undefined && record.eventAppends.length > 0) {
        this.#eventScanOwed = true;
        this.#options.stats.events.appended += record.eventAppends.length;
      }
      // Deferred events re-try on NEW INPUT (the creation-race arm:
      // the piece's pattern-run commit is exactly such a record) —
      // this is the input signal the deferral budget counts, not a
      // synchronous self-scan.
      if (
        this.#eventDeferrals.size > 0 ||
        this.#deferredRescanTimer !== undefined
      ) {
        this.#eventScanOwed = true;
      }
      // The commit-triggered RE-ARM (stage P2-F, the OW19 design's
      // second half): a commit touching one of a terminal root's
      // observed docs returns that root to the pending set — the next
      // cycle retries its load. This is what makes the terminal state
      // safe for the creation race: a not-yet-created piece's
      // instantiation commit writes the demanded doc, re-arms it here,
      // and the retry then finds the meta (not-yet vs never).
      if (this.#terminalStructureLoads.size > 0 && record.writes.length > 0) {
        for (const [key, observed] of this.#terminalStructureLoads) {
          if (!record.writes.some((write) => observed.has(write.id))) continue;
          this.#terminalStructureLoads.delete(key);
          // SETTLE-GATED (not straight to pending): the retry must run
          // against a replica that has APPLIED the re-arming commit's
          // frames, which only this cycle's settle guarantees. A retry
          // in the same load pass reads the stale pre-commit state,
          // re-confirms "no meta", and re-terminalizes a root whose
          // meta just landed — the not-yet case would break exactly
          // where the re-arm exists to keep it sound.
          this.#rearmedAwaitingSettle.add(key);
          this.#options.stats.structureLoadRearmed += 1;
          logger.info?.("structure-load-rearmed", () => [
            `terminal demanded root re-armed by commit seq ${record.seq}; ` +
            "retry follows this cycle's settle",
          ]);
        }
      }
    }
    this.#feed = [];
    return { batchHead: this.#coverageHead };
  }

  /**
   * Drain undelivered stream events into the scheduler (Phase 3,
   * events-down; serving-loop.md §3's event-append classification, §6
   * step 4's reprocess). The STORE is the drain input — the admission
   * notices only armed the scan — so client-fired, delegated-delivered,
   * and crash-recovered entries all enter through one path
   * (events.md §2's "one path, two producers"). Entries queue per
   * stream in seq order via `facade.queueEvent` (the wake-shaping
   * entry point events.md §2 mandates); the settle loop that follows
   * runs them to quiescence inside this wave.
   *
   * Per-entry arms:
   * - runnable → queued; the dispatch stamps the run with the entry's
   *   acting identity (LD1) and its durable location, and the stamper
   *   writes the `consequenced` mark into the handler's own tx
   *   (events.md §4's same-transaction atomicity);
   * - duplicate of an already-consequenced eventId (an
   *   at-or-below-horizon re-admission — events.md §4's dedupe-horizon
   *   allowance) → SKIPPED, counted `skippedIdempotent`, its entry
   *   marked consequenced so the stream's frontier passes it
   *   (non-wedging — the model's C2-dedupe pin);
   * - handler THREW → the error is the consequence (events.md §5): a
   *   notice tx marks the entry consequenced + `error`;
   * - unrunnable (no handler after piece start — events.md §5's drop
   *   predicate) → the dropped-event notice `{status, reason}` +
   *   consequenced.
   *
   * Returns the number of events queued (the re-arm belt keys on it).
   */
  async #drainStreamEvents(runtime: Runtime): Promise<number> {
    if (!this.#eventScanOwed) return 0;
    this.#eventScanOwed = false;
    const { engine, space } = this.#options;
    const pendingDocs = Engine.selectPendingStreamEventDocs(engine);
    if (pendingDocs.length === 0) return 0;
    let queued = 0;
    for (const doc of pendingDocs) {
      // Materialize the sidecar into the SERVING replica before any
      // index-addressed mark can be written against it: a cold view
      // would materialize ghost entries (the engine's admission guard
      // refuses the resulting wave — the failure mode this sync
      // exists to prevent). The stream's own doc is synced too so the
      // no-handler auto-load's meta chain reads a warm view.
      try {
        await runtime.getCellFromLink({
          space,
          id: doc.id as never,
          scope: "space",
          path: [],
        }).sync();
      } catch (error) {
        logger.warn("event-sidecar-sync-failed", () => [
          `sidecar sync for ${doc.id} failed; its events defer to the ` +
          "next wave",
          error,
        ]);
        this.#armDeferredRescan();
        continue;
      }
      // The FULL stored log — mark indices address positions in it.
      const stored = ((Engine.read(engine, { id: doc.id })?.value ??
        {}) as StreamEventsDocValue).entries ?? [];
      const runnable = [...doc.entries].sort(
        (a, b) =>
          (a.seq ?? Number.MAX_SAFE_INTEGER) -
          (b.seq ?? Number.MAX_SAFE_INTEGER),
      );
      for (const entry of runnable) {
        const index = stored.findIndex((candidate) =>
          candidate?.eventId === entry.eventId &&
          candidate?.seq === entry.seq
        );
        if (index < 0) continue;
        const streamEntry = {
          sidecarId: doc.id,
          index,
          seq: entry.seq ?? 0,
        };
        // The mark every arm below writes (the handler tx's, the
        // skip/error/drop notices') is INDEX-ADDRESSED against the
        // REPLICA view: verify the view holds this entry at this index
        // before any of them (a lagging view defers — never a ghost
        // write). Checked ahead of the SKIP arm too (fan-out stage B):
        // the skip notice used to seal on the STORED index alone, and
        // when its wave's basis was fresh — no rebase re-CAS against
        // the head — a view still missing the entry materialized a
        // ghost `{consequenced: true}` at that index and left the real
        // entry unconsequenced (re-drained, re-skipped, ghost twice).
        {
          const viewEntry = runtime.getCellFromLink<
            { eventId?: string } | undefined
          >({
            space,
            id: doc.id as never,
            scope: "space",
            path: ["entries", String(index)],
          }).get();
          if (viewEntry?.eventId !== entry.eventId) {
            logger.warn("event-view-lag", () => [
              `drain deferring ${entry.eventId}: replica view holds ` +
              `${JSON.stringify(viewEntry)} at index ${index}`,
            ]);
            this.#armDeferredRescan();
            continue;
          }
        }
        // Only a NUMERIC-seq consequenced twin skips this entry
        // (round-2 thread T12): a seq-less consequenced entry (the
        // stage-G interim shape, legacy stores only — admission stamps
        // every new append's seq) holds no frontier position and its
        // dedupe RETIRES once consequenced (events.md §4), so a valid
        // re-admission after it is a NEW event whose handler must run
        // — skipping on the seq-less twin silently dropped it.
        const duplicateOfConsequenced = stored.some((candidate) =>
          candidate?.eventId === entry.eventId &&
          candidate.consequenced === true &&
          typeof candidate.seq === "number" &&
          candidate.seq !== entry.seq
        );
        if (duplicateOfConsequenced) {
          // events.md §4/§5: processing skips it; the entry is passed
          // by the frontier rather than wedging the stream.
          this.#options.stats.events.skippedIdempotent += 1;
          this.#sealEventConsequenceNotice(runtime, entry, streamEntry);
          continue;
        }
        const link: NormalizedFullLink = {
          space,
          id: entry.stream.id as NormalizedFullLink["id"],
          path: [...entry.stream.path],
          scope: (entry.stream.scope ?? "space") as NormalizedFullLink["scope"],
        };
        try {
          await runtime.getCellFromLink({
            space,
            id: entry.stream.id as never,
            scope: (entry.stream.scope ?? "space") as never,
            path: [],
          }).sync();
        } catch {
          // A cold stream doc defers like a cold piece load below.
        }
        try {
          // The renderer-trust RE-MARK (fan-out stage B, OW34 — the
          // sister of the injected-keys re-mint below): an entry the
          // firing runtime attested renderer-trusted (`rendererTrusted:
          // true`, set only from the process-local mark; admission
          // refuses any other value) re-marks its payload in THIS
          // runtime, so the served handler run's UI-contract-gated
          // writes record the trusted-event policy input the CFC ladder
          // requires — under the same in-process trust the client-side
          // gate ran under (the entry was committed under the firing
          // client's own admission). Without it a per-user served
          // handler's write to an owner-protected cell is refused at
          // prepare ("missing trusted-event policy input").
          if (entry.rendererTrusted === true) {
            markRendererTrustedEvent(entry.payload);
          }
          runtime.scheduler.queueEvent(
            link,
            entry.payload,
            // No scheduler-side backoff: a transiently-failed seal leaves
            // the entry unconsequenced and durable, and the post-wave
            // re-arm rescans it — the wave IS the retry cadence.
            false,
            undefined,
            false,
            {
              eventId: entry.eventId,
              // Sanitize BEFORE re-minting (verdict blocker,
              // 2026-08-12): a persisted malformed value (pre-guard or
              // corrupted rows) would throw in the mint's spread on
              // every scan — perpetual drain churn. Malformed degrades
              // to absent; the closed-world gate judges the payload
              // strictly, as with an unminted spoof.
              ...((() => {
                const carried = sanitizeRuntimeInjectedEventKeys(
                  entry.runtimeInjectedEventKeys,
                );
                if (
                  carried === undefined &&
                  entry.runtimeInjectedEventKeys !== undefined
                ) {
                  logger.warn("event-malformed-injected-keys", () => [
                    `entry ${entry.eventId} carries malformed ` +
                    "runtimeInjectedEventKeys; treated as absent",
                  ]);
                }
                return carried === undefined ? {} : {
                  // Re-mint the carried provenance in THIS runtime (the
                  // mint is a process-local trust mark): the entry's keys
                  // were committed under the firing client's own
                  // admission, the same in-process trust the client-side
                  // gate ran under.
                  runtimeInjectedEventKeys: markRuntimeInjectedEventKeys(
                    carried,
                  ),
                };
              })()),
              served: {
                ...(entry.firedAt !== undefined
                  ? {
                    firedAt: {
                      ...(entry.firedAt.user !== undefined
                        ? { user: entry.firedAt.user }
                        : {}),
                      ...(entry.firedAt.session !== undefined
                        ? { session: entry.firedAt.session }
                        : {}),
                    },
                  }
                  : {}),
                streamEntry,
                onFailure: (outcome) => {
                  if (outcome.kind === "deferred") {
                    const deferrals =
                      (this.#eventDeferrals.get(entry.eventId) ?? 0) + 1;
                    this.#eventDeferrals.set(entry.eventId, deferrals);
                    if (deferrals < EVENT_DEFERRAL_DROP_THRESHOLD) {
                      // No consequence: the entry stays pending; the
                      // re-drain waits for input or the backstop tick
                      // (the cold-view creation race — OW19's
                      // conflation caution), NEVER a synchronous spin.
                      this.#armDeferredRescan();
                      return;
                    }
                    // The race window is long past: no runnable handler
                    // exists — events.md §5's drop predicate. The
                    // notice un-renders the echo and un-wedges the
                    // stream (and the park criterion).
                    this.#eventDeferrals.delete(entry.eventId);
                    this.#sealEventConsequenceNotice(
                      runtime,
                      entry,
                      streamEntry,
                      {
                        kind: "dropped",
                        message: "no runnable handler after " +
                          `${deferrals} deferred load attempts: ` +
                          outcome.message,
                      },
                    );
                    return;
                  }
                  this.#eventDeferrals.delete(entry.eventId);
                  this.#sealEventConsequenceNotice(
                    runtime,
                    entry,
                    streamEntry,
                    { kind: outcome.kind, message: outcome.message },
                  );
                },
              },
            },
          );
          queued += 1;
        } catch (drainError) {
          logger.warn("drain-debug", () => ["per-entry threw", drainError]);
          this.#armDeferredRescan();
        }
      }
    }
    this.#options.stats.events.processed += queued;
    if (queued > this.#options.stats.events.coalescedPerWaveMax) {
      this.#options.stats.events.coalescedPerWaveMax = queued;
    }
    return queued;
  }

  /**
   * Seal one event's consequence OUTSIDE a handler tx (the skip, error,
   * and drop arms — the handler tx either never ran or aborted): an
   * event-handler-class tx carrying the entry's `consequenced` mark
   * (written by the stamper) plus the arm's notice fields
   * (events.md §5: the error — or the `{status: "dropped", reason}`
   * notice — IS the consequence, and the frontier advances past it).
   * The seal rides the CURRENT wave; the wave close awaits it.
   */
  #sealEventConsequenceNotice(
    runtime: Runtime,
    entry: StreamEventEntry,
    streamEntry: { sidecarId: string; index: number; seq: number },
    outcome?: { kind: "error" | "dropped" | "deferred"; message: string },
  ): void {
    try {
      const tx = runtime.edit();
      runtime.stampServerRun(tx, {
        actionId: `server-execution/event-consequence:${entry.eventId}`,
        kind: "event-handler",
        eventId: entry.eventId,
        streamEntry,
      });
      if (outcome !== undefined) {
        const base = {
          space: this.#options.space,
          id: streamEntry.sidecarId as never,
          scope: "space" as const,
        };
        if (outcome.kind === "error") {
          runtime.getCellFromLink<string>({
            ...base,
            path: ["entries", String(streamEntry.index), "error"],
          }).withTx(tx).set(outcome.message);
        } else {
          runtime.getCellFromLink<string>({
            ...base,
            path: ["entries", String(streamEntry.index), "status"],
          }).withTx(tx).set("dropped");
          runtime.getCellFromLink<string>({
            ...base,
            path: ["entries", String(streamEntry.index), "reason"],
          }).withTx(tx).set(outcome.message);
        }
      }
      const sealed = tx.commit().catch((error) => {
        logger.warn("event-notice-seal-failed", () => [
          `consequence notice for ${entry.eventId} failed to seal; the ` +
          "entry stays pending and the next wave re-drains it",
          error,
        ]);
      });
      this.#eventNoticeWork.add(sealed as Promise<unknown>);
      (sealed as Promise<unknown>).finally(() => {
        this.#eventNoticeWork.delete(sealed as Promise<unknown>);
      });
    } catch (error) {
      logger.warn("event-notice-failed", () => [
        `consequence notice for ${entry.eventId} could not be staged; ` +
        "the entry stays pending and the next wave re-drains it",
        error,
      ]);
    }
  }

  /**
   * Retire acked effect entries (server-execution v2 Phase 4;
   * protocol.md §5's "the next wave retires acked entries"). Per
   * retirable SESSION instance of the well-known effects doc — the
   * ENGINE is the scan authority (`selectRetirableEffectsInstances`
   * reads true per-instance values; the serving replica's local view
   * collapses instances by scope name, the OW17 residual, and is never
   * consulted) — one BOOKKEEPING-stamped transaction writes the pruned
   * value at that instance: the SpaceServer's OWN write under its
   * service identity, carrying ADDRESSING (the seal-time scope-key
   * annotation from the stamped identity) and NO acting principal
   * (protocol.md §1's service-identity writes; T2.Q4). Conflict class:
   * a whole-doc bookkeeping SET drops whole on any concurrent write
   * (serving-loop.md §3d) — the owed flag stays armed until a scan
   * finds nothing retirable, so a dropped retirement self-heals next
   * cycle. Un-acked intents persist by construction: the prune removes
   * only acked entries (a reload re-reads and may re-enact them — LT8).
   */
  #retireAckedEffects(runtime: Runtime): void {
    if (!this.#effectsRetirementOwed) return;
    let retirable: ReturnType<
      typeof Engine.selectRetirableEffectsInstances
    >;
    try {
      retirable = Engine.selectRetirableEffectsInstances(
        this.#options.engine,
      );
    } catch (error) {
      logger.warn("effects-scan-failed", () => [
        "acked-effect retirement scan failed; retrying next cycle",
        error,
      ]);
      return;
    }
    if (retirable.length === 0) {
      this.#effectsRetirementOwed = false;
      return;
    }
    for (const instance of retirable) {
      const identity = identityOfScopeKey(instance.scopeKey);
      if (
        identity?.principal === undefined || identity.sessionId === undefined
      ) {
        // Not a session instance (the scan already filters; defensive).
        continue;
      }
      try {
        const tx = runtime.edit();
        stampWaveRunContext(tx, {
          actionId: EFFECTS_RETIREMENT_ACTION_ID,
          kind: "bookkeeping",
          // ADDRESSING only: the seal resolves the write's scope key
          // from this identity; bookkeeping carries no acting principal
          // (protocol.md §1).
          scopeKeyIdentity: identity,
        });
        tx.writeValueOrThrow(
          {
            space: this.#options.space,
            id: SERVER_EXECUTION_EFFECTS_DOC_ID,
            scope: "session",
            path: [],
          } as never,
          {
            entries: instance.remainingEntries,
            acks: instance.remainingAcks,
          } as never,
        );
        tx.commit().then(({ error }) => {
          if (error) {
            logger.warn("effects-retirement-seal-failed", () => [
              `retirement for ${instance.scopeKey} failed to seal; ` +
              "the armed scan retries next cycle",
              error,
            ]);
          }
        }).catch((error) => {
          logger.warn("effects-retirement-seal-failed", () => [
            `retirement for ${instance.scopeKey} rejected; the armed ` +
            "scan retries next cycle",
            error,
          ]);
        });
      } catch (error) {
        logger.warn("effects-retirement-failed", () => [
          `retirement for ${instance.scopeKey} could not be staged`,
          error,
        ]);
      }
    }
    // Stay armed: the next cycle's scan verifies the retirements landed
    // (and clears), or re-writes what a conflict dropped.
  }

  /** Load graph structure for the demanded values (serving-loop.md §1):
   * the server-side watch registry names what clients demand; each
   * demanded root's owning piece is ensured running (the sanctioned
   * auto-load prior art) so the scheduler can pull the demanded value
   * and its upstream. An ensure that does not land is COUNTED and
   * RETRIED: a false return (structure not loadable yet — the creation
   * race, where demand precedes the instantiation commit's arrival on
   * the serving replica) counts toward §7's structureLoadDeferred, a
   * throw toward structureLoadFailures, and either leaves the root in
   * `#pendingStructureLoads` for the next input-driven cycle — the
   * missing meta arrives as a commit, and that commit fires the cycle
   * that retries. */
  async #loadDemandedStructure(): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === undefined) return;
    const roots = this.#options.server.watchedRootsForSpace(
      this.#options.space,
      // The serving session's own watches are its graph's reads, not
      // client demand.
      { excludePrincipal: this.#options.serviceIdentity },
    );
    // Demand keys are PER INSTANCE (server-execution v2 Phase 2, M1's
    // demand carriage): a scoped root demanded by two principals is two
    // demand entries — the structure load and the demand walk address
    // each instance. A space root is ONE key. Fan-out stage B: every key
    // carries its DEMANDERS — the (principal, session) pairs whose
    // watches name it, space roots included (`watchedRootsForSpace`
    // returns one row per demanding session) — the registry the
    // per-instance run supply consumes (`#demandersFor`) and the
    // diagnostic the fan-out tests pin.
    const keyOf = (root: {
      id: string;
      scope?: string;
      identity?: { principal?: string; sessionId?: string };
    }): string => {
      const scope = root.scope ?? "space";
      if (scope === "space" || root.identity === undefined) {
        return `space\0${root.id}`;
      }
      try {
        return `${
          resolveScopeKey(scope as never, {
            principal: root.identity.principal,
            sessionId: root.identity.sessionId as never,
          })
        }\0${root.id}`;
      } catch {
        return `${scope}\0${root.id}`;
      }
    };
    // The demanders per key THIS pass sees, and the roots' first row per
    // key (the structure/walk address).
    const demandersNow = new Map<string, Map<string, ScopeKeyIdentity>>();
    const rootByKey = new Map<string, (typeof roots)[number]>();
    for (const root of roots) {
      const key = keyOf(root);
      if (!rootByKey.has(key)) rootByKey.set(key, root);
      if (root.identity === undefined) continue;
      const identity: ScopeKeyIdentity = {
        ...(root.identity.principal === undefined
          ? {}
          : { principal: root.identity.principal }),
        ...(root.identity.sessionId === undefined
          ? {}
          : { sessionId: root.identity.sessionId as never }),
      };
      let pairs = demandersNow.get(key);
      if (pairs === undefined) {
        pairs = new Map();
        demandersNow.set(key, pairs);
      }
      pairs.set(demanderPairKey(identity), identity);
    }
    const currentKeys = new Set(rootByKey.keys());
    for (const [key, cancel] of this.#demandSinks) {
      if (currentKeys.has(key)) continue;
      try {
        cancel();
      } catch {
        // best-effort; the sink may already be torn down
      }
      this.#demandSinks.delete(key);
      this.#demandedRoots.delete(key);
      this.#demandersByKey.delete(key);
      this.#pieceRootByDemandKey.delete(key);
    }
    // Reconcile the demanders of every current key: departed pairs
    // retire (the instance set shrinks on the node's next run — stored
    // rows stay, scopes.md §8's GC is unchanged); NEW pairs on a KNOWN
    // key are ARRIVALS — a demander who arrives after the nodes beneath
    // the root narrowed finds no instance of their own, and a clean node
    // never re-runs for a demander that did not exist when it last ran
    // (design §A's arrival re-arm; the OW29 gap): re-arm the narrowed
    // nodes under the key's roots for that demander after the pass. A
    // FIRST-demand key's demanders need no re-arm — its structure load
    // and demand walk below are what serve them.
    const arrivals = new Set<string>();
    for (const [key, pairs] of demandersNow) {
      const known = this.#demandersByKey.get(key);
      if (known === undefined) {
        this.#demandersByKey.set(key, new Map(pairs));
        if (this.#demandedRoots.has(key)) arrivals.add(key);
        continue;
      }
      for (const pairKey of [...known.keys()]) {
        if (!pairs.has(pairKey)) known.delete(pairKey);
      }
      for (const [pairKey, identity] of pairs) {
        if (known.has(pairKey)) continue;
        known.set(pairKey, identity);
        arrivals.add(key);
      }
    }
    for (const key of [...this.#demandersByKey.keys()]) {
      if (currentKeys.has(key) && !demandersNow.has(key)) {
        // Every demander of a still-watched key left (anonymous sessions
        // remain): the key stays, its demander set empties.
        this.#demandersByKey.get(key)!.clear();
      }
    }
    // A pending or terminal load whose demand retired stops being
    // tracked (pruned directly against the demanded keys, not via the
    // sink loop above: a root whose SINK creation failed has no sink
    // entry to retire through).
    for (const key of this.#pendingStructureLoads) {
      if (!currentKeys.has(key)) this.#pendingStructureLoads.delete(key);
    }
    for (const key of this.#terminalStructureLoads.keys()) {
      if (!currentKeys.has(key)) {
        this.#terminalStructureLoads.delete(key);
        this.#pieceRootByDemandKey.delete(key);
      }
    }
    for (const key of this.#rearmedAwaitingSettle) {
      if (!currentKeys.has(key)) this.#rearmedAwaitingSettle.delete(key);
    }
    for (const [key, root] of rootByKey) {
      const firstDemand = !this.#demandedRoots.has(key);
      // A known root re-enters this loop ONLY while its structure load
      // is still owed (the retry arm); its demander set and demand walk
      // were installed on first demand and are not re-created (the
      // demanders are reconciled above on every pass).
      if (!firstDemand && !this.#pendingStructureLoads.has(key)) continue;
      if (firstDemand) {
        this.#demandedRoots.add(key);
        if (!this.#demandersByKey.has(key)) {
          this.#demandersByKey.set(key, new Map());
        }
      }
      // A root parked TERMINAL stays parked until a commit touching one
      // of its observed docs re-arms it (the #drainFeed re-arm) — no
      // per-cycle ensure churn (stage P2-F, the OW19 design).
      if (this.#terminalStructureLoads.has(key)) {
        if (!firstDemand) continue;
      } // Id-class exclusion (RULED 2026-08-07): well-known never-a-piece
      // ids register NO piece demand — no `ensurePieceRunning` attempt,
      // no retry, no `structureLoadDeferred` increment (the counter
      // stays meaningful for genuinely not-yet-loadable pieces).
      // `computed:` docs are derivation results, `cid:` docs are
      // content-addressed bundles, and the watermark doc is the
      // settledness subscription every waitForSettled/overlay client
      // holds — none can ever carry `patternIdentity` meta. The demand
      // SINK below still registers where applicable: value-granular
      // pull is not piece demand. The remaining `of:` ids — which id
      // classes cannot split into not-yet-created pieces vs
      // never-a-piece value docs — are covered by the TERMINAL state
      // below (stage P2-F): confirmed-synced-no-meta parks the root,
      // and the commit-triggered re-arm keeps the creation race sound.
      else if (neverAPieceRootId(root.id)) {
        this.#pendingStructureLoads.delete(key);
        if (!firstDemand) continue;
      } else {
        try {
          // propagateErrors: the catch below is the loop's FAILURE arm
          // (§7 structureLoadFailures); with the helper's default
          // collapse-to-false it was unreachable and every real
          // load/start error masqueraded as a creation-race deferral,
          // silently retried each input-driven cycle (r3739139521).
          const verdict = await this.#attemptStructureLoad(runtime, root);
          if (verdict.started) {
            this.#pendingStructureLoads.delete(key);
            if (verdict.rootId !== undefined && verdict.rootId !== root.id) {
              // The demand named an argument/derived doc; remember the
              // OWNING piece root so the per-(action × instance) run
              // supply finds this demand's identity from that piece's
              // actions (stage P2-F).
              this.#pieceRootByDemandKey.set(key, verdict.rootId);
            }
          } else if (verdict.reason === "no-pattern-meta") {
            // The OW19 terminal class — but only ON CONFIRMED durable
            // state: an un-synced doc reads identically, so sync the
            // observed docs from the store and re-ask once. Still
            // no meta ⇒ the durable state genuinely lacks it ⇒ TERMINAL
            // (no more per-cycle churn); a creation commit later
            // touches the doc and re-arms (not-yet vs never).
            const confirmed = await this.#confirmNoPatternMeta(
              runtime,
              root,
              verdict,
            );
            if (confirmed.started) {
              this.#pendingStructureLoads.delete(key);
              if (
                confirmed.rootId !== undefined && confirmed.rootId !== root.id
              ) {
                this.#pieceRootByDemandKey.set(key, confirmed.rootId);
              }
            } else if (confirmed.reason === "no-pattern-meta") {
              this.#pendingStructureLoads.delete(key);
              this.#terminalStructureLoads.set(
                key,
                new Set(confirmed.observedDocIds),
              );
              this.#options.stats.structureLoadTerminal += 1;
              logger.info?.("structure-load-terminal", () => [
                `demanded root ${root.id} confirmed synced with no ` +
                "pattern meta; parked terminal until a commit touches " +
                "it (stage P2-F, OW19)",
              ]);
            } else {
              this.#pendingStructureLoads.add(key);
              this.#options.stats.structureLoadDeferred += 1;
            }
          } else {
            // Not loadable YET for a non-terminal reason (a chain
            // cycle mid-write, an unloadable pattern awaiting its
            // source docs). Counted per attempt (§7
            // structureLoadDeferred) and left pending: the next
            // input-driven cycle retries.
            this.#pendingStructureLoads.add(key);
            this.#options.stats.structureLoadDeferred += 1;
            logger.debug?.("structure-load-deferred", () => [
              `demanded root ${root.id} not loadable yet ` +
              `(${verdict.reason ?? "unclassified"}); ` +
              "retrying next demand cycle",
            ]);
          }
        } catch (error) {
          this.#pendingStructureLoads.add(key);
          this.#options.stats.structureLoadFailures += 1;
          logger.warn("structure-load-failed", () => [
            `demanded root ${root.id} did not load`,
            error,
          ]);
        }
        if (!firstDemand) continue;
      }
      try {
        // The demand itself: a live reader per demanded root. Without
        // it the materialized graph's computeds stay
        // dirty-unmaterialized (pull-based laziness) and the wave never
        // has anything to derive for the subscriber. The read WALKS the
        // value (property access through the query-result proxies is
        // what pulls a computed's link), so every derivation reachable
        // from the demanded root is demanded — value-granular pull, at
        // the granularity the wire's watch selector actually names
        // (the whole doc).
        //
        // Fan-out stage B (design §B4): the walk runs PER DEMANDER — one
        // effect node, N runs — through the ordinary run supply: the
        // action carries the root as its demand root, so
        // `runSchedulerAction` fans it out over the key's demanders,
        // each run's transaction stamped with that pair, and the walk
        // resolves THAT demander's redirects and pulls THAT demander's
        // subtree (a per-user `ifElse` branch, a per-user child piece).
        // Walked once as the service — the pre-stage-B sink — the walk
        // stopped at every redirect once instances were keyed and the
        // service ran no demanded piece: everything reachable only
        // through a per-user VALUE was live for nobody. Instances: the
        // walk narrows to whatever it reads through, so a piece with
        // per-user state walks per principal (per session below a
        // session redirect) and a space-only piece walks once.
        this.#demandSinks.set(
          key,
          this.#installDemandWalk(runtime, root),
        );
      } catch (error) {
        logger.warn("demand-sink-failed", () => [
          `demand sink for ${root.id} failed`,
          error,
        ]);
      }
    }
    if (arrivals.size > 0) {
      // The ARRIVAL RE-ARM (design §A; RULED 2026-08-16): the narrowed
      // nodes beneath each arrived key's roots re-run for the arriving
      // demander only (their per-instance record is kept — B7). The
      // resolved piece root of an argument-doc demand joins the root
      // set, so a piece demanded through its argument doc re-arms too.
      const rootIds = new Set<string>();
      for (const key of arrivals) {
        rootIds.add(key.slice(key.indexOf("\0") + 1));
        const resolved = this.#pieceRootByDemandKey.get(key);
        if (resolved !== undefined) rootIds.add(resolved);
      }
      const rearmed = runtime.scheduler.invalidateActionsForDemandRoots(
        [...rootIds],
      );
      this.#options.stats.demandArrivals += 1;
      logger.debug?.("demand-arrival", () => [
        `demanders arrived for ${arrivals.size} root(s); re-armed ` +
        `${rearmed} narrowed node(s) for them (fan-out stage B)`,
      ]);
    }
  }

  /** The per-demander demand WALK for one demanded root (stage B, design
   * §B4): an EFFECT node registered through the scheduler with the root
   * as its demand root, so its runs fan out over the root's demanders
   * like any demanded action's. Each run reads the root's value through
   * its own stamped transaction — the demander's instances, redirects,
   * subtree — and writes nothing. Returns the unsubscribe. */
  #installDemandWalk(
    runtime: Runtime,
    root: { id: string; scope?: string },
  ): () => void {
    const link = {
      space: this.#options.space,
      id: root.id as never,
      scope: (root.scope ?? "space") as never,
      path: [],
    };
    const walk = (tx: IExtendedStorageTransaction): void => {
      try {
        JSON.stringify(runtime.getCellFromLink(link).withTx(tx).get());
      } catch {
        // a mid-pull proxy may throw; the re-fire after the pull
        // settles walks it again
      }
    };
    Object.defineProperty(walk, "name", {
      value: `demand-walk:${this.#options.space}/${root.id}`,
      configurable: true,
    });
    return runtime.scheduler.register(walk, undefined, {
      isEffect: true,
      observationIdentity: {
        pieceId: `space:${root.id}`,
        ownerSpace: this.#options.space,
        pieceRootId: root.id,
      },
    });
  }

  /** One structure-load attempt for a demanded root (stage P2-F): the
   * demanded INSTANCE is tried first (a scoped result doc may carry
   * its own per-instance pattern pointer), and a scoped no-meta miss
   * falls back to the SPACE instance — piece structure is shared (one
   * graph; instances are data slots, scopes.md §2), so a scoped demand
   * on a shared-structure piece must load through the broad slot
   * rather than churn forever on its meta-less instance doc. */
  async #attemptStructureLoad(
    runtime: Runtime,
    root: { id: string; scope?: string },
  ): Promise<EnsurePieceVerdict> {
    const scope = root.scope ?? "space";
    const verdict = await ensurePieceRunningVerdict(runtime, {
      space: this.#options.space,
      id: root.id as never,
      scope: scope as never,
      path: [],
    }, { propagateErrors: true });
    if (
      verdict.started || scope === "space" ||
      verdict.reason !== "no-pattern-meta"
    ) {
      return verdict;
    }
    const spaceVerdict = await ensurePieceRunningVerdict(runtime, {
      space: this.#options.space,
      id: root.id as never,
      scope: "space",
      path: [],
    }, { propagateErrors: true });
    // Merge observed docs: the re-arm must watch both instances' reads.
    for (const id of verdict.observedDocIds) {
      if (!spaceVerdict.observedDocIds.includes(id)) {
        spaceVerdict.observedDocIds.push(id);
      }
    }
    return spaceVerdict;
  }

  /** The terminal decision's sync-and-re-ask half (stage P2-F): a
   * no-meta verdict on an UN-synced doc is not evidence about durable
   * state, so pull every observed doc from the store (loopback,
   * co-hosted — cheap) and ask once more. Only a verdict that survives
   * this confirmation parks the root terminal. */
  async #confirmNoPatternMeta(
    runtime: Runtime,
    root: { id: string; scope?: string },
    verdict: EnsurePieceVerdict,
  ): Promise<EnsurePieceVerdict> {
    const scopes = new Set<string>(["space", root.scope ?? "space"]);
    for (const id of verdict.observedDocIds) {
      for (const scope of scopes) {
        try {
          await runtime.getCellFromLink({
            space: this.#options.space,
            id: id as never,
            scope: scope as never,
            path: [],
          }).sync();
        } catch {
          // A failed pull leaves the verdict unconfirmed; the caller's
          // deferred arm retries next cycle.
          return { ...verdict, reason: "confirm-pull-failed" };
        }
      }
    }
    return await this.#attemptStructureLoad(runtime, root);
  }

  /**
   * One wave (serving-loop.md §3): drain input, let the scheduler run
   * the affected graph to quiescence — or to the consequence-flush
   * deadline (the second exhaustion trigger, RULED 2026-08-04) — then
   * commit ONE derived transaction carrying the wave's writes, the
   * watermark doc write, and `derivedThrough`.
   */
  async #waveCycle(): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === undefined || !this.#active) return;
    const { batchHead } = this.#drainFeed();
    // The event drain stays a fully-awaited, single-flight step AHEAD
    // of the deadline race (Phase 3's shape): at most one drain runs
    // at a time, so a deadline-cut wave can never leave a detached
    // drain racing the next wave's drain into double-queuing an entry.
    // It no longer waits for the demanded-structure load (P2-F moved
    // that under the deadline race below): dispatch auto-loads a
    // handler's piece itself (ensurePieceRunning), and a genuinely
    // cold view defers on the input/backstop cadence — the
    // creation-race arm the deferral budget was sized for.
    const drainedEvents = await this.#drainStreamEvents(runtime);
    this.#retireAckedEffects(runtime);

    // Settle to quiescence under the flush deadline: idle() is the wave
    // boundary; synced() lets the loopback session's frames land so the
    // scheduler saw every input ≤ batchHead before we call the wave
    // quiescent (snapshot discipline: records arriving after the drain
    // belong to the NEXT wave).
    const deadlineMs = this.#options.policy?.flushDeadlineMs ??
      DEFAULT_FLUSH_DEADLINE_MS;
    const deadline = Date.now() + deadlineMs;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlinePromise = new Promise<"deadline">((resolve) => {
      deadlineTimer = setTimeout(
        () => resolve("deadline"),
        Math.max(0, deadline - Date.now()),
      );
    });
    // The demanded-structure load pass runs UNDER the wave's flush
    // deadline (stage P2-F, the OW19 design's throughput half): before
    // this it ran ahead of the settle race with no bound, so one slow
    // ensure (an unresponsive pattern load, a wedged doc pull)
    // throttled input consumption for every user of the space.
    // Single-flighted: a pass that outlives its wave's deadline keeps
    // running — the next cycle joins it instead of starting a rival
    // pass over the same roots — and its completion wakes the loop so
    // freshly loaded structure settles in a fresh cycle rather than
    // waiting out the idle window.
    const loadPass = this.#structureLoadPass ??= this.#loadDemandedStructure()
      .catch((error) => {
        logger.warn("structure-load-pass-failed", () => [
          "demand-structure load pass failed",
          error,
        ]);
      })
      .finally(() => {
        this.#structureLoadPass = undefined;
        this.#feedArrived?.resolve();
      });
    let exhausted = false;
    try {
      while (true) {
        // RACE the deadline (serving-loop.md §3's second exhaustion
        // trigger): "a wave still running at T_flush commits what is
        // sealed so far" — including a wave whose settle is stuck behind
        // work that will not quiesce (a hung load, an unquiescing
        // cascade). The deadline must be able to fire MID-await.
        const step = await Promise.race([
          (async () => {
            await loadPass;
            await runtime.idle();
            // Couple the settle to FRAME DELIVERY (W-soundness): the
            // feed learns of a commit synchronously at admission, but
            // the serving runtime's DIRTINESS arrives on the loopback
            // session's sync frames, which the server flushes on a
            // timer. Draining the co-hosted server's refresh queue here
            // guarantees every frame for commits ≤ batchHead has been
            // SENT before this pass can declare quiescence — without
            // it, a wave could advance W past an authored commit whose
            // demanded derivation never ran (the frame was still in
            // the flush queue).
            await this.#options.server.idle();
            // The INPUT barrier, not the durability barrier: sealed
            // commits settle at the wave commit BELOW, so the full
            // synced() would deadlock here (see
            // StorageManager.inputSynced).
            await runtime.storageManager.inputSynced?.();
            // One macrotask yield: loopback frames are delivered
            // synchronously on send, but their application schedules
            // work; the yield lets it register dirtiness so the
            // isIdle() probe below sees it. (An application parked
            // behind one of our own sealed commits is excluded from
            // the W advance below via unappliedForeignSeqFloor — the
            // settle input barrier, Phase 2 revisit (a).)
            await new Promise((resolve) => setTimeout(resolve, 0));
            return "settled" as const;
          })(),
          deadlinePromise,
        ]);
        if (step === "deadline") {
          exhausted = true;
          break;
        }
        if (runtime.scheduler.isIdle()) break;
        if (Date.now() >= deadline) {
          exhausted = true;
          break;
        }
      }
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    }

    // Promote settle-gated re-armed roots (stage P2-F): a TRUE settle
    // proved every frame ≤ batchHead applied — the re-arming commit's
    // included — so the retry now reads the post-commit state. An
    // exhausted flush proves nothing and keeps them gated. The latch
    // wakes the next input wait so a then-quiet space retries promptly
    // (the shadow-flip wake's shape).
    if (!exhausted && this.#rearmedAwaitingSettle.size > 0) {
      for (const key of this.#rearmedAwaitingSettle) {
        this.#pendingStructureLoads.add(key);
      }
      this.#rearmedAwaitingSettle.clear();
      this.#pendingStructureRetryWake = true;
      this.#feedArrived?.resolve();
    }

    const wave = this.#currentWave;
    const haveContributions = (wave?.contributionCount ?? 0) > 0;
    // Effect-only work (round-2 thread 1): deferred batches whose
    // transactions sealed NOTHING (all-no-op claim re-issues — the §6
    // step 3 recovery shape: activation re-runs a fetch whose claim is
    // already durable, the claim writes elide, only the effect
    // remains). They ride no contribution, so a quiet space would
    // never close the wave holding them — the batch starves, and the
    // eventual idle park drops it. Closing the wave for them commits
    // nothing (a zero-contribution commitWave is vacuous) and hands
    // the batches to the outbox below.
    const havePendingEffects = wave !== undefined &&
      (this.#pendingEffectsByWave.get(wave)?.length ?? 0) > 0;
    // W jumps to the top of the input batch at TRUE quiescence
    // (serving-loop.md §3): everything at or below batchHead has its
    // consequences committed and its demanded derivations current —
    // that is what the settle above established. An exhausted flush
    // carries no watermark movement. The advance is input-driven (the
    // batch head only moves when commits arrive), so a quiet space
    // commits nothing.
    //
    // The settle input barrier (Phase 2 revisit (a)): the settle above
    // proves frames were SENT and pulls settled — not that every
    // frame's novelty is VISIBLE. A foreign frame integrating under one
    // of the loop's own parked commits (CT-1927) stays shadowed until
    // the marker promotes it, and its dirtiness registers only then
    // (the replica's shadow-flip notification). Excluding those seqs
    // from the advance — the plan's sanctioned alternative to awaiting
    // them, which would deadlock — keeps W honest: it never claims a
    // seq whose demanded derivations could not have run. The clamp
    // lifts by itself: promotion fires the notification AND the
    // shadow-flip wake (`shadowFlipObserver`, installed at activation —
    // without it a then-quiet space would wait out the idle window),
    // the woken wave derives over the foreign value, and W catches up.
    const shadowFloor = runtime.storageManager
      .open(this.#options.space).replica.unappliedForeignSeqFloor?.();
    const inputVisibleHead = shadowFloor === undefined
      ? batchHead
      : Math.min(batchHead, shadowFloor - 1);
    const advanceTo = exhausted
      ? this.#watermark
      : Math.max(this.#watermark, inputVisibleHead);
    const shouldAdvance = !exhausted && advanceTo > this.#watermark;
    if (
      !exhausted && inputVisibleHead < batchHead &&
      batchHead > this.#watermark
    ) {
      // Counted whenever the floor held W below an OTHERWISE-ADVANCING
      // batch head (serving-loop.md §7's "actually clamped below the
      // input batch head"): the partial clamp (advanceTo strictly
      // between W and batchHead) AND the full suppression — the
      // shadowed seq is the lowest input above W, or the shadowed
      // REMOVE's sentinel floor 1 holds W entirely — where advanceTo
      // == W and the pre-fix `advanceTo > W` guard missed the count. A
      // floor with batchHead ≤ W is still NOT a clamp: no advance was
      // owed. An exhausted flush is likewise excluded — exhaustion
      // suppresses the advance regardless of the floor, and §7's
      // wavesBudgetExhausted carries that case.
      this.#options.stats.watermarkClamped += 1;
      logger.info?.("watermark-clamped", () => [
        `space ${this.#options.space}: W advance clamped to ` +
        `${advanceTo} (batchHead ${batchHead}, shadow floor ` +
        `${shadowFloor}) — foreign novelty parked behind an own ` +
        "sealed commit (settle input barrier)",
      ]);
    }

    if (!haveContributions && !shouldAdvance && !havePendingEffects) {
      // Nothing sealed and no watermark movement: no commit (the
      // zero-delta case — light cycles cost nothing). An EXHAUSTED
      // empty cycle is still counted: a wedged never-quiescing settle
      // is exactly what §7's wavesBudgetExhausted exists to surface.
      //
      // An EMPTY wave does not outlive its cycle (fan-out stage B; the
      // stage-A fix round's flagged residual vii(b), fixed here at the
      // root): an empty seal — a read probe, a no-op derivation, an
      // all-no-op claim re-issue — opens `#currentWave` at THAT
      // moment's serverSeq and lease tenure. Left open across
      // zero-delta cycles, the wave's basis went stale: the first
      // contributions to seal into it later — the boot wave's demanded
      // derivations, after the piece's own instantiation commits landed
      // — were dropped as SUPERSEDED at the per-doc CAS (their docs'
      // heads had advanced past the stale basis; a derivation drop
      // re-arms nothing, so nothing served until the next input), and
      // a stale tenure across a same-process lease reacquire aborted
      // the first real seal `lease-lost`. Discarded only when NOTHING
      // rides it: no contribution, no pending effect batch, and no seal
      // chained-but-not-yet-applied (a chained seal has already
      // captured this wave and must not be orphaned — the F4 counter is
      // exactly that window). The next seal opens a fresh wave at the
      // current serverSeq and tenure.
      if (
        wave !== undefined && this.#pendingWaveSeals === 0 &&
        this.#currentWave === wave
      ) {
        this.#currentWave = undefined;
      }
      if (exhausted) {
        this.#options.stats.wavesBudgetExhausted += 1;
        logger.debug?.("wave-budget-exhausted", () => [
          `space ${this.#options.space} exhausted the flush deadline on ` +
          `a zero-delta cycle: batchHead ${batchHead}, ` +
          `total ${this.#options.stats.wavesBudgetExhausted}`,
        ]);
      }
      // The owed re-drain rides quiet cycles too (round-2 thread 9): a
      // transport-failed delivery must retry on the NEXT loop cycle,
      // not wait for a new input wave or a re-activation.
      await this.#drainOutboxAppends(false);
      return;
    }

    // The loop's own bookkeeping write (the sanctioned internal stamp
    // kind): the watermark doc advances INSIDE the same wave commit —
    // never its own commit (protocol.md §4). An exhausted wave carries
    // no watermark movement (`derivedThrough` stays at the current W;
    // serving-loop.md §3). Written as a key-path SET (a patch against an
    // existing doc) so the bookkeeping conflict class's REBASE arm is
    // live: a disjoint concurrent patch to the watermark doc commutes,
    // while a whole-doc authored intrusion (forgery) still conflicts
    // semantically and drops the DOC write whole. Stated truthfully:
    // that drop is decided inside commitWave, AFTER `advanceSealed`
    // below already fed `derivedThrough` and armed the in-memory
    // advance — which keys off the WAVE commit succeeding
    // (`outcome.seq`), not off the doc write surviving — so the commit
    // metadata and this loop's `#watermark` still advance while the doc
    // lags, and on a quiet space no re-advance follows (the advance is
    // input-driven; the next one comes with the next input batch).
    // Accepted, not a gap to fix here: watermark forgery is an authored
    // intrusion inside protocol.md §1's threat model, and the failure
    // is conservative for clients — waitForSettled reads the DOC, so a
    // dropped doc write leaves them unsettled (never settled early),
    // until the next input-driven advance re-lands it.
    let advanceSealed = false;
    if (shouldAdvance) {
      const tx = runtime.edit();
      stampWaveRunContext(tx, {
        actionId: WATERMARK_ACTION_ID,
        kind: "bookkeeping",
      });
      // BLIND key-path write (RULED 2026-08-07): the cell route's
      // read-before-write synced the watermark doc over the loopback
      // SESSION plane under the service principal — DENIED on
      // owner-only-ACL spaces (a harmless but noisy AuthorizationError
      // per run). The loop's own bookkeeping write needs no
      // session-plane read: it stays a key-path write inside the wave
      // transaction (protocol.md §4's same-transaction invariant and
      // §3d's bookkeeping REBASE arm both keyed off the path shape,
      // unchanged), consistent with watermark.ts's engine-direct READ
      // posture — clients keep reading the doc through their ordinary
      // subscription.
      tx.writeValueOrThrow(
        {
          ...watermarkDocLink(this.#options.space),
          path: ["seq"],
        },
        advanceTo,
      );
      const committed = await tx.commit();
      if (committed.error) {
        // The advance did not enter the wave: W must not move either —
        // the doc and the metadata advance together or not at all
        // (protocol.md §4's same-transaction invariant).
        logger.warn("watermark-seal-failed", () => [
          "watermark bookkeeping write failed to seal; W held",
          committed.error,
        ]);
      } else {
        advanceSealed = true;
      }
    }

    // The consequence-notice seals (error/drop/skip arms) must land in
    // THIS wave: their marks are the events' consequences
    // (events.md §5), and the first flush carries them
    // (serving-loop.md §3's sealing order).
    if (this.#eventNoticeWork.size > 0) {
      await Promise.allSettled([...this.#eventNoticeWork]);
      this.#eventNoticeWork.clear();
    }

    const closing = this.#currentWave;
    if (closing === undefined) return;
    this.#currentWave = undefined;
    await this.#sealChain;

    // Phase 5 (protocol.md §2b): resolve the co-hosted engines for the
    // wave's foreign provisioning targets BEFORE the commit step — the
    // sink's engineFor is synchronous. Same host, same process.
    await this.#resolveForeignEngines(closing);

    const derivedThrough = !exhausted && advanceSealed
      ? advanceTo
      : this.#watermark;
    const outcome = await closing.commitWave(this.#sink!, { derivedThrough });
    await closing.settled();
    // The effect handoff (stage G, serving-loop.md §3): external effects
    // go to the outbox POST-commit. Taken off the map here either way;
    // the lease-lost branch below parks, so its batches are simply
    // dropped — the runtime dies with the wave (crash-equivalent, memo
    // re-miss covers the effect on re-activation).
    const pendingEffects = this.#pendingEffectsByWave.get(closing);
    this.#pendingEffectsByWave.delete(closing);

    const stats = this.#options.stats;
    stats.waves += 1;
    if (exhausted) {
      stats.wavesBudgetExhausted += 1;
      logger.debug?.("wave-budget-exhausted", () => [
        `space ${this.#options.space} exhausted the flush deadline: ` +
        `batchHead ${batchHead}, wave seq ${outcome.seq}, ` +
        `total ${stats.wavesBudgetExhausted}`,
      ]);
    }
    stats.supersededWrites += outcome.supersededWrites;
    // Phase 3: a REQUEUED event's consequence contribution was rolled
    // back whole — its entry stays unconsequenced and durable, so the
    // next wave's scan re-finds and re-runs it (serving-loop.md §3d's
    // requeue arm; C8b). The same re-arm covers any drained event whose
    // seal failed transiently: its entry, too, is still pending.
    if (
      (outcome.requeuedEventIds?.length ?? 0) > 0 ||
      ((drainedEvents > 0 || outcome.seq !== undefined) &&
        Engine.selectPendingStreamEventDocs(this.#options.engine).length > 0)
    ) {
      // Re-arm sources: a REQUEUED event (its entry stayed pending); a
      // drained event whose seal failed transiently; and a wave that
      // COMMITTED same-space emitted entries (LT1's budget-exhausted
      // fallback — the entry is durable input, the next wave processes
      // it).
      this.#eventScanOwed = true;
    }
    // Stage G, post-commit: hand the wave's sealed effects to the
    // outbox BEFORE anything below can throw (a failed commit-record
    // fetch must not leak effects with the runtime still alive) — but
    // ONLY when the wave did not ABORT (round-2 thread 3:
    // `outcome.aborted === undefined`, which is a committed wave OR a
    // vacuous zero-contribution one — the effect-only batches of
    // thread 1 ride the latter; their claim writes were no-ops against
    // already-durable state, so nothing was withdrawn). A REJECTED or
    // FOREIGN-FAILED wave discards its batches instead: its sealed
    // claim writes (pending/requestHash) were WITHDRAWN, so firing
    // would egress network work for claims that never became durable,
    // and the completion would write result cells whose pending state
    // rolled back — the input-driven retry (the re-run re-seals and
    // re-enqueues into a later wave) is the sanctioned path. The
    // lease-lost arm parks below and discards with the dying runtime
    // (crash-equivalent, memo re-miss covers). Within a COMMITTED
    // wave, per-contribution withdrawals keep the ruled at-least-once
    // posture: the withdrawn action re-runs and re-enqueues (deduped
    // in flight), and completion writes are hash-guarded against
    // current inputs (serving-loop.md §4).
    if (
      outcome.aborted === undefined &&
      pendingEffects !== undefined && pendingEffects.length > 0
    ) {
      this.#outbox?.admitSealedEffects(pendingEffects);
    }
    if (outcome.aborted === "lease-lost") {
      // PARK, never continue (W-soundness): the abort WITHDREW the
      // wave's sealed derivations, nothing re-arms their producers in
      // place (no revert consumer; the inputs did not change), and
      // #coverageHead has already claimed the input batch — a continued
      // loop (the renew-blip reacquire path, where lease.acquire()
      // succeeded and this runtime kept running) would mint a
      // watermark-only advance next cycle over demanded derivations
      // that never re-ran, making waitForSettled lie until the next
      // input change. Re-activation's fresh-runtime recompute-on-demand
      // is the ONLY post-abort recovery arm (serving-loop.md §6 step 2:
      // a demanded pull recomputes regardless).
      logger.warn("wave-aborted", () => [
        "wave aborted: lease lost mid-wave; parking " +
        "(serving-loop.md §2)",
      ]);
      await this.park("lease-lost-abort");
      return;
    }
    if (outcome.seq !== undefined) {
      stats.derivedCommits += 1;
      this.#options.onWaveCommitted?.();
      if (!exhausted && advanceSealed) {
        this.#watermark = advanceTo;
      }
      // The wave commit entered the store on the co-hosted engine plane,
      // not through any session: report it so push fires (M4 — derived
      // commits reach subscribers) and the feed carries it (the loop
      // skips its own echo by class + holder).
      const records = Engine.selectCommitsSince(this.#options.engine, {
        fromSeq: outcome.seq - 1,
        limit: 1,
      });
      const record = records.find((entry) => entry.seq === outcome.seq);
      if (record !== undefined) {
        this.#options.server.noteExecutorCommit({
          space: this.#options.space,
          seq: record.seq,
          class: "derived",
          holder: this.#holder,
          sessionId: record.sessionId,
          writes: record.writes as AdmittedCommitNotice["writes"],
        });
      }
    }

    // Drain the durable append rows (FP1): after a wave that landed
    // appends, and after any earlier drain left rows behind (a
    // transport-failed delivery on a long-lived active space must not
    // wait for the next appends-carrying wave or a re-activation —
    // quiet cycles re-drain too, see the early return above).
    // Co-hosted delivery is an engine commit, not a network await.
    await this.#drainOutboxAppends(
      closing.hasOutboundAppends && outcome.seq !== undefined,
    );
  }

  /** The FP1 drain step, shared by the post-commit path and the
   * quiet-cycle owed retry (round-2 thread 9): deliver pending durable
   * append rows when this wave landed new ones or an earlier drain
   * left rows behind; remember `remaining > 0` so the next cycle
   * retries without fresh input. */
  async #drainOutboxAppends(hasNewAppends: boolean): Promise<void> {
    if (!hasNewAppends && !this.#outboxDrainOwed) return;
    try {
      const drained = await this.#outbox?.deliverPendingAppends();
      this.#outboxDrainOwed = (drained?.remaining ?? 0) > 0;
    } catch (error) {
      this.#outboxDrainOwed = true;
      logger.warn("append-drain-failed", () => [
        "outbox drain failed; rows kept for re-send",
        error,
      ]);
    }
  }

  /** Dispose the serving runtime under a DEADLINE (park liveness — the
   * lunch-wall mechanism): a serving runtime killed mid-wave can hang
   * `runtime.dispose()` forever (its loopback loads died with the
   * crashed wave), and a park gated on that dispose never resolves
   * `#parked` — every recovery the host chains behind `whenParked`
   * (`#reactivateAfterPark`, fired on each subsequent admission) then
   * waits for eternity and the space is never served again, while
   * events keep appending durably. By the time dispose runs, the park's
   * semantic obligations are already met: the loop is stopped, the wave
   * abandoned, the seal chain drained — crash-equivalent teardown is
   * the sanctioned model for abandoned waves. So an overrunning dispose
   * is ABANDONED: logged loudly with the park bracket diagnostics,
   * counted (§7 `parkDisposeTimeouts`), its eventual completion or
   * failure logged when it lands; the park completes regardless (lease
   * released, `#parked` resolved, recovery unblocked). */
  async #disposeRuntimeTimeboxed(reason: string): Promise<void> {
    const dispose = this.#disposeRuntime;
    if (dispose === undefined) return;
    const timeoutMs = this.#options.policy?.parkDisposeTimeoutMs ??
      DEFAULT_PARK_DISPOSE_TIMEOUT_MS;
    const pending = dispose();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const winner = await Promise.race([
      pending.then(
        () => "disposed" as const,
        () => "failed" as const,
      ),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (winner === "failed") {
      // Re-await so the caller's catch logs the error (the existing
      // park-dispose-failed arm).
      return pending;
    }
    if (winner === "timeout") {
      this.#options.stats.parkDisposeTimeouts += 1;
      logger.error(
        "park-dispose-timeout",
        `space ${this.#options.space}: runtime dispose overran ` +
          `${timeoutMs}ms during park (${reason}); abandoning the ` +
          "factory handle and completing the park — loop stopped, " +
          "wave abandoned, seal chain drained; lease releases and " +
          "whenParked resolves now (park liveness)",
      );
      // The abandoned dispose keeps running; observe its eventual fate
      // so a late completion is visible and a late rejection never
      // becomes an unhandled rejection.
      pending.then(
        () => {
          logger.warn("park-dispose-late", () => [
            `space ${this.#options.space}: abandoned park dispose ` +
            "completed late",
          ]);
        },
        (error) => {
          logger.warn("park-dispose-late-failed", () => [
            `space ${this.#options.space}: abandoned park dispose ` +
            "failed late",
            error,
          ]);
        },
      );
    }
  }

  /** Park (serving-loop.md §1): release the lease, dispose the runtime.
   * A park racing an incoming commit self-heals — the admission hook
   * re-fires on the next admission and the host re-activates. */
  async park(reason: string): Promise<void> {
    if (!this.#active) return;
    this.#active = false;
    this.#parkRequested = true;
    this.#options.stats.activeSpaces = Math.max(
      0,
      this.#options.stats.activeSpaces - 1,
    );
    if (this.#renewTimer !== undefined) {
      clearInterval(this.#renewTimer);
      this.#renewTimer = undefined;
    }
    if (this.#deferredRescanTimer !== undefined) {
      clearTimeout(this.#deferredRescanTimer);
      this.#deferredRescanTimer = undefined;
    }
    this.#feedArrived?.resolve();
    for (const cancel of this.#demandSinks.values()) {
      try {
        cancel();
      } catch {
        // sink cancellation is best-effort during teardown
      }
    }
    this.#demandSinks.clear();
    this.#demandedRoots.clear();
    this.#demandersByKey.clear();
    this.#pieceRootByDemandKey.clear();
    if (this.#demandWakeTimer !== undefined) {
      clearTimeout(this.#demandWakeTimer);
      this.#demandWakeTimer = undefined;
    }
    this.#pendingDemandWake = false;
    this.#pendingStructureLoads.clear();
    this.#terminalStructureLoads.clear();
    this.#rearmedAwaitingSettle.clear();
    this.#pendingStructureRetryWake = false;
    // Phase 5: foreign engine resolutions die with the tenure (a
    // re-activation re-resolves; the map must not outlive engines the
    // server may close meanwhile).
    this.#foreignEngines.clear();
    const wave = this.#currentWave;
    this.#currentWave = undefined;
    await this.#sealChain;
    wave?.abandon(`parked: ${reason}`);
    // Stage G: an abandoned wave's deferred effects are DISCARDED with
    // it — the runtime below is disposed, so this is the
    // crash-equivalent path §4/§6 already cover (the effect re-misses
    // from memo keys on re-activation). In-flight effect work is not
    // awaited (park never awaits the network); its writebacks fail
    // against the disposed runtime and are caught by the builtins.
    this.#pendingEffectsByWave.clear();
    // Phase 6: wake budget-held dispatches into the closed check so
    // they DROP (the crash-equivalent path) instead of firing network
    // work for a dead runtime after re-activation rebuilt the outbox.
    this.#outbox?.close();
    this.#outbox = undefined;
    try {
      if (this.#runtime !== undefined) {
        this.#runtime.asyncWorkObserver = undefined;
        this.#runtime.effectMemoObserver = undefined;
        this.#runtime.connectedSessionProbe = undefined;
        this.#runtime.notifyServedIntentSealFailure = undefined;
        this.#runtime.pieceStartCommitFailureObserver = undefined;
        // The shadow-flip wake dies with the tenure (a late flip on a
        // disposing replica must not poke a parked loop's stale wait).
        this.#runtime.storageManager.open(this.#options.space).replica
          .shadowFlipObserver = undefined;
      }
      this.#runtime?.clearSealDestination();
      await this.#disposeRuntimeTimeboxed(reason);
    } catch (error) {
      logger.warn("park-dispose-failed", () => [
        "runtime dispose during park failed",
        error,
      ]);
    }
    this.#runtime = undefined;
    this.#disposeRuntime = undefined;
    this.#lease?.release();
    this.#lease = undefined;
    logger.info?.("parked", () => [
      `space ${this.#options.space} parked (${reason})`,
    ]);
    this.#options.onParked?.(reason);
    this.#parked.resolve();
  }
}
