import { getLogger } from "@commonfabric/utils/logger";
import type { Cancel } from "../cancel.ts";
import { getTopFrame } from "../builder/pattern.ts";
import { ConsoleEvent } from "../harness/console.ts";
import type {
  ConsoleHandler,
  ErrorHandler,
  ErrorWithContext,
  Runtime,
} from "../runtime.ts";
import {
  areNormalizedLinksSame,
  type NormalizedFullLink,
} from "../link-utils.ts";
import type {
  ChangeGroup,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IStorageSubscription,
  MemorySpace,
  StorageNotification,
} from "../storage/interface.ts";
import {
  allowMutableTransactionRead,
  ignoreReadForScheduling,
  isRendererInputTx,
  markReadAsAttemptedWrite,
} from "../storage/reactivity-log.ts";
import type {
  ActionStats,
  NonIdempotentReport,
  SchedulerDiagnosisResult,
  SchedulerGraphSnapshot,
} from "../telemetry.ts";
import {
  CONVERGENCE_IDLE_HOLD_MAX_BACKOFF_PASSES,
  INITIAL_RUN_SYNC_HOLD_TIMEOUT_MS,
  MAX_SETTLE_STATS_HISTORY,
} from "./constants.ts";
import {
  getPieceMetadataFromFrame,
  getSchedulerActionId,
  getSchedulerActionTelemetryInfo,
  handleSchedulerError,
  queueTask,
  recordTriggerTrace as recordTriggerTraceState,
  type SchedulerActionIdentityState,
} from "./diagnostics.ts";
import {
  type DiagnosisRecord,
  runSchedulerDiagnosis,
  runSchedulerIdempotencyCheck,
  type SchedulerDiagnosisControlState,
  startSchedulerDiagnosis,
  stopSchedulerDiagnosis,
} from "./diagnosis.ts";
import {
  type DependencyGraphState,
  isLive,
  notifyNodeLivenessChange,
  registerDependentsForWriterSurface,
  setNodeProvisionalDemand,
  updateDependentEdgesForLog,
} from "./dependency-graph.ts";
import { SchedulerMaterializers } from "./materializers.ts";
import {
  CELL_GROUP_PREFIX,
  type DeliverFn,
  holdShapedCell,
  holdShapedEvent,
  shaperInstanceGroupKey,
  shouldShapeDelivery,
  WakeShaper,
} from "./wake-shaping.ts";
import { type DependencyUpdateState } from "./dependency-updates.ts";
import { SchedulerWriteIndex } from "./scheduling-writes.ts";
import { NodeRegistry, type SchedulerNode } from "./node-record.ts";
import {
  SchedulerTriggerIndex,
  SchedulerTriggerSubscriptions,
  type TriggerSubscriptionState,
} from "./trigger-index.ts";
import {
  collectInvalidUpstreamForLog as collectInvalidUpstreamForLogState,
  collectPendingLoadParkKeys as collectPendingLoadParkKeysState,
  type EventPreflightDependencyState,
  snapshotEventPreflightTraceContext,
} from "./event-preflight-dependencies.ts";
import {
  runSchedulerAction,
  type SchedulerActionRunState,
  schedulerImplementationFingerprint,
  schedulerRuntimeFingerprint,
} from "./run.ts";
import {
  buildPullInitialSeeds,
  createSettlingTracker,
  markExecuteStart,
  markNonSettlingEpisode,
  pushBoundedHistory,
  recordExecuteEnd,
  type SchedulerSettleLoopState,
  type SchedulerSettleResult,
  type SettlingTracker,
} from "./execution.ts";
import { runPullSchedulerSettleLoop } from "./settle.ts";
import {
  isSchedulerActionObservation,
  type PersistedSchedulerObservationSnapshot,
  type SchedulerActionObservation,
} from "./persistent-observation.ts";
import { collectPullIterationSeeds as collectPullIterationSeedsState } from "./settle.ts";
import {
  type DirtyPullRunnableState,
  type DirtyPullRunnableStateWithDebounce,
  hasIdleBlockingDeferredPullWork as hasIdleBlockingDeferredPullWorkState,
  hasRunnablePullWork as hasRunnablePullWorkState,
  type PendingPullRunnableState,
  type PullSchedulingState,
} from "./work-oracle.ts";
import type { ExecuteContinuationState } from "./continuation.ts";
import { applyPullExecuteContinuation } from "./continuation.ts";
import { SchedulerGates } from "./gates.ts";
import {
  markInvalid as markInvalidRecord,
  type StorageNotificationState,
} from "./invalidation.ts";
import { processStorageNotification } from "./invalidation.ts";
import {
  type SchedulerSubscribeActionState,
  type SchedulerSubscriptionState,
  type SchedulerUnsubscribeActionState,
  unsubscribeSchedulerAction,
} from "./registration.ts";
import {
  resolveRegistrationSurface,
  resubscribePullSchedulerAction,
  subscribePullSchedulerAction,
} from "./registration.ts";
import {
  type ActionTimingState,
  getActionStats as getActionStatsFromState,
} from "./timing.ts";
import { getCommitLocalSeq } from "../storage/commit-identity.ts";
import {
  addSchedulerEventHandler,
  dropQueuedEvent,
  isHeadEventParked as isHeadEventParkedState,
  queueSchedulerEvent,
  type SchedulerEventExecutionState,
  type SchedulerEventQueueState,
} from "./events.ts";
import { SpeculationLineage } from "./lineage.ts";
import { processPullQueuedEventDuringExecute } from "./events.ts";
import {
  buildSchedulerGraphSnapshot,
  type SchedulerGraphSnapshotState,
} from "./graph-snapshot.ts";
import type {
  Action,
  ActionRunTraceEntry,
  EventHandler,
  EventHandlerRegistration,
  EventPreflightTraceContext,
  QueuedEvent,
  ReactivityLog,
  SchedulerObservationIdentity,
  SettleStats,
  SettleStatsHistoryEntry,
  TelemetryAnnotations,
  TriggerTraceEntry,
} from "./types.ts";
import { ensureNotRenderThread } from "@commonfabric/utils/env";
import { entityKey } from "./keys.ts";

ensureNotRenderThread();

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});

type FilterStatsState = { filtered: number; executed: number };

const schedulerContextRank = (contextKey: string): number =>
  contextKey === "space"
    ? 0
    : contextKey.startsWith("user:")
    ? 1
    : contextKey.startsWith("session:")
    ? 2
    : -1;

const schedulerAddressScopeRank = (address: IMemorySpaceAddress): number =>
  (address.scope ?? "space") === "session"
    ? 2
    : (address.scope ?? "space") === "user"
    ? 1
    : 0;

const schedulerEnvelopeCovers = (
  envelope: IMemorySpaceAddress,
  address: IMemorySpaceAddress,
): boolean =>
  envelope.space === address.space &&
  envelope.id === address.id &&
  (envelope.scope ?? "space") === (address.scope ?? "space") &&
  envelope.path.length <= address.path.length &&
  envelope.path.every((segment, index) => segment === address.path[index]);

const observationMinimumContextRank = (
  observation: SchedulerActionObservation,
): number => {
  const summary = observation.completeActionScopeSummary;
  if (!summary || !observation.implementationFingerprint.startsWith("impl:")) {
    return 2;
  }
  const pieceScope = summary.piece.scope ?? "space";
  if (
    summary.piece.space !== observation.ownerSpace ||
    `${pieceScope}:${summary.piece.id}` !== observation.pieceId
  ) {
    return 2;
  }
  let rank = pieceScope === "session" ? 2 : pieceScope === "user" ? 1 : 0;
  let crossesSpace = false;
  for (
    const address of [
      ...summary.reads,
      ...summary.writes,
      ...summary.materializerWriteEnvelopes,
      ...summary.directOutputs,
    ]
  ) {
    crossesSpace ||= address.space !== summary.piece.space;
    rank = Math.max(rank, schedulerAddressScopeRank(address));
  }
  if (crossesSpace && rank === 0) return 2;

  const runtimeGroups: Array<[
    readonly IMemorySpaceAddress[],
    readonly IMemorySpaceAddress[],
  ]> = [
    [
      [...observation.reads, ...observation.shallowReads],
      summary.reads,
    ],
    [
      [
        ...observation.actualChangedWrites,
        ...observation.currentKnownWrites,
        ...(observation.declaredWrites ?? []),
        ...(observation.ignoredSchedulingWrites ?? []),
      ],
      [
        ...summary.writes,
        ...summary.materializerWriteEnvelopes,
        ...summary.directOutputs,
      ],
    ],
    [
      observation.materializerWriteEnvelopes,
      summary.materializerWriteEnvelopes,
    ],
  ];
  for (const [observed, envelopes] of runtimeGroups) {
    for (const address of observed) {
      if (
        !envelopes.some((envelope) =>
          schedulerEnvelopeCovers(envelope, address)
        )
      ) {
        return 2;
      }
      rank = Math.max(rank, schedulerAddressScopeRank(address));
    }
  }
  return rank;
};

type SchedulerStorageRehydrationOptions =
  & SchedulerObservationIdentity
  & {
    space: MemorySpace;
    snapshotsByActionId?: ReadonlyMap<
      string,
      readonly PersistedSchedulerObservationSnapshot[]
    >;
    addressesCurrentAtOrBelow?: (
      addresses: readonly IMemorySpaceAddress[],
      seq: number,
    ) => boolean;
    hasPendingWriteOverlapping?: (
      addresses: readonly IMemorySpaceAddress[],
    ) => boolean;
  };

type SchedulerRegistrationInput = ReactivityLog;
type SchedulerRegisterOptions = {
  isEffect?: boolean;
  debounce?: number;
  noDebounce?: boolean;
  throttle?: number;
  changeGroup?: ChangeGroup;
  rehydrateFromStorage?: SchedulerStorageRehydrationOptions;
  // Hold the action's initial run until its space finishes syncing (bounded by
  // timeoutMs), so a resumed re-derivation reads confirmed-loaded inputs
  // instead of racing the data. Applies whenever the action did NOT rehydrate
  // from a snapshot: the flag-off resume path, and the flag-on degrade path
  // (snapshot miss/mismatch, or an "always-run" action). See runner.ts.
  awaitSyncBeforeInitialRun?: { space: MemorySpace; timeoutMs?: number };
  // Tag the action with its owning pattern instance without rehydrating from
  // storage. Pattern readers then always carry a pieceId, used to group shaped
  // cell-flip wakes by instance and to distinguish pattern readers from
  // internal machinery (plan B).
  observationIdentity?: SchedulerObservationIdentity & {
    space?: MemorySpace;
  };
  // "always-run": never rehydrate this action clean on resume — its run has
  // instantiation side effects (starting child runs) that a clean skip would
  // strand. See docs/specs/scheduler-v2/per-doc-rehydration.md §3.3.
  resumeMode?: "always-run";
};

function isReactivityLog(value: unknown): value is ReactivityLog {
  const candidate = value as Partial<ReactivityLog> | null;
  return candidate !== null &&
    typeof candidate === "object" &&
    Array.isArray(candidate.reads) &&
    Array.isArray(candidate.shallowReads) &&
    Array.isArray(candidate.writes);
}

function normalizeRegistrationArgs(
  dependenciesOrOptions?: SchedulerRegistrationInput | SchedulerRegisterOptions,
  options: SchedulerRegisterOptions = {},
): {
  dependencies?: SchedulerRegistrationInput;
  options: SchedulerRegisterOptions;
} {
  if (
    dependenciesOrOptions === undefined ||
    !isReactivityLog(dependenciesOrOptions)
  ) {
    return {
      options: dependenciesOrOptions ?? options,
    };
  }

  return {
    dependencies: dependenciesOrOptions,
    options,
  };
}

function observationIdentityKey(
  identity: {
    ownerSpace?: string;
    branch: string;
    pieceId: string;
    processGeneration: number;
    actionId: string;
  },
): string {
  return [
    identity.ownerSpace ?? "",
    identity.branch,
    identity.pieceId,
    String(identity.processGeneration),
    identity.actionId,
  ].join("\0");
}

function observationAdoptionAddresses(
  observation: SchedulerActionObservation,
): IMemorySpaceAddress[] {
  return [
    ...observation.reads,
    ...observation.shallowReads,
    ...observation.actualChangedWrites,
    ...(observation.currentKnownWrites ?? []),
  ];
}

// Re-export types that tests expect from scheduler
export type { ErrorWithContext };
export type {
  Action,
  ActionRunTraceAddress,
  ActionRunTraceEntry,
  AnnotatedAction,
  AnnotatedEventHandler,
  EventHandler,
  ReactivityLog,
  SettleIterationStats,
  SettleStats,
  SettleStatsHistoryEntry,
  SpaceScopeAndURI,
  SpaceScopeURIAndType,
  TelemetryAnnotations,
  TriggerTraceActionRecord,
  TriggerTraceEntry,
  TriggerTraceValueKind,
  TriggerTraceValueSummary,
} from "./types.ts";
export { txToReactivityLog } from "./reactivity.ts";
export { RetryWhenReady } from "./retry-when-ready.ts";

export {
  allowMutableTransactionRead,
  ignoreReadForScheduling,
  markReadAsAttemptedWrite,
};

export class Scheduler {
  private eventQueue: QueuedEvent[] = [];
  private eventHandlers: EventHandlerRegistration[] = [];
  private eventHandlerGeneration = 0;
  private eventSequence = 0;
  readonly lineage = new SpeculationLineage({
    dropQueuedEvent: (event, reason) => this.dropEvent(event, reason),
    queueExecution: () => this.queueExecution(),
    onError: (error) => logger.error("lineage", () => [error]),
  });

  private pending = new Set<Action>();
  private dependencies = new WeakMap<Action, ReactivityLog>();
  private cancels = new WeakMap<Action, Cancel>();
  private triggerIndex = new SchedulerTriggerIndex();
  private actionChangeGroups = new WeakMap<Action, ChangeGroup>();
  private retries = new WeakMap<Action, number>();
  private actionGenerations = new WeakMap<Action, number>();
  private actionReadinessAttempts = new WeakMap<Action, symbol>();

  // Effect/computation tracking for pull-based scheduling
  private nodes = new NodeRegistry();
  private dependents = new WeakMap<Action, Set<Action>>();
  private reverseDependencies = new WeakMap<Action, Set<Action>>();
  private passCounter = 0;
  private activePassId: number | undefined;
  private provisionalDemandThisPass = new Set<SchedulerNode>();

  // Debugger breakpoints: action IDs that should trigger `debugger` before execution
  private breakpoints = new Set<string>();

  // Compute time tracking for auto-debounce and diagnostics
  // Keyed by action ID (source location) to persist stats across action recreation
  private actionStats = new Map<string, ActionStats>();
  private actionTimingState: ActionTimingState = {
    actionStats: this.actionStats,
    getActionId: (action) => this.getActionId(action),
  };
  private actionIdentityState: SchedulerActionIdentityState = {
    anonymousActionIds: new WeakMap<Action | EventHandler, string>(),
    anonymousActionCounter: 0,
  };
  private eventPreflightTraceContext?: EventPreflightTraceContext;

  private rerunAfterCurrentExecute = false;

  // Non-settling heuristic (Phase 1): detects when the system is churning
  private settlingTracker: SettlingTracker = createSettlingTracker();
  private autoTriggerDiagnosis = false;

  // Idempotency diagnosis (Phase 2): captures read/write values per action run
  private diagnosisEnabled = false;
  private diagnosisTimeout: ReturnType<typeof setTimeout> | null = null;
  private diagnosisStartTime = 0;
  private diagnosisBusyTime = 0;
  private diagnosisResolve:
    | ((result: SchedulerDiagnosisResult) => void)
    | null = null;
  private diagnosisHistory = new Map<string, DiagnosisRecord[]>();
  private diagnosisNonIdempotent: NonIdempotentReport[] = [];

  // Inline idempotency check mode: when enabled, every computation re-run
  // in run() is followed by a second synchronous run for comparison.
  private idempotencyCheckMode = false;
  private idempotencyViolations: NonIdempotentReport[] = [];

  // Cycle detection (Phase 3): tracks causal edges between actions
  private causalEdges: {
    writer: string;
    cell: string;
    triggered: string;
    timestamp: number;
  }[] = [];
  private changeGroupToActionId = new Map<ChangeGroup, string>();
  private diagnosisControlState!: SchedulerDiagnosisControlState;

  // Debounce infrastructure for throttling slow actions
  private pendingQueueTaskTimer: ReturnType<typeof setTimeout> | null = null;
  private eventQueueState!: SchedulerEventQueueState;
  private eventExecutionState!: SchedulerEventExecutionState;
  private gates = new SchedulerGates({
    nodes: this.nodes,
    actionStats: this.actionStats,
    getActionId: (action) => this.getActionId(action),
    isDisposed: () => this.disposed,
    queueExecution: () => this.queueExecution(),
  });
  private writeIndex!: SchedulerWriteIndex;
  private materializers = new SchedulerMaterializers(this.nodes.effects);
  private eventPreflightDependencyState!: EventPreflightDependencyState;
  // Filter stats for diagnostics
  private filterStats: FilterStatsState = { filtered: 0, executed: 0 };

  // Settle stats for performance analysis (opt-in via enableSettleStats())
  private collectSettleStats = false;
  private lastSettleStats: SettleStats | null = null;
  private settleStatsHistory: SettleStatsHistoryEntry[] = [];
  private collectActionRunTrace = false;
  private actionRunTrace: ActionRunTraceEntry[] = [];
  private collectTriggerTrace = false;
  private triggerTrace: TriggerTraceEntry[] = [];
  private eventPreflightTelemetryEnabled = false;
  private eventPassDemandRefresh?: (demand: Set<Action>) => void;
  private storageNotificationState!: StorageNotificationState;
  // Full durable-identity index for incremental observation adoption
  // (docs/specs/scheduler-v2/incremental-observation-adoption.md): a remote
  // observation names its action by id; the nodes registry is a WeakMap, so
  // adoption keeps this registration-scoped map. Action ids are only unique
  // within a piece; owner space, branch and generation are part of the durable
  // identity and must participate in lookup as well.
  private actionsByObservationIdentity = new Map<string, Action>();

  // Actions registered with resumeMode "always-run" — the map/filter/flatMap
  // coordinators that must run their reconcile to (re)register per-element
  // children. Live adoption must exclude them for the SAME reason register()
  // excludes them on reload: adopting one clean skips the reconcile, so a
  // remotely-appended row's child action is never registered and that row's
  // reactivity is dead. Object-keyed (once a coordinator, always a
  // coordinator) and the only failure direction is refusing a safe adoption,
  // so a stale membership just runs the action locally — never incorrect.
  private alwaysRunActions = new WeakSet<Action>();

  // Parent-child action tracking for proper execution ordering
  // When a child action is created during parent execution, parent must run first
  private executingAction: Action | null = null;
  currentActionId?: string;
  private dependencyGraphState!: DependencyGraphState;
  private dependencyUpdateState!: DependencyUpdateState;
  private triggerSubscriptionState!: TriggerSubscriptionState;
  private pendingPullRunnableState!: PendingPullRunnableState;
  private dirtyPullRunnableState!: DirtyPullRunnableState;
  private dirtyPullRunnableStateWithDebounce!:
    DirtyPullRunnableStateWithDebounce;
  private pullSchedulingState!: PullSchedulingState;
  private subscriptionState!: SchedulerSubscriptionState;
  private subscribeActionState!: SchedulerSubscribeActionState;
  private unsubscribeState!: SchedulerUnsubscribeActionState;

  private idlePromises: (() => void)[] = [];
  private backgroundTasks = new Set<Promise<unknown>>();
  // The single wake-shaping choke point (plan C): holds renderer-originated
  // input events out of the event queue (W3) and shapable cell-flip wakes out
  // of the reactive-notification path (plan B), coarsening the cadence a
  // pattern can observe. Fed via queueEvent's shaping interception and
  // holdShapedCellNotification() from the invalidation.ts routing of renderer
  // $value writes and server pushes. See
  // docs/specs/sandboxing/TIMING_SIDE_CHANNELS.md.
  private wakeShaper = new WakeShaper();
  private pendingDurableEventReadiness = new Set<Promise<void>>();
  // Head event parked on in-flight document loads (CT-1795). Keyed by event
  // id; released by loadsSettled, which either re-queues execution on success
  // or drops the at-most-once event on an explicit load failure.
  private headEventLoadPark: {
    eventId: string;
    keys: readonly string[];
    generations: ReadonlyMap<string, number>;
  } | null = null;
  // Keys whose loads already settled while this event was head. Preflight
  // itself kicks fire-and-forget pulls (populateDependencies cold reads), so
  // an address can be freshly in flight on every pass; without this memo the
  // park re-arms per pass and the event never dispatches. Once a key settled
  // for this event its replica is warm — a refresh is an ordinary concurrent
  // update, not a provisional snapshot.
  private headEventLoadParkHistory: {
    eventId: string;
    generations: Map<string, number>;
  } | null = null;
  // Generations already pending before the current event preflight. Used to
  // distinguish a genuine concurrent refresh from a load kicked by preflight
  // itself (the latter must not re-arm the same event forever).
  private preflightPendingLoadGenerations = new Map<string, number>();
  // Depth of the initial-rehydration apply window (the rehydration barrier reads
  // this, NOT backgroundTasks — see createPullSchedulingState). Phase 7 made
  // resume a synchronous snapshot apply at registration, so this is >0 only
  // inside applyPreloadedInitialActionRehydration; backgroundTasks now holds
  // only event-driven piece-start tasks, which must not pause pull scheduling.
  private initialRehydrationInFlight = 0;
  private errorHandlers = new Set<ErrorHandler>();
  private consoleHandler: ConsoleHandler;
  private _running: Promise<unknown> | undefined = undefined;
  private scheduled = false;
  private disposed = false;
  private actionRunState!: SchedulerActionRunState;
  private graphSnapshotState!: SchedulerGraphSnapshotState;
  private settleLoopState!: SchedulerSettleLoopState;
  private executeContinuationState!: ExecuteContinuationState;

  // ============================================================
  // Public API
  // ============================================================

  constructor(
    readonly runtime: Runtime,
    consoleHandler?: ConsoleHandler,
    errorHandlers?: ErrorHandler[],
  ) {
    this.initializeSchedulerState();

    this.consoleHandler = consoleHandler ||
      function (data) {
        // Default console handler returns arguments unaffected.
        return data.args;
      };

    if (errorHandlers) {
      errorHandlers.forEach((handler) => this.errorHandlers.add(handler));
    }

    // Subscribe to storage notifications
    this.runtime.storageManager.subscribe(
      this.createStorageSubscription(),
    );

    // Set up harness event listeners
    this.runtime.harness.addEventListener("console", (e: Event) => {
      // Called synchronously when `console` methods are
      // called within the runtime.
      const { method, args } = e as ConsoleEvent;
      const metadata = getPieceMetadataFromFrame();
      const result = this.consoleHandler({ metadata, method, args });
      console[method].apply(console, result);
    });
  }

  get runningPromise(): Promise<unknown> | undefined {
    return this._running;
  }

  set runningPromise(promise: Promise<unknown> | undefined) {
    if (this._running !== undefined) {
      throw new Error(
        "Cannot set running while another promise is in progress",
      );
    }
    if (promise !== undefined) {
      this._running = promise.finally(() => {
        this._running = undefined;
      });
    }
  }

  /**
   * Temporarily set the executing action so that any child actions created
   * during `fn` are registered as children of `action`. Restores the previous
   * executing action afterwards (stack-like nesting).
   */
  withExecutingAction<T>(action: Action, fn: () => T): T {
    const prev = this.executingAction;
    this.executingAction = action;
    try {
      return fn();
    } finally {
      this.executingAction = prev;
    }
  }

  /**
   * Subscribes an action to run when its dependencies change.
   *
   * The action will be scheduled to run immediately. After running, the
   * scheduler automatically re-subscribes using the reactivity log from the
   * run.
   *
   * @param action The action to subscribe
   * @param dependencies Optional callback or immediate ReactivityLog for
   *   backwards compatibility
   * @param options Configuration options for the subscription
   * @returns A cancel function to unsubscribe
   */
  register(
    action: Action,
    dependenciesOrOptions?:
      | SchedulerRegistrationInput
      | SchedulerRegisterOptions,
    maybeOptions: SchedulerRegisterOptions = {},
  ): Cancel {
    const generation = this.advanceActionGeneration(action);
    const { dependencies, options } = normalizeRegistrationArgs(
      dependenciesOrOptions,
      maybeOptions,
    );
    const { rehydrateFromStorage } = options;
    const previousObservationIdentityKey = this
      .observationIdentityKeyForAction(action);
    // Tag the action with its owning pattern instance. rehydrateFromStorage
    // carries this only under persistent scheduler state; observationIdentity
    // is set unconditionally so pattern readers always carry a pieceId (used to
    // group shaped cell-flip wakes by instance and to distinguish pattern
    // readers from internal machinery — plan B).
    if (rehydrateFromStorage) {
      this.setActionObservationIdentity(action, rehydrateFromStorage);
    } else if (options.observationIdentity) {
      this.setActionObservationIdentity(action, options.observationIdentity);
    }
    const observationIdentityKey = this.observationIdentityKeyForAction(action);
    if (
      previousObservationIdentityKey !== undefined &&
      previousObservationIdentityKey !== observationIdentityKey &&
      this.actionsByObservationIdentity.get(previousObservationIdentityKey) ===
        action
    ) {
      this.actionsByObservationIdentity.delete(previousObservationIdentityKey);
    }
    if (observationIdentityKey !== undefined) {
      this.actionsByObservationIdentity.set(observationIdentityKey, action);
    }
    if (options.resumeMode === "always-run") {
      this.alwaysRunActions.add(action);
    }
    const subscribeOptions = {
      isEffect: options.isEffect,
      debounce: options.debounce,
      noDebounce: options.noDebounce,
      throttle: options.throttle,
      changeGroup: options.changeGroup,
    };
    this.updateMaterializerRegistration(action);
    const cancel = subscribePullSchedulerAction(
      this.subscribeActionState,
      action,
      dependencies,
      subscribeOptions,
    );
    // Rehydration and the synced-hold are independent: apply the snapshot when
    // one is preloaded for this action (unless the action declares it must
    // always run on resume), and hold the initial run of any action that did
    // NOT rehydrate. A snapshot miss thus degrades to the same synced-hold
    // fresh run the flag-off path gets, instead of racing the data.
    let rehydrated = false;
    const snapshotsByActionId = rehydrateFromStorage?.snapshotsByActionId;
    if (
      rehydrateFromStorage &&
      snapshotsByActionId &&
      options.resumeMode !== "always-run"
    ) {
      rehydrated = this.applyPreloadedInitialActionRehydration(
        action,
        { ...rehydrateFromStorage, snapshotsByActionId },
      );
    }
    if (!rehydrated && options.awaitSyncBeforeInitialRun) {
      this.holdInitialRunUntilSynced(action, options.awaitSyncBeforeInitialRun);
    }
    return () => {
      if (this.isActionGenerationCurrent(action, generation)) {
        cancel();
      }
    };
  }

  // Hold a resumed action's initial run until its space finishes syncing. The
  // hold is a bounded time gate (worst case the timeout releases it); the sync
  // completing releases it early. The awaiting task joins backgroundTasks so
  // idle() waits for the release decision.
  private holdInitialRunUntilSynced(
    action: Action,
    options: { space: MemorySpace; timeoutMs?: number },
  ): void {
    const timeoutMs = Math.max(
      0,
      options.timeoutMs ?? INITIAL_RUN_SYNC_HOLD_TIMEOUT_MS,
    );
    this.gates.holdInitialRun(action, performance.now() + timeoutMs);
    const task = (async () => {
      const provider = this.runtime.storageManager.open(options.space);
      const synced = provider?.synced?.bind(provider);
      if (!synced) return;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timeoutId = setTimeout(resolve, timeoutMs);
      });
      const syncedPromise = synced();
      // If the timeout wins the race the sync promise is left pending; swallow
      // a later rejection so it doesn't surface as unhandled.
      syncedPromise.catch(() => {});
      try {
        await Promise.race([syncedPromise, timeout]);
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    })().catch((error) => {
      logger.warn("scheduler-initial-sync-hold", () => [
        "Failed to await sync before initial run; releasing the hold",
        this.getActionId(action),
        error,
      ]);
    }).finally(() => {
      // Release even on error/timeout: the gate exists to sequence the common
      // case, not to block the action forever behind a stuck sync.
      if (this.nodes.get(action)) {
        this.gates.releaseInitialRunHold(action);
      }
    });
    this.backgroundTasks.add(task);
    task.finally(() => {
      this.backgroundTasks.delete(task);
    });
  }

  /**
   * @deprecated Use register(). Kept while runner internals and tests still
   * exercise the v1 scheduler surface.
   */
  subscribe(
    action: Action,
    dependenciesOrOptions?:
      | SchedulerRegistrationInput
      | SchedulerRegisterOptions,
    maybeOptions: SchedulerRegisterOptions = {},
  ): Cancel {
    return this.register(action, dependenciesOrOptions, maybeOptions);
  }

  /**
   * Re-subscribes an action after it has already run, using the reactivity log
   * from the completed run. This sets up triggers for future changes without
   * scheduling the action to run immediately.
   *
   * Use this method when:
   * - An action has just completed running and you have its reactivity log
   * - You want to register triggers for future changes
   *
   * @param action The action to re-subscribe
   * @param log The reactivity log from the action's previous run
   * @param options Optional configuration (e.g., isEffect to mark as side-effectful)
   */
  resubscribe(
    action: Action,
    log: ReactivityLog,
    options: {
      isEffect?: boolean;
      changeGroup?: ChangeGroup;
    } = {},
  ): void {
    const record = this.nodes.get(action);
    const wasLiveBeforeRootRegistration = record !== undefined &&
      isLive(this.dependencyGraphState, record);
    this.updateMaterializerRegistration(action);
    resubscribePullSchedulerAction(
      this.subscribeActionState,
      action,
      log,
      options,
      { wasLiveBeforeRootRegistration },
    );
  }

  rehydrateActionFromObservation(
    action: Action,
    snapshot: PersistedSchedulerObservationSnapshot,
  ): boolean {
    const actionId = this.getActionId(action);
    const { observation } = snapshot;
    if (observation.actionId !== actionId) {
      return false;
    }

    // Annotation first; otherwise restore the persisted live surface —
    // mirroring registration, where subscribe's ReactivityLog supplies the
    // surface for annotation-less actions.
    const surface = resolveRegistrationSurface(action, {
      reads: [],
      shallowReads: [],
      writes: observation.currentKnownWrites ?? [],
    });
    if (observation.actionKind !== "effect" && surface.length > 0) {
      this.writeIndex.setSurface(action, surface);
      registerDependentsForWriterSurface(
        this.dependencyGraphState,
        action,
        surface,
      );
    }

    this.resubscribe(action, {
      reads: observation.reads,
      shallowReads: observation.shallowReads,
      writes: [],
    }, {
      isEffect: observation.actionKind === "effect",
    });
    if (observation.materializerWriteEnvelopes.length > 0) {
      this.materializers.registerAddresses(
        action,
        observation.materializerWriteEnvelopes,
      );
    }

    const { actionOptions } = observation;
    if (actionOptions?.debounceMs !== undefined) {
      this.gates.setDebounce(action, actionOptions.debounceMs);
    }
    if (actionOptions?.noDebounce !== undefined) {
      this.gates.setNoDebounce(action, actionOptions.noDebounce);
    }
    if (actionOptions?.throttleMs !== undefined) {
      this.gates.setThrottle(action, actionOptions.throttleMs);
    }

    if (
      observation.status === "failed" ||
      snapshot.directDirtySeq !== undefined ||
      snapshot.staleSeq !== undefined ||
      snapshot.unknownReason !== undefined
    ) {
      this.markAndScheduleInvalidAction(action);
      return true;
    }

    const record = this.nodes.get(action);
    if (record) {
      this.nodes.setStatus(action, "clean");
      record.invalidCauses = [];
    }
    this.pending.delete(action);
    return true;
  }

  // Returns whether the action actually rehydrated from its snapshot; a miss
  // (no snapshot for this actionId, fingerprint mismatch, malformed payload)
  // leaves the action on the normal initial-run path.
  private selectSchedulerSnapshotCandidate(
    action: Action,
    candidates: readonly PersistedSchedulerObservationSnapshot[],
  ): PersistedSchedulerObservationSnapshot | undefined {
    let selected: PersistedSchedulerObservationSnapshot | undefined;
    let selectedRank = -1;
    for (const candidate of candidates) {
      const observation = candidate.observation;
      if (
        !isSchedulerActionObservation(observation) ||
        !this.observationMatchesCurrentAction(action, observation)
      ) {
        continue;
      }
      const contextRank = schedulerContextRank(
        candidate.executionContextKey,
      );
      if (
        contextRank < observationMinimumContextRank(observation) ||
        contextRank <= selectedRank
      ) {
        continue;
      }
      selected = candidate;
      selectedRank = contextRank;
    }
    return selected;
  }

  private applyPreloadedInitialActionRehydration(
    action: Action,
    rehydration: SchedulerStorageRehydrationOptions & {
      snapshotsByActionId: ReadonlyMap<
        string,
        readonly PersistedSchedulerObservationSnapshot[]
      >;
    },
  ): boolean {
    // Engage the rehydration barrier for the duration of the apply: if
    // rehydrateActionFromObservation triggers a synchronous settle, no pull
    // seed may promote this resuming action before its status is restored.
    this.initialRehydrationInFlight++;
    try {
      const candidates = rehydration.snapshotsByActionId.get(
        this.getActionId(action),
      ) ?? [];
      const snapshot = this.selectSchedulerSnapshotCandidate(
        action,
        candidates,
      );
      if (!snapshot) {
        logger.debug("rehydrate/fallback-run/no-match", () => []);
        return false;
      }
      const addresses = observationAdoptionAddresses(snapshot.observation);
      if (
        rehydration.addressesCurrentAtOrBelow?.(
            addresses,
            snapshot.observation.observedAtSeq,
          ) === true &&
        rehydration.hasPendingWriteOverlapping?.(addresses) !== true &&
        this.rehydrateActionFromObservation(action, snapshot)
      ) {
        logger.debug("rehydrate/ok", () => []);
        return true;
      }

      logger.debug("rehydrate/fallback-run/no-match", () => []);
      return false;
    } finally {
      this.initialRehydrationInFlight--;
    }
  }

  // Incremental observation adoption
  // (docs/specs/scheduler-v2/incremental-observation-adoption.md): apply
  // another client's committed action observations to the local equivalent
  // actions instead of re-running them. Called by the storage layer after a
  // subscription push's writes have been applied (and their readers marked
  // dirty), before the next scheduling pass dispatches — adoption clears
  // exactly the dirt those writes caused for actions the writer already ran.
  //
  // The caller supplies the storage-side checks: `readsCurrentAtSeq` (no doc
  // in the read set has a local commit newer than the observation — else the
  // action is genuinely stale relative to state the writer did not observe)
  // and `hasPendingLocalWriteOverlapping` (a local uncommitted write makes
  // the local view diverge from the writer's basis — run normally).
  //
  // An adoption that races a mid-flight local run is harmless: the run's
  // completion resubscribes from its own log and re-sets clean, an
  // equivalent view (deterministic action over the same committed reads).
  // Returns the number of actions adopted.
  adoptRemoteObservations(
    snapshots: readonly PersistedSchedulerObservationSnapshot[],
    oracle: {
      readsCurrentAtSeq(
        reads: readonly IMemorySpaceAddress[],
        seq: number,
      ): boolean;
      hasPendingLocalWriteOverlapping(
        reads: readonly IMemorySpaceAddress[],
      ): boolean;
    },
  ): number {
    const candidatesByAction = new Map<
      Action,
      PersistedSchedulerObservationSnapshot[]
    >();
    for (const snapshot of snapshots) {
      const observation = snapshot.observation;
      if (!isSchedulerActionObservation(observation)) continue;
      // Computations only: effects render locally, and event handlers only
      // run at their origin.
      if (observation.actionKind !== "computation") continue;
      const action = this.actionsByObservationIdentity.get(
        observationIdentityKey(observation),
      );
      if (!action) continue;
      // Only live registrations adopt (the id index may hold entries whose
      // node was removed through a path that bypassed unsubscribe()).
      if (!this.nodes.get(action)) continue;
      if (this.nodes.isKnownEffect(action)) continue;
      // Never adopt a child-starting coordinator clean: its reconcile is what
      // (re)registers per-element children, so skipping it strands a remotely
      // appended row unregistered — the reload path's always-run guard, live.
      if (this.alwaysRunActions.has(action)) {
        logger.debug("adopt/miss/always-run", () => [observation.actionId]);
        continue;
      }
      let candidates = candidatesByAction.get(action);
      if (!candidates) {
        candidates = [];
        candidatesByAction.set(action, candidates);
      }
      candidates.push(snapshot);
    }

    let adopted = 0;
    for (const [action, candidates] of candidatesByAction) {
      const snapshot = this.selectSchedulerSnapshotCandidate(
        action,
        candidates,
      );
      if (!snapshot) {
        continue;
      }
      const observation = snapshot.observation;
      // A dirty/failed narrower row wins candidate selection and forces the
      // receiver to run normally; never fall back to a clean broader row.
      if (
        observation.status !== "success" ||
        snapshot.directDirtySeq !== undefined ||
        snapshot.staleSeq !== undefined ||
        snapshot.unknownReason !== undefined
      ) {
        continue;
      }
      const addresses = observationAdoptionAddresses(observation);
      if (!oracle.readsCurrentAtSeq(addresses, observation.observedAtSeq)) {
        logger.debug("adopt/miss/stale-reads", () => [observation.actionId]);
        continue;
      }
      if (oracle.hasPendingLocalWriteOverlapping(addresses)) {
        logger.debug("adopt/miss/local-pending", () => [observation.actionId]);
        continue;
      }
      // Same barrier as registration-time rehydration: no pull seed may
      // promote the action while its status is being restored.
      this.initialRehydrationInFlight++;
      try {
        if (this.rehydrateActionFromObservation(action, snapshot)) {
          adopted++;
          logger.debug("adopt/ok", () => [observation.actionId]);
        }
      } finally {
        this.initialRehydrationInFlight--;
      }
    }
    return adopted;
  }

  private observationMatchesCurrentAction(
    action: Action,
    observation: SchedulerActionObservation,
  ): boolean {
    const actionId = this.getActionId(action);
    if (observation.actionId !== actionId) {
      logger.debug("rehydrate/miss/action-id", () => []);
      return false;
    }

    const identity = (action as Partial<TelemetryAnnotations>)
      .schedulerObservationIdentity;
    if (
      identity === undefined ||
      identity.ownerSpace !== observation.ownerSpace ||
      (identity.branch ?? "") !== observation.branch ||
      identity.pieceId !== observation.pieceId ||
      (identity.processGeneration ?? 0) !== observation.processGeneration
    ) {
      logger.debug("rehydrate/miss/identity", () => []);
      return false;
    }

    const telemetry = getSchedulerActionTelemetryInfo(action);
    const matches = observation.implementationFingerprint ===
        schedulerImplementationFingerprint(action, actionId, telemetry) &&
      observation.runtimeFingerprint === schedulerRuntimeFingerprint();
    if (!matches) logger.debug("rehydrate/miss/fingerprint", () => []);
    return matches;
  }

  private setActionObservationIdentity(
    action: Action,
    identity: SchedulerObservationIdentity & { space?: MemorySpace },
  ): void {
    (action as Partial<TelemetryAnnotations>).schedulerObservationIdentity = {
      ownerSpace: identity.ownerSpace ?? identity.space,
      pieceId: identity.pieceId,
      ...(identity.branch !== undefined ? { branch: identity.branch } : {}),
      ...(identity.processGeneration !== undefined
        ? { processGeneration: identity.processGeneration }
        : {}),
    };
  }

  private observationIdentityKeyForAction(action: Action): string | undefined {
    const identity = (action as Partial<TelemetryAnnotations>)
      .schedulerObservationIdentity;
    if (identity === undefined || identity.ownerSpace === undefined) {
      return undefined;
    }
    return observationIdentityKey({
      ownerSpace: identity.ownerSpace,
      branch: identity.branch ?? "",
      pieceId: identity.pieceId,
      processGeneration: identity.processGeneration ?? 0,
      actionId: this.getActionId(action),
    });
  }

  unsubscribe(
    action: Action,
    options: { preserveChangeGroup?: boolean } = {},
  ): void {
    this.advanceActionGeneration(action);
    unsubscribeSchedulerAction(this.unsubscribeState, action, options);
    this.materializers.clearAction(action);
    // Drop the adoption index entry only if it still points at this action
    // (a re-registration may have overwritten it). Cancel paths that bypass
    // this method leave stale entries; the adoption path re-checks node
    // liveness before applying, so stale entries are inert.
    const identityKey = this.observationIdentityKeyForAction(action);
    if (
      identityKey !== undefined &&
      this.actionsByObservationIdentity.get(identityKey) === action
    ) {
      this.actionsByObservationIdentity.delete(identityKey);
    }
  }

  private advanceActionGeneration(action: Action): number {
    const generation = (this.actionGenerations.get(action) ?? 0) + 1;
    this.actionGenerations.set(action, generation);
    this.retries.delete(action);
    return generation;
  }

  private getActionGeneration(action: Action): number {
    return this.actionGenerations.get(action) ?? 0;
  }

  private beginActionReadinessAttempt(action: Action): symbol {
    const attempt = Symbol("scheduler-action-readiness-attempt");
    this.actionReadinessAttempts.set(action, attempt);
    return attempt;
  }

  private isActionGenerationCurrent(
    action: Action,
    generation: number,
  ): boolean {
    return this.getActionGeneration(action) === generation;
  }

  private isActionReadinessAttemptCurrent(
    action: Action,
    generation: number,
    attempt: symbol,
  ): boolean {
    return this.isActionGenerationCurrent(action, generation) &&
      this.actionReadinessAttempts.get(action) === attempt;
  }

  async run(action: Action): Promise<any> {
    return await runSchedulerAction(this.actionRunState, action);
  }

  idle(): Promise<void> {
    return this.waitForQuiescence(false);
  }

  // Client-facing quiescence: reactive quiescence AND durability of in-flight
  // commits. Commits are issued fire-and-forget (event handlers, direct cell
  // writes over IPC, reactive recomputation write-backs), so plain idle()
  // reports quiescence while a commit is still travelling to the server; a
  // client that reads idle as a safe point to navigate or reload would then
  // drop that write when the page and its worker are torn down. The pending
  // set is sourced from the storage manager — the single chokepoint every
  // commit flows through — so no write path can be forgotten. A landed commit
  // also dirties readers of the committed write, which can re-trigger
  // scheduler work that produces further commits, so durability and reactive
  // quiescence are one joint fixpoint; this reuses the same recursive
  // convergence idle() uses (no separate retry loop, no round cap) and, like
  // idle(), never resolves for a system that genuinely never settles.
  idleWithPendingCommits(): Promise<void> {
    return this.waitForQuiescence(true);
  }

  private waitForQuiescence(awaitPendingCommits: boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      // Re-evaluate every condition from scratch once the thing we are waiting
      // on settles.
      const recheck = () =>
        this.waitForQuiescence(awaitPendingCommits).then(resolve);
      // A parked waiter (idlePromises) resolves when the scheduler drains, but
      // a commit can still be in flight then, so the commit-aware variant
      // re-checks instead of resolving. The re-check is deferred to a microtask
      // so it does not re-enter waitForQuiescence synchronously while
      // resolveIdlePromises is iterating idlePromises.
      const park = awaitPendingCommits
        ? () => queueMicrotask(recheck)
        : resolve;
      if (this.runningPromise) {
        // Something is currently running - wait for it then check again
        this.runningPromise.then(recheck);
      } else if (this.backgroundTasks.size > 0) {
        // Async scheduler work, such as event-triggered auto-start, is still in
        // flight. Wait for it to settle and then re-check the scheduler state.
        Promise.allSettled([...this.backgroundTasks]).then(recheck);
      } else if (this.wakeShaper.hasPending()) {
        // Input events (W3) or cell-flip notifications (plan B) are being held
        // for wake shaping. Wait for them to release (which re-queues the
        // events and delivers the notifications) and then re-check. Draining
        // before the pending-commit branch means idleWithPendingCommits()
        // releases the held wakes first, then awaits the commits they produce.
        this.wakeShaper.whenDrained().then(recheck);
      } else if (
        awaitPendingCommits && this.runtime.storageManager.hasPendingCommits()
      ) {
        // In-flight commits. Wait for them to settle (server confirmation or
        // terminal failure) and then re-check: a landed commit can dirty
        // readers and re-trigger scheduler work.
        this.runtime.storageManager.pendingCommitsSettled().then(recheck);
      } else if (
        awaitPendingCommits && this.pendingDurableEventReadiness.size > 0
      ) {
        // A user event whose handler is waiting for cold factory code is still
        // an unprocessed durable intent. Plain idle stays available to
        // unrelated work, but the client-facing safe-reload barrier must wait
        // until that intent is requeued, canceled, or rejected.
        Promise.allSettled([...this.pendingDurableEventReadiness]).then(
          recheck,
        );
      } else if (
        this.gates.hasWakeTimer() &&
        ((this.eventQueue.length > 0 &&
          isHeadEventParkedState({ eventQueue: this.eventQueue })) ||
          this.hasIdleBlockingDeferredPullWork())
      ) {
        // A queued event or idle-blocking pull node is parked behind a time
        // gate. Wait for the wake timer to re-schedule the queue and re-check.
        this.idlePromises.push(park);
      } else if (
        this.hasPendingLineageHeadEvent() || this.hasLoadParkedHeadEvent()
      ) {
        // A cross-space lineage head has no timer — its origin commit callback
        // is the wake source; a load-parked head wakes on load completion or
        // drops on an explicit load failure. Either way idle must stay open
        // until the callback re-queues execution.
        this.idlePromises.push(park);
      } else if (!this.scheduled) {
        if (this.hasRunnablePullWork()) {
          this.queueExecution();
          this.idlePromises.push(park);
          return;
        }
        // Nothing is scheduled to run - we're idle.
        // In pull mode, pending computations won't run without an effect to pull them,
        // so we don't wait for them.
        this.resetConvergenceHoldPasses();
        resolve();
      } else {
        // Execution is scheduled - wait for it to complete
        this.idlePromises.push(park);
      }
    });
  }

  queueExecution(): void {
    if (this.disposed) return;
    if (this.scheduled) {
      if (this.pendingQueueTaskTimer === null) {
        this.rerunAfterCurrentExecute = true;
      }
      return;
    }
    this.pendingQueueTaskTimer = queueTask(() => {
      this.pendingQueueTaskTimer = null;
      this.execute();
    });
    this.scheduled = true;
  }

  queueEvent(
    eventLink: NormalizedFullLink,
    event: any,
    // Whether a transient commit failure converges via the backoff window (and
    // the inSpace-name resolution path re-runs the handler). `false` opts out:
    // the event drops on the first failure without retrying. Defaults to `true`
    // so every real user event through `cell.send` gets backpressure.
    retries: boolean = true,
    // Internal-only commit callback. This runs after the final commit result,
    // including a dropped failure, so it must not perform external side
    // effects. Use the post-commit outbox for success-only effect release.
    onCommit?: (tx: IExtendedStorageTransaction) => void,
    doNotLoadPieceIfNotRunning: boolean = false,
    opts: {
      eventId?: string;
      originTx?: IExtendedStorageTransaction;
      time?: number;
    } = {},
  ): void {
    // Bind the event's wall-clock time at its causal origin. A pre-supplied time
    // (a shaper release re-queueing a held event, a piece-load re-queue) is kept
    // as-is so the instant is captured once at the original send. A send from
    // INSIDE a handler carries that handler's frozen instant forward, so a whole
    // cascade from one gesture shares one time — the handler frame always has an
    // instant (createPatternFrame sets it), so this branch never falls through
    // to the clock. Only a root/renderer send, outside any handler frame, reads
    // the wall clock here to birth a fresh instant. This raw value is never
    // exposed to a pattern un-coarsened: the dispatching handler reads it only
    // through sandboxDateNow, which floors it to one second.
    const frame = getTopFrame();
    const time = opts.time ??
      (frame?.inHandler === true ? frame.eventTime : undefined) ??
      Date.now();
    // Coarsen the delivery cadence of user-input events (W3). The piece-loading
    // re-queue (doNotLoadPieceIfNotRunning) is an internal retry, not fresh
    // input, so it is never reshaped.
    if (!doNotLoadPieceIfNotRunning && shouldShapeDelivery(event)) {
      holdShapedEvent(
        this.wakeShaper,
        this.shapedEventDeliver,
        this.pieceIdForEventLink(eventLink),
        eventLink,
        event,
        retries,
        onCommit,
        { eventId: opts.eventId, originTx: opts.originTx, time },
      );
      return;
    }
    queueSchedulerEvent(this.eventQueueState, {
      eventLink,
      event,
      retries,
      onCommit,
      doNotLoadPieceIfNotRunning,
      eventId: opts.eventId,
      originTx: opts.originTx,
      time,
    });
  }

  // A released shaped event re-enters the ordinary queue path; the shaper reads
  // eventQueueState at release time, so it stays correct across state re-init.
  private shapedEventDeliver: DeliverFn = (
    eventLink,
    event,
    retries,
    onCommit,
    opts,
  ) =>
    queueSchedulerEvent(this.eventQueueState, {
      eventLink,
      event,
      retries,
      onCommit,
      doNotLoadPieceIfNotRunning: false,
      eventId: opts.eventId,
      originTx: opts.originTx,
      time: opts.time,
    });

  // The owning pattern instance for an input stream, used to group a pattern's
  // input across its several streams into one delivery-shaping window (per-pattern
  // coalescing, W3). The wake shaper's hold() runs before the handler is
  // resolved, so we find it here from the registered handlers; undefined when none
  // is registered yet (the shaper then falls back to per-stream grouping). The key
  // includes the owning space so two instances of one pattern in different spaces
  // (same content-addressed pieceId) do not share a bucket (see
  // shaperInstanceGroupKey).
  private pieceIdForEventLink(
    eventLink: NormalizedFullLink,
  ): string | undefined {
    for (const registration of this.eventHandlers) {
      if (
        registration.active &&
        areNormalizedLinksSame(registration.ref, eventLink)
      ) {
        return shaperInstanceGroupKey(
          (registration.handler as {
            schedulerObservationIdentity?: SchedulerObservationIdentity;
          }).schedulerObservationIdentity,
        );
      }
    }
    return undefined;
  }

  /**
   * Plan B seam: hold a shapable cell-flip notification so a watching lift/sink
   * observes it coalesced and jittered rather than at the instant the cell
   * changed. `groupKey` must identify the observing pattern instance (so all of
   * one pattern's shaped cell flips share a release window — the property that
   * defeats the over-sampling attack); `itemKey` identifies the changed cell
   * within the group (the coalescing unit); `deliver` performs the already
   * committed notification (never holds a transaction). Only real-world-timing
   * notifications may be routed here — never ordinary internal computation, or
   * all reactivity would stall.
   *
   * The shaper is owned and its lifecycle wired (idle-drain, dispose). Its two
   * high-value sources ARE routed here, at the invalidation.ts per-change
   * loop via shapableWakeGroupKey: renderer `$value` keystroke writes (a commit
   * whose transaction carries the renderer-input mark set by markRendererInputTx
   * in storage/reactivity-log.ts, stamped from runtime-client's blind CellSet)
   * and server pushes (notification.type "pull"/"integrate"). Each is coalesced
   * PER CELL (last-wins) so distinct cells are never dropped, and interactive
   * input and passive pushes use separate per-pattern buckets so background
   * chatter cannot drain the interactive burst. Only real-world-timing
   * notifications are routed — never ordinary internal computation.
   *
   * Deferred / open sources:
   * TODO(timing/plan-B/now): channel 4. `#now` ticks (builtins/wish.ts, a
   *   wall-clock-boundary interval timer) are deliberately NOT routed here — the
   *   value is already >=1s and grid-aligned and W1 denies the fine clock needed
   *   to read its phase, so the ~1s latency it would add to every clock read is
   *   not worth it. To wire it, recognize the `#now` cell link-keys at the
   *   notification point (its URI is a content hash, so intent is otherwise lost).
   */
  holdShapedCellNotification(
    groupKey: string,
    itemKey: string,
    chargeKey: object,
    deliver: () => void,
  ): void {
    holdShapedCell(this.wakeShaper, groupKey, itemKey, chargeKey, deliver);
  }

  // Whether any shapable cell-flip wake is currently held out of the scheduler
  // (plan B). Exposed for tests that need to observe that a change was routed
  // through the wake shaper's cell path before idle() drains it.
  hasPendingShapedCellNotifications(): boolean {
    return this.wakeShaper.hasPending(CELL_GROUP_PREFIX);
  }

  addEventHandler(
    handler: EventHandler,
    ref: NormalizedFullLink,
    populateDependencies?: (
      tx: IExtendedStorageTransaction,
      event: any,
    ) => void,
  ): Cancel {
    return addSchedulerEventHandler({
      eventHandlers: this.eventHandlers,
      nextEventHandlerGeneration: () => ++this.eventHandlerGeneration,
      eventQueue: this.eventQueue,
      queueExecution: () => this.queueExecution(),
    }, {
      handler,
      ref,
      populateDependencies,
    });
  }

  onConsole(fn: ConsoleHandler): void {
    this.consoleHandler = fn;
  }

  onError(fn: ErrorHandler): void {
    this.errorHandlers.add(fn);
  }

  reportError(error: unknown, action: unknown = { name: "runner" }): void {
    this.handleError(
      error instanceof Error ? error : new Error(String(error)),
      action,
    );
  }

  setEventPreflightTelemetryEnabled(enabled: boolean): void {
    this.eventPreflightTelemetryEnabled = enabled;
  }

  isEventPreflightTelemetryEnabled(): boolean {
    return this.eventPreflightTelemetryEnabled;
  }

  // ============================================================
  // Debounce infrastructure for throttling slow actions
  // ============================================================

  /**
   * Sets a debounce delay for an action.
   * When the action is triggered, it will wait for the specified delay before running.
   * If triggered again during the delay, the timer resets.
   */
  setDebounce(action: Action, ms: number): void {
    this.gates.setDebounce(action, ms);
    // Configuring a debounce on an already-invalid computation starts its
    // trailing window now — the same re-arm an invalidation would do
    // (arming is otherwise the invalidation path's job; queries stay pure).
    const record = this.nodes.get(action);
    if (
      ms > 0 && record?.kind === "computation" && this.isInvalidAction(action)
    ) {
      this.gates.onInvalidated(
        record,
        performance.now(),
        this.createDebouncedComputationContext(),
      );
    }
  }

  /**
   * Gets the current debounce delay for an action, if set.
   */
  getDebounce(action: Action): number | undefined {
    return this.gates.getDebounce(action);
  }

  /**
   * Clears the debounce setting for an action.
   */
  clearDebounce(action: Action): void {
    this.gates.clearDebounce(action);
  }

  /**
   * Enables or disables auto-debounce detection for an action.
   * When set to true, this action opts OUT of auto-debounce.
   * By default, slow actions (> 50ms avg after 3 runs) will automatically get debounced.
   */
  setNoDebounce(action: Action, optOut: boolean): void {
    this.gates.setNoDebounce(action, optOut);
  }

  // ============================================================
  // Throttle infrastructure - "value may be outdated by T ms"
  // ============================================================

  /**
   * Sets a throttle period for an action.
   * The action won't run if it ran within the last `ms` milliseconds.
   * Unlike debounce, throttled actions stay dirty and will be pulled
   * by effects when the throttle period expires. Event handlers whose head
   * dependencies are throttled are parked until the earliest eligible wake time.
   */
  setThrottle(action: Action, ms: number): void {
    this.gates.setThrottle(action, ms);
  }

  /**
   * Gets the current throttle period for an action, if set.
   */
  getThrottle(action: Action): number | undefined {
    return this.gates.getThrottle(action);
  }

  /**
   * Clears the throttle setting for an action.
   */
  clearThrottle(action: Action): void {
    this.gates.clearThrottle(action);
  }

  /**
   * Set action IDs that should trigger a debugger breakpoint before execution.
   */
  setBreakpoints(actionIds: string[]): void {
    this.breakpoints.clear();
    for (const id of actionIds) {
      this.breakpoints.add(id);
    }
  }

  /**
   * Get currently set breakpoint action IDs.
   */
  getBreakpoints(): string[] {
    return Array.from(this.breakpoints);
  }

  /**
   * Check if an action ID has a breakpoint set.
   */
  hasBreakpoint(actionId: string): boolean {
    return this.breakpoints.has(actionId);
  }

  /**
   * Returns diagnostic statistics about the scheduler state.
   * Useful for debugging and monitoring pull-based scheduling behavior.
   */
  getStats(): { effects: number; computations: number; pending: number } {
    return {
      effects: this.nodes.effects.size,
      computations: this.nodes.computations.size,
      pending: this.pending.size,
    };
  }

  /**
   * Returns whether an action is registered as an effect.
   */
  isEffect(action: Action): boolean {
    return this.nodes.effects.has(action);
  }

  /**
   * Returns whether an action is registered as a computation.
   */
  isComputation(action: Action): boolean {
    return this.nodes.computations.has(action);
  }

  /**
   * Returns whether an action is marked as dirty.
   */
  isDirty(action: Action): boolean {
    return this.isInvalidAction(action);
  }

  /**
   * Returns the set of actions that depend on this action's output.
   */
  getDependents(action: Action): Set<Action> {
    return this.dependents.get(action) ?? new Set();
  }

  /**
   * Returns a snapshot of the current dependency graph for visualization.
   * Uses getActionId for the identifier (includes code location).
   */
  getGraphSnapshot(): SchedulerGraphSnapshot {
    return buildSchedulerGraphSnapshot(this.graphSnapshotState);
  }

  // ============================================================
  // Push-triggered filtering
  // ============================================================

  /**
   * Returns the action's static write surface.
   */
  getMightWrite(action: Action): IMemorySpaceAddress[] | undefined {
    return this.writeIndex.getSchedulingWrites(action);
  }

  // ============================================================
  // Compute time tracking for cycle-aware scheduling
  // ============================================================

  /**
   * Returns the execution statistics for an action, if available.
   * Useful for diagnostics and determining cycle convergence strategy.
   * Accepts either an Action or an action ID string.
   */
  getActionStats(action: Action | string): ActionStats | undefined {
    return getActionStatsFromState(this.actionTimingState, action);
  }

  /**
   * Returns filter statistics for the current/last execution cycle.
   */
  getFilterStats(): { filtered: number; executed: number } {
    return { ...this.filterStats };
  }

  /**
   * Resets filter statistics.
   */
  resetFilterStats(): void {
    this.filterStats.filtered = 0;
    this.filterStats.executed = 0;
  }

  /**
   * Enables collection of per-iteration settle stats during execute().
   * Call this once before running patterns to opt in to the overhead.
   */
  enableSettleStats(): void {
    this.setSettleStatsEnabled(true);
  }

  /**
   * Enables or disables collection of per-iteration settle stats during execute().
   * Disabling also clears the last collected stats to avoid outdated reads.
   */
  setSettleStatsEnabled(enabled: boolean): void {
    this.collectSettleStats = enabled;
    if (!enabled) {
      this.lastSettleStats = null;
      this.settleStatsHistory = [];
    }
  }

  /**
   * Returns settle stats from the last execute() call, or null if not enabled/collected.
   */
  getSettleStats(): SettleStats | null {
    return this.lastSettleStats;
  }

  /**
   * Returns recent settle stats history from execute() calls, oldest first.
   */
  getSettleStatsHistory(): SettleStatsHistoryEntry[] {
    return [...this.settleStatsHistory];
  }

  /**
   * Enables or disables collection of exact action-run history.
   * Disabling clears the current ring buffer to avoid outdated reads.
   */
  setActionRunTraceEnabled(enabled: boolean): void {
    this.collectActionRunTrace = enabled;
    if (!enabled) {
      this.actionRunTrace.length = 0;
    }
  }

  /**
   * Returns recent exact action-run history, oldest first.
   */
  getActionRunTrace(): ActionRunTraceEntry[] {
    return [...this.actionRunTrace];
  }

  /**
   * Enables or disables collection of structured trigger-trace entries.
   * Disabling clears the current ring buffer to avoid outdated reads.
   */
  setTriggerTraceEnabled(enabled: boolean): void {
    this.collectTriggerTrace = enabled;
    if (!enabled) {
      this.triggerTrace = [];
    }
  }

  /**
   * Returns recent structured trigger-trace entries, oldest first.
   */
  getTriggerTrace(): TriggerTraceEntry[] {
    return [...this.triggerTrace];
  }

  // ============================================================
  // Non-settling detection API
  // ============================================================

  /**
   * Returns whether the scheduler has detected a non-settling condition.
   * This means execute() is consuming a high fraction of wall-clock time,
   * indicating the system is churning.
   */
  isNonSettling(): boolean {
    return this.settlingTracker.nonSettlingDetected;
  }

  /**
   * Enables or disables automatic triggering of diagnosis when non-settling
   * is detected. Off by default.
   */
  setAutoTriggerDiagnosis(enabled: boolean): void {
    this.autoTriggerDiagnosis = enabled;
  }

  /**
   * Runs a diagnosis for the specified duration and returns the result.
   * This is the main entry point for external callers (IPC, console).
   */
  runDiagnosis(durationMs = 5000): Promise<SchedulerDiagnosisResult> {
    return runSchedulerDiagnosis(this.diagnosisControlState, durationMs);
  }

  // ── Inline idempotency check mode ──────────────────────────────────

  enableIdempotencyCheck(): void {
    this.idempotencyCheckMode = true;
    this.idempotencyViolations.length = 0;
    this.queueExecution();
  }

  disableIdempotencyCheck(): void {
    this.idempotencyCheckMode = false;
  }

  getIdempotencyViolations(): NonIdempotentReport[] {
    return [...this.idempotencyViolations];
  }

  /**
   * Checks all computations for idempotency by enabling inline mode
   * and force-running each computation through run(). Each run()
   * automatically gets a second synchronous run for comparison.
   */
  async runIdempotencyCheck(): Promise<SchedulerDiagnosisResult> {
    return await runSchedulerIdempotencyCheck(this.diagnosisControlState);
  }

  /**
   * Clean up all pending timers and resources.
   * Should be called when the scheduler is being torn down.
   */
  dispose(): void {
    this.headEventLoadPark = null;
    this.headEventLoadParkHistory = null;
    this.disposed = true;
    this.gates.cancelWake();
    if (this.pendingQueueTaskTimer !== null) {
      clearTimeout(this.pendingQueueTaskTimer);
      this.pendingQueueTaskTimer = null;
    }
    this.triggerIndex.clear();
    this.wakeShaper.dispose();
    // Clean up diagnosis state
    if (this.diagnosisTimeout) {
      clearTimeout(this.diagnosisTimeout);
      this.diagnosisTimeout = null;
    }
    this.diagnosisEnabled = false;
  }

  /**
   * Settle events whose exact handler registration is still pending before
   * runtime teardown waits for scheduler quiescence. Live runtimes keep these
   * intents parked indefinitely; teardown is the terminal owner cancellation.
   */
  cancelHandlerLoadPendingEvents(reason: string): void {
    let dropped = false;
    for (const event of [...this.eventQueue]) {
      if (event.handlerLoadPending !== true) continue;
      this.dropEvent(event, reason);
      dropped = true;
    }
    if (dropped) this.queueExecution();
  }

  // ============================================================
  // Execution orchestration
  // ============================================================

  private handleError(error: Error, action: any) {
    handleSchedulerError(
      {
        errorHandlers: this.errorHandlers,
        parseStack: (stack) => this.runtime.harness.parseStack(stack),
      },
      error,
      action,
    );
  }

  private async execute(): Promise<void> {
    if (this.disposed) return;
    logger.timeStart("scheduler", "execute");

    // In case a directly invoked `run` is still running, wait for it to finish.
    if (this.runningPromise) await this.runningPromise;

    this.beginExecuteCycle();
    const eventBlockingDeps = await this.processExecuteEventPhase();
    const initialSeeds = this.buildInitialExecuteSeeds(eventBlockingDeps);

    const settleResult = await this.runSettleLoop(initialSeeds);
    this.recordBudgetBackoffTelemetry(settleResult);
    this.recordExecuteEndTelemetry();
    this.applyExecuteContinuation();
    logger.timeEnd("scheduler", "execute");
  }

  private beginExecuteCycle(): void {
    this.activePassId = ++this.passCounter;
    this.provisionalDemandThisPass.clear();
    for (const record of this.nodes.nodes()) {
      record.passRuns = 0;
    }

    // Non-settling heuristic: record execute() start
    markExecuteStart(this.settlingTracker);
  }

  private async processExecuteEventPhase(): Promise<Set<Action>> {
    // Track dirty dependencies that block events - these must be added to workSet
    const eventBlockingDeps = new Set<Action>();
    this.eventPassDemandRefresh = undefined;

    logger.timeStart("scheduler", "execute", "event");
    try {
      await processPullQueuedEventDuringExecute(
        this.eventExecutionState,
        eventBlockingDeps,
      );
      return eventBlockingDeps;
    } finally {
      logger.timeEnd("scheduler", "execute", "event");
    }
  }

  private buildInitialExecuteSeeds(
    eventBlockingDeps: Iterable<Action>,
  ): Set<Action> {
    // Capture the head event's transient demand roots for this settle pass.
    return buildPullInitialSeeds({
      eventBlockingDeps,
    });
  }

  private async runSettleLoop(
    initialSeeds: ReadonlySet<Action>,
  ): Promise<SchedulerSettleResult> {
    const settleResult = await runPullSchedulerSettleLoop(
      this.settleLoopState,
      initialSeeds,
    );

    if (settleResult.settleStats) {
      this.lastSettleStats = settleResult.settleStats;
      pushBoundedHistory(
        this.settleStatsHistory,
        { recordedAt: performance.now(), stats: settleResult.settleStats },
        MAX_SETTLE_STATS_HISTORY,
      );
    }

    this.runtime.telemetry.submit({
      type: "scheduler.settle",
      durationMs: settleResult.settleDurationMs,
      iterations: settleResult.iterationsRun,
      settledEarly: settleResult.settledEarly,
      seedCount: initialSeeds.size,
      workSetSize: settleResult.workSetSize,
    });

    this.clearProvisionalDemandAtPassEnd();
    this.clearBackoffForCleanNodes();
    this.activePassId = undefined;

    return settleResult;
  }

  private applyExecuteContinuation(): void {
    applyPullExecuteContinuation(this.executeContinuationState);
  }

  private recordBudgetBackoffTelemetry(
    settleResult: SchedulerSettleResult,
  ): void {
    if (!settleResult.backoffApplied) return;
    const nonSettlingTelemetry = markNonSettlingEpisode(this.settlingTracker);
    if (!nonSettlingTelemetry) return;

    this.runtime.telemetry.submit({
      type: "scheduler.non-settling",
      ...nonSettlingTelemetry,
    });
    this.warnNonSettlingActions(settleResult.backoffActions);
  }

  private warnNonSettlingActions(actions: readonly Action[]): void {
    const maxListedActions = 10;
    const labels = actions.slice(0, maxListedActions).map((action) => {
      const actionId = this.getActionId(action);
      const info = getSchedulerActionTelemetryInfo(action);
      const readableName = info?.moduleName ?? info?.patternName;
      return readableName && readableName !== actionId
        ? `${readableName} (${actionId})`
        : actionId;
    });
    const omittedCount = actions.length - labels.length;
    const actionList = labels.length > 0
      ? labels.join(", ") +
        (omittedCount > 0 ? `, and ${omittedCount} more` : "")
      : "unknown";

    logger.warn("scheduler-non-settling", () => [
      "Reactive graph did not settle within a scheduler pass; " +
      "retrying with backoff. Check for a reactive cycle or non-idempotent " +
      `computation. Actions: ${actionList}. ` +
      "Run commonfabric.detectNonIdempotent() for details.",
    ]);
  }

  private recordExecuteEndTelemetry(): void {
    // Non-settling heuristic: accumulate busy time at end of execute()
    const executeEnd = recordExecuteEnd(this.settlingTracker);
    if (this.diagnosisEnabled) {
      this.diagnosisBusyTime += executeEnd.diagnosisBusyTimeMs;
    }
    if (executeEnd.nonSettlingTelemetry) {
      this.runtime.telemetry.submit({
        type: "scheduler.non-settling",
        ...executeEnd.nonSettlingTelemetry,
      });
      // Auto-trigger diagnosis if enabled
      if (this.autoTriggerDiagnosis && !this.diagnosisEnabled) {
        this.startDiagnosis();
      }
    }
  }

  // ============================================================
  // Idempotency diagnosis API (Phase 2 + 3)
  // ============================================================

  /**
   * Starts diagnosis mode: captures read/write values and causal edges.
   * Automatically stops after durationMs.
   */
  private startDiagnosis(durationMs = 5000): void {
    startSchedulerDiagnosis(this.diagnosisControlState, durationMs);
  }

  /**
   * Stops diagnosis mode and finalizes results.
   */
  private stopDiagnosis(): void {
    stopSchedulerDiagnosis(this.diagnosisControlState);
  }

  /**
   * Updates the reverse dependency graph (dependents map).
   * For each action that writes to paths this action reads, add this action as a dependent.
   */
  private updateDependents(action: Action, log: ReactivityLog): void {
    const actionId = this.getActionId(action);
    updateDependentEdgesForLog(this.dependencyGraphState, action, log);

    // Emit telemetry for dependency updates
    this.runtime.telemetry.submit({
      type: "scheduler.dependencies.update",
      actionId,
      reads: [...log.reads, ...log.shallowReads].map((r) =>
        `${r.space}/${r.id}/${r.path.join("/")}`
      ),
      writes: log.writes.map((w) => `${w.space}/${w.id}/${w.path.join("/")}`),
    });
  }

  // ============================================================
  // State wiring
  // ============================================================

  // Keep state-bundle wiring explicit without making the field declarations
  // read like one large object graph.
  private initializeSchedulerState(): void {
    this.diagnosisControlState = this.createDiagnosisControlState();
    this.writeIndex = this.createWriteIndex();
    this.eventPreflightDependencyState = this
      .createEventPreflightDependencyState();
    this.dependencyGraphState = this.createDependencyGraphState();
    this.dependencyUpdateState = this.createDependencyUpdateState();
    this.triggerSubscriptionState = this.createTriggerSubscriptionState();
    this.storageNotificationState = this.createStorageNotificationState();
    this.pendingPullRunnableState = this.createPendingPullRunnableState();
    this.dirtyPullRunnableState = this.createDirtyPullRunnableState();
    this.dirtyPullRunnableStateWithDebounce = this
      .createDirtyPullRunnableStateWithDebounce();
    this.pullSchedulingState = this.createPullSchedulingState();
    this.subscriptionState = this.createSubscriptionState();
    this.subscribeActionState = this.createSubscribeActionState();
    this.unsubscribeState = this.createUnsubscribeState();
    this.settleLoopState = this.createSettleLoopState();
    this.executeContinuationState = this.createExecuteContinuationState();
    this.eventQueueState = this.createEventQueueState();
    this.eventExecutionState = this.createEventExecutionState();
    this.actionRunState = this.createActionRunState();
    this.graphSnapshotState = this.createGraphSnapshotState();
  }

  private createDiagnosisControlState(): SchedulerDiagnosisControlState {
    return {
      getDiagnosisEnabled: () => this.diagnosisEnabled,
      setDiagnosisEnabled: (enabled) => {
        this.diagnosisEnabled = enabled;
      },
      getDiagnosisTimeout: () => this.diagnosisTimeout,
      setDiagnosisTimeout: (timeout) => {
        this.diagnosisTimeout = timeout;
      },
      getDiagnosisStartTime: () => this.diagnosisStartTime,
      setDiagnosisStartTime: (time) => {
        this.diagnosisStartTime = time;
      },
      getDiagnosisBusyTime: () => this.diagnosisBusyTime,
      setDiagnosisBusyTime: (time) => {
        this.diagnosisBusyTime = time;
      },
      getDiagnosisResolve: () => this.diagnosisResolve,
      setDiagnosisResolve: (resolve) => {
        this.diagnosisResolve = resolve;
      },
      diagnosisHistory: this.diagnosisHistory,
      diagnosisNonIdempotent: this.diagnosisNonIdempotent,
      causalEdges: this.causalEdges,
      idempotencyViolations: this.idempotencyViolations,
      computations: this.nodes.computations,
      setIdempotencyCheckMode: (enabled) => {
        this.idempotencyCheckMode = enabled;
      },
      runAction: (action) => this.run(action),
    };
  }

  private createWriteIndex(): SchedulerWriteIndex {
    return new SchedulerWriteIndex();
  }

  private createEventPreflightDependencyState(): EventPreflightDependencyState {
    return {
      getTrace: () => this.eventPreflightTraceContext,
      nodes: this.nodes,
      pending: this.pending,
      reverseDependencies: this.reverseDependencies,
      dependents: this.dependents,
      dependencies: this.dependencies,
      writersByEntity: this.writeIndex.writersByEntity,
      effects: this.nodes.effects,
      materializerIndex: this.materializers,
      triggerIndex: this.triggerIndex,
      getSchedulingWrites: (target) =>
        this.writeIndex.getSchedulingWrites(target),
      getActionId: (target) => this.getActionId(target),
    };
  }

  private createDependencyGraphState(): DependencyGraphState {
    return {
      triggerIndex: this.triggerIndex,
      writersByEntity: this.writeIndex.writersByEntity,
      dependencies: this.dependencies,
      dependents: this.dependents,
      reverseDependencies: this.reverseDependencies,
      nodes: this.nodes,
      materializerIndex: this.materializers,
      getSchedulingWrites: (action) =>
        this.writeIndex.getSchedulingWrites(action),
    };
  }

  private createDependencyUpdateState(): DependencyUpdateState {
    return {
      writeIndex: this.writeIndex,
      dependencies: this.dependencies,
    };
  }

  private createTriggerSubscriptionState(): TriggerSubscriptionState {
    return new SchedulerTriggerSubscriptions({
      triggerIndex: this.triggerIndex,
      cancels: this.cancels,
      getActionId: (action) => this.getActionId(action),
      onTriggerUnsubscribe: (actionId, entityCount) => {
        logger.debug("schedule-unsubscribe", () => [
          `Action: ${actionId}`,
          `Entities: ${entityCount}`,
        ]);
      },
    });
  }

  private createStorageNotificationState(): StorageNotificationState {
    return {
      triggerIndex: this.triggerIndex,
      nodes: this.nodes,
      getDiagnosisEnabled: () => this.diagnosisEnabled,
      getCollectTriggerTrace: () => this.collectTriggerTrace,
      changeGroupToActionId: this.changeGroupToActionId,
      recordCausalEdge: (edge) => {
        this.causalEdges.push(edge);
      },
      actionChangeGroups: this.actionChangeGroups,
      effects: this.nodes.effects,
      pending: this.pending,
      getActionId: (target) => this.getActionId(target),
      recordCellUpdate: (change) =>
        this.runtime.telemetry.submit({
          type: "cell.update",
          change,
        }),
      recordTriggerTrace: (entry) =>
        recordTriggerTraceState({ triggerTrace: this.triggerTrace }, entry),
      scheduleWithDebounce: (target) => this.scheduleWithDebounce(target),
      markInvalid: (target, cause) =>
        this.markAndScheduleInvalidAction(target, cause),
      isInvalid: (target) => this.isInvalidAction(target),
      materializerIndex: this.materializers,
      queueExecution: () => this.queueExecution(),
      isRendererInputSource: (source) =>
        source !== undefined && isRendererInputTx(source),
      holdShapedNotification: (groupKey, itemKey, chargeKey, deliver) =>
        this.holdShapedCellNotification(groupKey, itemKey, chargeKey, deliver),
    };
  }

  private createStorageSubscription(): IStorageSubscription {
    return {
      next: (notification: StorageNotification) => {
        this.processStorageNotification(notification);
        return { done: false };
      },
    };
  }

  private processStorageNotification(notification: StorageNotification): void {
    if (notification.type === "scheduler-observations") {
      // Subscription-carried observations arrive AFTER their sync's
      // integrate notification (same synchronous turn): the writes have been
      // applied and their readers marked dirty; adoption now clears the dirt
      // the writer already resolved, before the deferred dispatch runs.
      // Payload validation happens inside adoptRemoteObservations.
      this.adoptRemoteObservations(
        notification.observations.map((row) => ({
          executionContextKey: row.executionContextKey,
          observation: row.observation as SchedulerActionObservation,
          ...(row.directDirtySeq !== undefined
            ? { directDirtySeq: row.directDirtySeq }
            : {}),
          ...(row.staleSeq !== undefined ? { staleSeq: row.staleSeq } : {}),
          ...(row.unknownReason !== undefined
            ? { unknownReason: row.unknownReason }
            : {}),
        })),
        {
          readsCurrentAtSeq: notification.seqCurrentAtOrBelow,
          hasPendingLocalWriteOverlapping:
            notification.hasPendingWriteOverlapping,
        },
      );
      return;
    }
    processStorageNotification(
      this.storageNotificationState,
      notification,
    );
  }

  private createPendingPullRunnableState(): PendingPullRunnableState {
    return {
      effects: this.nodes.effects,
      isDemandedPullComputation: (action) =>
        this.isDemandedPullComputation(action),
      shouldRunFirstPullComputationInDemandContext: (action) =>
        this.shouldRunFirstPullComputationInDemandContext(action),
    };
  }

  private createDirtyPullRunnableState(): DirtyPullRunnableState {
    return {
      effects: this.nodes.effects,
      isDemandedPullComputation: (action) =>
        this.isDemandedPullComputation(action),
      isThrottled: (action) => this.gates.isThrottled(action),
    };
  }

  private createDirtyPullRunnableStateWithDebounce(): DirtyPullRunnableStateWithDebounce {
    return {
      ...this.dirtyPullRunnableState,
      isDebouncedComputationWaiting: (action) =>
        this.isDebouncedComputationWaiting(action),
    };
  }

  private createPullSchedulingState(): PullSchedulingState {
    return {
      nodes: this.nodes,
      pending: this.pending,
      effects: this.nodes.effects,
      materializerIndex: this.materializers,
      pendingPullRunnableState: this.pendingPullRunnableState,
      dirtyPullRunnableState: this.dirtyPullRunnableState,
      dirtyPullRunnableStateWithDebounce: this
        .dirtyPullRunnableStateWithDebounce,
      isLiveAction: (action) => this.isLiveAction(action),
      hasActiveDebounceTimer: (action) =>
        this.gates.hasActiveDebounceTimer(action),
      getNextEligibleRunTime: (action) => this.getNextEligibleRunTime(action),
      // Engaged only while an initial rehydration is being applied (synchronous
      // post-phase-7). MUST NOT read backgroundTasks: its sole populator is now
      // the event-driven piece-start task (events.ts), so gating on it would
      // pause all pull scheduling on every piece-start.
      hasPendingInitialRehydrations: () => this.initialRehydrationInFlight > 0,
      // Per-node convergence episode state prevents one exhausted subgraph
      // from releasing idle for unrelated work.
      isConvergenceHoldActive: (action) => this.isConvergenceHoldActive(action),
      isConvergenceBackoffDeferred: (action) =>
        this.isConvergenceBackoffDeferred(action),
    };
  }

  private isConvergenceHoldActive(action: Action): boolean {
    return (this.nodes.get(action)?.gate.convergenceHoldPasses ?? 0) <
      CONVERGENCE_IDLE_HOLD_MAX_BACKOFF_PASSES;
  }

  private resetConvergenceHoldPasses(): void {
    for (const record of this.nodes.nodes()) {
      record.gate.convergenceHoldPasses = 0;
    }
  }

  // A node is convergence-backoff-deferred iff its `gate.backoffUntil` is in the
  // future. For an already-ran computation `backoffUntil` is set exclusively by
  // the settle-cap backoff (planBudgetBackoff); the resume initial-run hold that
  // also rides `backoffUntil` only applies to never-ran nodes. Throttle and
  // debounce use their own gate fields, so this cleanly excludes them.
  private isConvergenceBackoffDeferred(action: Action): boolean {
    const backoffUntil = this.nodes.get(action)?.gate.backoffUntil;
    return backoffUntil !== undefined && backoffUntil > performance.now();
  }

  private createSubscriptionState(): SchedulerSubscriptionState {
    return {
      actionChangeGroups: this.actionChangeGroups,
      changeGroupToActionId: this.changeGroupToActionId,
      nodes: this.nodes,
      dependencyGraphState: this.dependencyGraphState,
      getIdempotencyCheckMode: () => this.idempotencyCheckMode,
      queueExecution: () => this.queueExecution(),
      getActionId: (target) => this.getActionId(target),
      getExecutingAction: () => this.executingAction,
    };
  }

  private createSubscribeActionState(): SchedulerSubscribeActionState {
    return {
      subscriptionState: this.subscriptionState,
      dependencyUpdateState: this.dependencyUpdateState,
      triggerSubscriptionState: this.triggerSubscriptionState,
      markProvisionalDemand: (record) => this.markProvisionalDemand(record),
      pending: this.pending,
      effects: this.nodes.effects,
      writeIndex: this.writeIndex,
      adoptGateConfig: (action) => this.gates.adopt(action),
      setDebounce: (action, ms) => this.setDebounce(action, ms),
      setNoDebounce: (action, optOut) => this.setNoDebounce(action, optOut),
      setThrottle: (action, ms) => this.setThrottle(action, ms),
      getSchedulingWrites: (action) =>
        this.writeIndex.getSchedulingWrites(action),
      isThrottled: (action) => this.gates.isThrottled(action),
      isDebouncedComputationWaiting: (action) =>
        this.isDebouncedComputationWaiting(action),
      markInvalid: (action) => this.markAndScheduleInvalidAction(action),
      updateDependents: (action, log) => this.updateDependents(action, log),
      registerWriterDependents: (action, writes) =>
        registerDependentsForWriterSurface(
          this.dependencyGraphState,
          action,
          writes,
        ),
      queueExecution: () => this.queueExecution(),
      getActionId: (action) => this.getActionId(action),
      unsubscribe: (action) => this.unsubscribe(action),
      submitSubscribeTelemetry: (event) => {
        this.runtime.telemetry.submit(event);
      },
    };
  }

  private createUnsubscribeState(): SchedulerUnsubscribeActionState {
    return {
      cancels: this.cancels,
      dependencies: this.dependencies,
      actionChangeGroups: this.actionChangeGroups,
      changeGroupToActionId: this.changeGroupToActionId,
      pending: this.pending,
      reverseDependencies: this.reverseDependencies,
      dependents: this.dependents,
      dependencyGraphState: this.dependencyGraphState,
      nodes: this.nodes,
      writeIndex: this.writeIndex,
      getActionId: (target) => this.getActionId(target),
      clearInvalid: (target) => this.clearInvalidAction(target),
      cancelDebounceTimer: (target) => this.gates.cancelDebounceTimer(target),
      clearComputationDebounceState: (target, targetOptions) =>
        this.gates.clearComputationDebounceState(target, targetOptions),
      recomputeWakeAfterClear: () => this.gates.recomputeWakeAfterClear(),
    };
  }

  private createSettleLoopState(): SchedulerSettleLoopState {
    return {
      getCollectSettleStats: () => this.collectSettleStats,
      effects: this.nodes.effects,
      computations: this.nodes.computations,
      pending: this.pending,
      dependencies: this.dependencies,
      nodes: this.nodes,
      dependents: this.dependents,
      filterStats: this.filterStats,
      materializerIndex: this.materializers,
      writersByEntity: this.writeIndex.writersByEntity,
      getSchedulingWrites: (action) =>
        this.writeIndex.getSchedulingWrites(action),
      getSchedulingWritesMap: () => this.writeIndex.getSchedulingWritesMap(),
      collectPullIterationSeeds: (seeds) =>
        this.collectPullIterationSeeds(seeds),
      refreshPassScopedDemand: (demand) => {
        this.eventPassDemandRefresh?.(demand);
      },
      getActionId: (action) => this.getActionId(action),
      isThrottled: (action) => this.gates.isThrottled(action),
      getNextEligibleRunTime: (action) => this.getNextEligibleRunTime(action),
      isDebouncedComputationWaiting: (action) =>
        this.isDebouncedComputationWaiting(action),
      clearComputationDebounceState: (action) =>
        this.gates.clearComputationDebounceState(action),
      isLiveAction: (action) => this.isLiveAction(action),
      runAction: (action) => this.run(action),
    };
  }

  private createExecuteContinuationState(): ExecuteContinuationState {
    return {
      pullScheduling: this.pullSchedulingState,
      eventQueue: this.eventQueue,
      idlePromises: this.idlePromises,
      consumeRerunAfterCurrentExecute: () => {
        const shouldRerun = this.rerunAfterCurrentExecute;
        this.rerunAfterCurrentExecute = false;
        return shouldRerun;
      },
      hasPendingLineageHeadEvent: () => this.hasPendingLineageHeadEvent(),
      hasLoadParkedHeadEvent: () => this.hasLoadParkedHeadEvent(),
      scheduleWake: (at) => this.gates.scheduleWake(at),
      hasWakeTimer: () => this.gates.hasWakeTimer(),
      setScheduled: (scheduled) => {
        this.scheduled = scheduled;
      },
      resetSettlingTracker: () => {
        this.settlingTracker = createSettlingTracker();
      },
      resetConvergenceHoldPasses: () => {
        this.resetConvergenceHoldPasses();
      },
      setPendingQueueTaskTimer: (timer) => {
        this.pendingQueueTaskTimer = timer;
      },
      execute: () => this.execute(),
    };
  }

  private createEventQueueState(): SchedulerEventQueueState {
    return {
      runtime: this.runtime,
      eventHandlers: this.eventHandlers,
      eventQueue: this.eventQueue,
      backgroundTasks: this.backgroundTasks,
      nextEventSequence: () => ++this.eventSequence,
      queueExecution: () => this.queueExecution(),
      recordLineageEvent: (originTx, queuedEvent) => {
        this.lineage.recordEvent(originTx, queuedEvent);
      },
      releaseLineageEvent: (originTx, queuedEvent) => {
        this.lineage.release(originTx, queuedEvent);
      },
    };
  }

  private createEventExecutionState(): SchedulerEventExecutionState {
    const getEventPreflightTelemetryEnabled = () =>
      this.eventPreflightTelemetryEnabled;
    return {
      runtime: this.runtime,
      eventQueue: this.eventQueue,
      pendingDurableEventReadiness: this.pendingDurableEventReadiness,
      backpressure: this.runtime.commitBackpressure,
      collectPendingLoadParkKeys: (event, deps) =>
        this.collectPendingLoadParkKeys(event, deps),
      capturePendingLoadGenerations: () => this.capturePendingLoadGenerations(),
      parkHeadEventForLoads: (event, keys) =>
        this.parkHeadEventForLoads(event, keys),
      isHeadEventLoadParked: (event) => this.isHeadEventLoadParked(event),
      nodes: this.nodes,
      pending: this.pending,
      get eventPreflightTelemetryEnabled() {
        return getEventPreflightTelemetryEnabled();
      },
      setRunningPromise: (promise) => {
        this.runningPromise = promise;
      },
      getActionId: (target) => this.getActionId(target),
      getActionTelemetryInfo: (target) =>
        getSchedulerActionTelemetryInfo(target),
      handleError: (error, target) => this.handleError(error, target),
      queueExecution: () => this.queueExecution(),
      setEventPreflightTraceContext: (trace) => {
        this.eventPreflightTraceContext = trace;
      },
      collectInvalidUpstreamForLog: (deps, invalidDeps) =>
        this.collectInvalidUpstreamForLog(
          deps,
          invalidDeps,
        ),
      setEventPassDemandRefresh: (refresh) => {
        this.eventPassDemandRefresh = refresh;
      },
      isDebouncedComputationWaiting: (target) =>
        this.isDebouncedComputationWaiting(target),
      getNextDebounceRunTime: (target) => this.getNextDebounceRunTime(target),
      getNextEligibleRunTime: (target) => this.getNextEligibleRunTime(target),
      scheduleWake: (notBefore) => this.gates.scheduleWake(notBefore),
      lineageStatus: (originTx) => this.lineage.originStatus(originTx),
      releaseLineageEvent: (originTx, queuedEvent) => {
        this.lineage.release(originTx, queuedEvent);
      },
      dropEvent: (queuedEvent, reason) => {
        this.dropEvent(queuedEvent, reason);
      },
      recordLineageEvent: (originTx, queuedEvent) => {
        this.lineage.recordEvent(originTx, queuedEvent);
      },
      getOriginLocalSeq: (originTx, targetSpace) =>
        getCommitLocalSeq(originTx.tx, targetSpace),
      snapshotEventPreflightTraceContext: (trace) =>
        snapshotEventPreflightTraceContext(
          this.eventPreflightDependencyState,
          trace,
        ),
    };
  }

  private createActionRunState(): SchedulerActionRunState {
    return {
      runtime: this.runtime,
      actionChangeGroups: this.actionChangeGroups,
      actionTimingState: this.actionTimingState,
      retries: this.retries,
      pending: this.pending,
      actionRunTrace: this.actionRunTrace,
      getActionGeneration: (target) => this.getActionGeneration(target),
      beginActionReadinessAttempt: (target) =>
        this.beginActionReadinessAttempt(target),
      isActionGenerationCurrent: (target, generation) =>
        this.isActionGenerationCurrent(target, generation),
      isActionReadinessAttemptCurrent: (target, generation, attempt) =>
        this.isActionReadinessAttemptCurrent(target, generation, attempt),
      nodes: this.nodes,
      diagnosisHistory: this.diagnosisHistory,
      diagnosisNonIdempotent: this.diagnosisNonIdempotent,
      idempotencyViolations: this.idempotencyViolations,
      getRunningPromise: () => this.runningPromise,
      setRunningPromise: (promise) => {
        this.runningPromise = promise;
      },
      getCollectActionRunTrace: () => this.collectActionRunTrace,
      getDiagnosisEnabled: () => this.diagnosisEnabled,
      getIdempotencyCheckMode: () => this.idempotencyCheckMode,
      getActionId: (target) => this.getActionId(target),
      getActionTelemetryInfo: (target) =>
        getSchedulerActionTelemetryInfo(target),
      getSchedulingWrites: (target) =>
        this.writeIndex.getSchedulingWrites(target),
      getMaterializerWriteEnvelopes: (target) =>
        this.materializers.getMaterializerWriteEnvelopes(target),
      getDebounce: (target) => this.gates.getDebounce(target),
      getNoDebounce: (target) => this.gates.getNoDebounce(target),
      getThrottle: (target) => this.gates.getThrottle(target),
      maybeAutoDebounce: (target) => this.maybeAutoDebounce(target),
      markActionHasRun: (target) => this.gates.markActionHasRun(target),
      markNodeHasRun: (target) => this.markNodeHasRun(target),
      handleError: (error, target) => this.handleError(error, target),
      resubscribe: (target, log) => this.resubscribe(target, log),
      markInvalid: (target) => this.markActionInvalid(target),
      clearDirty: (target) => this.clearInvalidAction(target),
      queueExecution: () => this.queueExecution(),
      setExecutingAction: (target, targetActionId) => {
        this.executingAction = target;
        this.currentActionId = targetActionId;
      },
      clearExecutingAction: () => {
        this.executingAction = null;
        this.currentActionId = undefined;
      },
    };
  }

  private createGraphSnapshotState(): SchedulerGraphSnapshotState {
    return {
      effects: this.nodes.effects,
      computations: this.nodes.computations,
      pending: this.pending,
      dependencies: this.dependencies,
      dependents: this.dependents,
      nodes: this.nodes,
      actionStats: this.actionStats,
      getDebounce: (action) => this.gates.getDebounce(action),
      getThrottle: (action) => this.gates.getThrottle(action),
      hasActiveDebounceTimer: (action) =>
        this.gates.hasActiveDebounceTimer(action),
      getActionId: (action) => this.getActionId(action),
      getSchedulingWrites: (action) =>
        this.writeIndex.getSchedulingWrites(action),
      getNextDebounceRunTime: (action) => this.getNextDebounceRunTime(action),
      getNextEligibleRunTime: (action) => this.getNextEligibleRunTime(action),
      isDemandedPullComputation: (action) =>
        this.isDemandedPullComputation(action),
      isLiveEffect: (action) => this.isLiveEffect(action),
      isPullDemandRootEffect: (action) => this.isPullDemandRootEffect(action),
      getPatternIdentity: (action) => {
        const annotated = action as Partial<TelemetryAnnotations>;
        return annotated.pattern
          ? this.runtime.patternManager.getArtifactEntryRef(annotated.pattern)
          : undefined;
      },
    };
  }

  // ============================================================
  // Private forwarding helpers
  // ============================================================

  /**
   * Gets a stable identifier for an action based on its source location.
   * Prefers .src (set as backup) over .name, falls back to a generated ID.
   * This ID is used for stats tracking to persist across action recreation.
   */
  private getActionId(action: Action | EventHandler): string {
    return getSchedulerActionId(this.actionIdentityState, action);
  }

  private isDemandedPullComputation(action: Action): boolean {
    const record = this.nodes.get(action);
    return record?.kind === "computation" &&
      isLive(this.dependencyGraphState, record);
  }

  private shouldRunFirstPullComputationInDemandContext(
    action: Action,
  ): boolean {
    const record = this.nodes.get(action);
    return record?.kind === "computation" &&
      record.status === "never-ran" &&
      record.provisionalDemand;
  }

  private isLiveEffect(action: Action): boolean {
    return this.nodes.get(action)?.kind === "effect";
  }

  private isLiveAction(action: Action): boolean {
    const record = this.nodes.get(action);
    return record !== undefined && isLive(this.dependencyGraphState, record);
  }

  private isPullDemandRootEffect(action: Action): boolean {
    const record = this.nodes.get(action);
    return record?.kind === "effect" &&
      (this.writeIndex.getSchedulingWrites(action)?.length ?? 0) === 0;
  }

  private isInvalidAction(action: Action): boolean {
    const record = this.nodes.get(action);
    return record?.status === "invalid" || record?.status === "never-ran";
  }

  private getNextEligibleRunTime(action: Action): number | undefined {
    return this.gates.getNextEligibleRunTime(action);
  }

  private markActionInvalid(
    action: Action,
    cause?: IMemorySpaceAddress,
  ): void {
    const record = this.nodes.get(action);
    if (!record) return;
    markInvalidRecord(this.nodes, action, cause);
    // Trailing computation debounce re-arms on every invalidation (§8.1:
    // debounceReadyAt resets while gated). Arming here — in the one
    // invalid-setter — covers every path (channel, registration, retry), so
    // gate QUERIES stay side-effect-free.
    if (record.kind === "computation") {
      this.gates.onInvalidated(
        record,
        performance.now(),
        this.createDebouncedComputationContext(),
      );
    }
  }

  private clearInvalidAction(action: Action): void {
    const record = this.nodes.get(action);
    if (!record) return;
    if (record.status === "invalid") {
      this.nodes.setStatus(action, "clean");
    }
    record.invalidCauses = [];
  }

  private markAndScheduleInvalidAction(
    action: Action,
    cause?: IMemorySpaceAddress,
  ): void {
    this.markActionInvalid(action, cause);

    if (this.nodes.effects.has(action) && this.gates.getDebounce(action)) {
      this.scheduleWithDebounce(action);
      return;
    }
    if (
      this.isLiveAction(action) ||
      this.materializers.isMaterializer(action) ||
      this.pending.has(action)
    ) {
      this.queueExecution();
    }
  }

  private collectInvalidUpstreamForLog(
    log: ReactivityLog,
    workSet: Set<Action>,
  ): boolean {
    return collectInvalidUpstreamForLogState(
      this.eventPreflightDependencyState,
      log,
      workSet,
    );
  }

  private collectPendingLoadParkKeys(
    event: QueuedEvent,
    log: ReactivityLog,
  ): string[] {
    const pendingLoadAddresses =
      this.runtime.storageManager.pendingLoadAddresses?.() ?? [];
    const keys = collectPendingLoadParkKeysState(
      this.eventPreflightDependencyState,
      pendingLoadAddresses,
      log,
    );
    if (keys.length === 0) return keys;
    const history = this.headEventLoadParkHistory;
    if (!history || history.eventId !== event.id) return keys;
    return keys.filter((key) => {
      const currentGeneration =
        this.runtime.storageManager.pendingLoadGeneration?.(key) ?? 0;
      const settledGeneration = history.generations.get(key);
      if (settledGeneration === undefined) return true;
      if (settledGeneration === currentGeneration) return false;
      return this.preflightPendingLoadGenerations.get(key) ===
        currentGeneration;
    });
  }

  private capturePendingLoadGenerations(): void {
    this.preflightPendingLoadGenerations.clear();
    for (
      const address of this.runtime.storageManager.pendingLoadAddresses?.() ??
        []
    ) {
      const key = entityKey(address);
      this.preflightPendingLoadGenerations.set(
        key,
        this.runtime.storageManager.pendingLoadGeneration?.(key) ?? 0,
      );
    }
  }

  private parkHeadEventForLoads(
    event: QueuedEvent,
    keys: readonly string[],
  ): void {
    if (this.headEventLoadPark?.eventId === event.id) return;
    const generations = new Map(
      keys.map((key) => [
        key,
        this.runtime.storageManager.pendingLoadGeneration?.(key) ?? 0,
      ]),
    );
    this.headEventLoadPark = { eventId: event.id, keys, generations };
    const settled = this.runtime.storageManager.loadsSettled?.(keys) ??
      Promise.resolve();
    settled.then(
      () => this.releaseHeadEventLoadPark(event.id),
      (error) => this.failHeadEventLoadPark(event, error),
    );
  }

  private releaseHeadEventLoadPark(eventId: string): void {
    if (this.headEventLoadPark?.eventId !== eventId) return;
    if (this.headEventLoadParkHistory?.eventId !== eventId) {
      this.headEventLoadParkHistory = { eventId, generations: new Map() };
    }
    for (const [key, generation] of this.headEventLoadPark.generations) {
      this.headEventLoadParkHistory.generations.set(key, generation);
    }
    this.headEventLoadPark = null;
    this.queueExecution();
  }

  private failHeadEventLoadPark(event: QueuedEvent, error: unknown): void {
    if (this.headEventLoadPark?.eventId !== event.id) return;
    this.headEventLoadPark = null;
    this.headEventLoadParkHistory = null;
    const detail = error instanceof Error ? error.message : String(error);
    this.dropEvent(
      event,
      `Event dropped: required replica load failed before dispatch (${detail})`,
    );
    this.queueExecution();
  }

  private dropEvent(event: QueuedEvent, reason: string): void {
    if (this.headEventLoadPark?.eventId === event.id) {
      this.headEventLoadPark = null;
    }
    if (this.headEventLoadParkHistory?.eventId === event.id) {
      this.headEventLoadParkHistory = null;
    }
    dropQueuedEvent(
      {
        runtime: this.runtime,
        eventQueue: this.eventQueue,
        releaseLineageEvent: (originTx, queuedEvent) => {
          this.lineage.release(originTx, queuedEvent);
        },
      },
      event,
      reason,
    );
  }

  private isHeadEventLoadParked(event: QueuedEvent): boolean {
    return this.headEventLoadPark?.eventId === event.id;
  }

  private hasLoadParkedHeadEvent(): boolean {
    const head = this.eventQueue[0];
    return head !== undefined && this.headEventLoadPark?.eventId === head.id;
  }

  private canAutomaticallyDebounce(action: Action): boolean {
    return this.gates.canAutomaticallyDebounce(action, {
      effects: this.nodes.effects,
    });
  }

  private collectPullIterationSeeds(workSet: Set<Action>): void {
    collectPullIterationSeedsState(this.pullSchedulingState, workSet);
  }

  private hasRunnablePullWork(): boolean {
    return hasRunnablePullWorkState(this.pullSchedulingState);
  }

  private hasIdleBlockingDeferredPullWork(): boolean {
    return hasIdleBlockingDeferredPullWorkState(this.pullSchedulingState);
  }

  private clearBackoffForCleanNodes(): void {
    let clearedDeadline = false;
    for (const record of this.nodes.nodes()) {
      if (record.status === "clean") {
        clearedDeadline = this.clearNodeBackoff(record) || clearedDeadline;
      }
    }
    if (clearedDeadline) this.gates.recomputeWakeAfterClear();
  }

  private clearNodeBackoff(record: SchedulerNode): boolean {
    return this.gates.clearBackoff(record);
  }

  private hasPendingLineageHeadEvent(): boolean {
    const head = this.eventQueue[0];
    if (head?.originTx === undefined) return false;
    if (this.lineage.originStatus(head.originTx) !== "pending") return false;
    return getCommitLocalSeq(head.originTx.tx, head.eventLink.space) ===
      undefined;
  }

  private updateMaterializerRegistration(action: Action): void {
    const record = this.nodes.get(action);
    const wasLive = record ? isLive(this.dependencyGraphState, record) : false;
    this.materializers.register(
      action,
      (action as Partial<TelemetryAnnotations>).materializerWriteEnvelopes,
    );
    notifyNodeLivenessChange(this.dependencyGraphState, action, wasLive);
  }

  private markProvisionalDemand(record: SchedulerNode): void {
    setNodeProvisionalDemand(
      this.dependencyGraphState,
      record,
      true,
      this.activePassId,
    );
    if (this.activePassId !== undefined) {
      this.provisionalDemandThisPass.add(record);
    }
  }

  private markNodeHasRun(action: Action): void {
    const record = this.nodes.get(action);
    if (!record) return;

    if (record.status === "never-ran") {
      this.nodes.setStatus(action, "clean");
    }

    if (
      record.provisionalDemand &&
      (record.provisionalDemandPass === undefined ||
        this.passCounter > record.provisionalDemandPass)
    ) {
      setNodeProvisionalDemand(this.dependencyGraphState, record, false);
    }
  }

  private clearProvisionalDemandAtPassEnd(): void {
    const passId = this.activePassId;
    if (passId === undefined) return;

    for (const record of this.provisionalDemandThisPass) {
      if (
        record.provisionalDemand &&
        record.provisionalDemandPass === passId &&
        record.status !== "never-ran"
      ) {
        setNodeProvisionalDemand(this.dependencyGraphState, record, false);
      }
    }
    this.provisionalDemandThisPass.clear();
  }

  private getNextDebounceRunTime(action: Action): number | undefined {
    // Same context as the waiting/schedule paths — the planner must agree
    // with them on the first-run debounce gate (shouldDebounceFirstRun), or a
    // scheduled debounce has no wake time.
    return this.gates.getNextDebounceRunTime(
      action,
      this.createDebouncedComputationContext(),
    );
  }

  private isDebouncedComputationWaiting(action: Action): boolean {
    return this.gates.isDebouncedComputationWaiting(
      action,
      this.createDebouncedComputationContext(),
    );
  }

  /**
   * Schedules an action with debounce support.
   * If the action has a debounce delay, it will wait before being added to pending.
   * Otherwise, it's added immediately.
   */
  private scheduleWithDebounce(action: Action): void {
    this.gates.scheduleWithDebounce(action, {
      pending: this.pending,
      queueExecution: () => this.queueExecution(),
      logDebounce: (message) =>
        logger.debug("schedule-debounce", () => [message]),
    });
  }

  /**
   * Checks if an action should be auto-debounced based on its performance stats.
   * Called after recording action time to potentially enable debouncing for slow actions.
   * Auto-debounce is enabled by default; use noDebounce to opt out.
   */
  private maybeAutoDebounce(action: Action): void {
    const update = this.gates.maybeAutoDebounce(action, {
      canAutomaticallyDebounce: (candidate) =>
        this.canAutomaticallyDebounce(candidate),
    });
    if (update) {
      logger.debug("schedule-debounce", () => [
        `[AUTO-DEBOUNCE] Action ${update.actionId} ` +
        `auto-debounced (avg ${
          update.averageTime.toFixed(1)
        }ms >= ${update.thresholdMs}ms)`,
      ]);
    }
  }

  private createDebouncedComputationContext() {
    return {
      computations: this.nodes.computations,
      effects: this.nodes.effects,
      isInvalid: (target: Action) => this.isInvalidAction(target),
      pending: this.pending,
      queueExecution: () => this.queueExecution(),
      logDebounce: (message: string) =>
        logger.debug("schedule-debounce", () => [message]),
      shouldDebounceFirstRun: (target: Action) => {
        const record = this.nodes.get(target);
        return record?.provisionalDemand === true &&
          record.status === "never-ran";
      },
    };
  }
}
