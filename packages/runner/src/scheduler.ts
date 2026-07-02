import { getLogger } from "@commonfabric/utils/logger";
import type { SchedulerActionSnapshotQuery } from "@commonfabric/memory/v2";
import type { Cancel } from "./cancel.ts";
import { ConsoleEvent } from "./harness/console.ts";
import type {
  ConsoleHandler,
  ErrorHandler,
  ErrorWithContext,
  Runtime,
} from "./runtime.ts";
import { type NormalizedFullLink } from "./link-utils.ts";
import type {
  ChangeGroup,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IStorageSubscription,
  MemorySpace,
  StorageNotification,
} from "./storage/interface.ts";
import {
  allowMutableTransactionRead,
  ignoreReadForScheduling,
  markReadAsAttemptedWrite,
} from "./storage/reactivity-log.ts";
import type {
  ActionStats,
  NonIdempotentReport,
  SchedulerDiagnosisResult,
  SchedulerGraphSnapshot,
} from "./telemetry.ts";
import {
  DEFAULT_RETRIES_FOR_EVENTS,
  MAX_SETTLE_STATS_HISTORY,
} from "./scheduler/constants.ts";
import {
  getPieceMetadataFromFrame,
  getSchedulerActionId,
  getSchedulerActionTelemetryInfo,
  handleSchedulerError,
  queueTask,
  recordTriggerTrace as recordTriggerTraceState,
  type SchedulerActionIdentityState,
} from "./scheduler/diagnostics.ts";
import {
  type DiagnosisRecord,
  runSchedulerDiagnosis,
  runSchedulerIdempotencyCheck,
  type SchedulerDiagnosisControlState,
  startSchedulerDiagnosis,
  stopSchedulerDiagnosis,
} from "./scheduler/diagnosis.ts";
import {
  type DependencyGraphState,
  hasDependentPath,
  isLive,
  notifyNodeLivenessChange,
  registerDependentsForWriterSurface,
  setNodeProvisionalDemand,
  updateDependentEdgesForLog,
} from "./scheduler/dependency-graph.ts";
import { SchedulerMaterializers } from "./scheduler/materializers.ts";
import { type DependencyUpdateState } from "./scheduler/dependency-updates.ts";
import { SchedulerWriteIndex } from "./scheduler/scheduling-writes.ts";
import { NodeRegistry, type SchedulerNode } from "./scheduler/node-record.ts";
import {
  SchedulerTriggerIndex,
  SchedulerTriggerSubscriptions,
  type TriggerSubscriptionState,
} from "./scheduler/trigger-index.ts";
import {
  collectDependenciesForAction as collectDependenciesForActionState,
  type DependencyCollectionState,
} from "./scheduler/dependency-collection.ts";
import {
  collectDirtyDependencies as collectDirtyDependenciesState,
  collectDirtyDependenciesForLog as collectDirtyDependenciesForLogState,
  collectDirtyDependenciesFromTraversalRoot
    as collectDirtyDependenciesFromTraversalRootState,
  type DirtyDependencyCollectionState,
  snapshotDirtyDependencyTraceContext,
} from "./scheduler/dirty-dependencies.ts";
import {
  runSchedulerAction,
  type SchedulerActionRunState,
  schedulerImplementationFingerprint,
  schedulerRuntimeFingerprint,
} from "./scheduler/action-run.ts";
import {
  buildPullInitialSeeds,
  collectInitialExecuteDependencies as collectInitialExecuteDependenciesState,
  collectPostEventDependencies as collectPostEventDependenciesState,
  createSettlingTracker,
  markExecuteStart,
  planPullAdaptiveCycleDebounce,
  pushBoundedHistory,
  recordExecuteEnd,
  type SchedulerSettleLoopState,
  type SchedulerSettleResult,
  type SettlingTracker,
} from "./scheduler/execution.ts";
import { runPullSchedulerSettleLoop } from "./scheduler/pull-execution.ts";
import {
  isSchedulerActionObservation,
  type PersistedSchedulerObservationSnapshot,
  type SchedulerActionObservation,
} from "./scheduler/persistent-observation.ts";
import {
  collectPullIterationSeeds as collectPullIterationSeedsState,
  conditionalEffectHasChangedInputs as conditionalEffectHasChangedInputsState,
  type DirtyPullRunnableState,
  type DirtyPullRunnableStateWithDebounce,
  hasDeferredDirtyEffectWork as hasDeferredDirtyEffectWorkState,
  hasRunnablePullWork as hasRunnablePullWorkState,
  markEffectConditionallyScheduled as markEffectConditionallyScheduledState,
  type PendingPullRunnableState,
  type PullSchedulingState,
  scheduleAffectedEffects as scheduleAffectedEffectsState,
} from "./scheduler/pull-scheduling.ts";
import {
  breakPullCyclesIfNeeded,
  type PullCycleBreakState,
} from "./scheduler/pull-cycle-break.ts";
import type { ExecuteContinuationState } from "./scheduler/continuation.ts";
import { applyPullExecuteContinuation } from "./scheduler/pull-continuation.ts";
import {
  canAutomaticallyDebounce as canAutomaticallyDebounceState,
  getNextDebounceRunTime as getNextDebounceRunTimeState,
  isDebouncedComputationWaiting as isDebouncedComputationWaitingState,
  maybeAutoDebounce as maybeAutoDebounceState,
  scheduleComputationDebounce as scheduleComputationDebounceState,
  type SchedulerDelayControlState,
  scheduleWithDebounce as scheduleWithDebounceState,
} from "./scheduler/delay-control.ts";
import { SchedulerDelays } from "./scheduler/delays.ts";
import {
  addCfcTriggerRead,
  type StorageNotificationState,
} from "./scheduler/notifications.ts";
import { processPullStorageNotification } from "./scheduler/pull-notifications.ts";
import {
  clearSchedulerDirectDirty,
  clearSchedulerDirty,
  type DirtySchedulingState,
  markSchedulerDirty,
  SchedulerStaleness,
} from "./scheduler/staleness.ts";
import {
  type SchedulerSubscribeActionState,
  type SchedulerSubscriptionState,
  type SchedulerUnsubscribeActionState,
  unsubscribeSchedulerAction,
} from "./scheduler/subscriptions.ts";
import {
  markReadersDirtyForChangedWrites,
  recordChangedComputationWrites,
  recordChangedWritesHistory,
  type WritePropagationState,
} from "./scheduler/write-propagation.ts";
import {
  resolveRegistrationSurface,
  resubscribePullSchedulerAction,
  subscribePullSchedulerAction,
} from "./scheduler/pull-subscriptions.ts";
import {
  type ActionTimingState,
  getActionStats as getActionStatsFromState,
} from "./scheduler/timing.ts";
import { getCommitLocalSeq } from "./storage/commit-identity.ts";
import {
  addSchedulerEventHandler,
  cancelEventQueueWake as cancelEventQueueWakeState,
  type EventQueueWakeState,
  hasEventQueueWakeTimer,
  isHeadEventParked as isHeadEventParkedState,
  queueSchedulerEvent,
  scheduleEventQueueWake as scheduleEventQueueWakeState,
  type SchedulerEventExecutionState,
  type SchedulerEventQueueState,
} from "./scheduler/events.ts";
import { SpeculationLineage } from "./scheduler/lineage.ts";
import { processPullQueuedEventDuringExecute } from "./scheduler/pull-events.ts";
import {
  buildSchedulerGraphSnapshot,
  type SchedulerGraphSnapshotState,
} from "./scheduler/graph-snapshot.ts";
import type {
  Action,
  ActionRunTraceEntry,
  DirtyDependencyTraceContext,
  EventHandler,
  PopulateDependencies,
  PopulateDependenciesEntry,
  QueuedEvent,
  ReactivityLog,
  SchedulerObservationIdentity,
  SettleStats,
  SettleStatsHistoryEntry,
  SpaceScopeAndURI,
  TelemetryAnnotations,
  TriggerTraceEntry,
  TriggerTraceScheduledEffect,
} from "./scheduler/types.ts";
import { ensureNotRenderThread } from "@commonfabric/utils/env";

ensureNotRenderThread();

const logger = getLogger("scheduler", {
  enabled: true,
  level: "warn",
});
const DEFAULT_INITIAL_REHYDRATION_TIMEOUT_MS = 10_000;

type PendingDependencyCollectionState =
  SchedulerSubscribeActionState["pendingDependencyCollectionState"];
type FilterStatsState = { filtered: number; executed: number };
type SchedulerStorageRehydrationOptions =
  & SchedulerObservationIdentity
  & {
    space: MemorySpace;
    timeoutMs?: number;
    // When the pattern is (re)started from a synced/resumed state, wait for the
    // space's storage to finish syncing before attempting rehydration / the
    // initial run. This avoids running consumers (map/filter/computed) against
    // not-yet-synced data and then re-running once it streams in.
    awaitSync?: boolean;
  };

// Defer an action's initial run until its space has finished syncing, without
// restoring any persisted scheduler observation. Used when persistent scheduler
// state is disabled and the pattern is resumed from a synced state: the action
// re-runs, but only once the space is synced, so it reads confirmed-loaded
// inputs.
type SchedulerAwaitSyncOptions = {
  space: MemorySpace;
  timeoutMs?: number;
};

// Re-export types that tests expect from scheduler
export type { ErrorWithContext };
export type {
  Action,
  ActionRunTraceAddress,
  ActionRunTraceEntry,
  AnnotatedAction,
  AnnotatedEventHandler,
  EventHandler,
  PopulateDependencies,
  ReactivityLog,
  SettleIterationStats,
  SettleStats,
  SettleStatsHistoryEntry,
  SpaceScopeAndURI,
  SpaceScopeURIAndType,
  TelemetryAnnotations,
  TriggerTraceActionRecord,
  TriggerTraceEntry,
  TriggerTraceScheduledEffect,
  TriggerTraceValueKind,
  TriggerTraceValueSummary,
} from "./scheduler/types.ts";
export { txToReactivityLog } from "./scheduler/reactivity.ts";

export {
  allowMutableTransactionRead,
  ignoreReadForScheduling,
  markReadAsAttemptedWrite,
};

export class Scheduler {
  private eventQueue: QueuedEvent[] = [];
  private eventHandlers: [NormalizedFullLink, EventHandler][] = [];
  readonly lineage = new SpeculationLineage({
    removeQueuedEvent: (event) => {
      const index = this.eventQueue.indexOf(event);
      if (index >= 0) this.eventQueue.splice(index, 1);
    },
    queueExecution: () => this.queueExecution(),
    onError: (error) => logger.error("lineage", () => [error]),
  });

  private pending = new Set<Action>();
  private dependencies = new WeakMap<Action, ReactivityLog>();
  private cancels = new WeakMap<Action, Cancel>();
  private triggerIndex = new SchedulerTriggerIndex();
  // Pending CFC trigger reads per dirtied action (§8.9.2): addresses whose
  // invalidating writes scheduled it, consumed by the action's next run.
  private cfcTriggerReads = new WeakMap<
    Action,
    { addresses: IMemorySpaceAddress[]; keys: Set<string> }
  >();
  private actionChangeGroups = new WeakMap<Action, ChangeGroup>();
  private retries = new WeakMap<Action, number>();

  // Effect/computation tracking for pull-based scheduling
  private nodes = new NodeRegistry();
  private dependents = new WeakMap<Action, Set<Action>>();
  private reverseDependencies = new WeakMap<Action, Set<Action>>();
  private passCounter = 0;
  private activePassId: number | undefined;
  private provisionalDemandThisPass = new Set<SchedulerNode>();
  // In pull mode, `dirty` means direct dirty. `stale` additionally includes
  // actions with dirty upstream computations.
  private staleness = new SchedulerStaleness({
    dependents: this.dependents,
  });

  // Debugger breakpoints: action IDs that should trigger `debugger` before execution
  private breakpoints = new Set<string>();

  // Compute time tracking for cycle-aware scheduling
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
  // Cycle detection during dependency collection
  private collectStack = new Set<Action>();
  private dirtyDependencyTraceContext?: DirtyDependencyTraceContext;

  // Cycle-aware debounce: track runs per action within current execute() call
  private runsThisExecute = new Map<Action, number>();
  private executeStartTime = 0;
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
  private eventQueueWakeState!: EventQueueWakeState;
  private eventQueueState!: SchedulerEventQueueState;
  private eventExecutionState!: SchedulerEventExecutionState;
  private delays = new SchedulerDelays({
    actionStats: this.actionStats,
    getActionId: (action) => this.getActionId(action),
  });
  private delayControlState!: SchedulerDelayControlState;

  private writeIndex!: SchedulerWriteIndex;
  private materializers = new SchedulerMaterializers(this.nodes.effects);
  private dirtyDependencyCollectionState!: DirtyDependencyCollectionState;
  // Track actions scheduled for first time (bypass filter)
  private scheduledFirstTime = new Set<Action>();
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
  private changedWritesHistory: IMemorySpaceAddress[] = [];
  private conditionallyScheduledEffects = new Map<Action, number>();
  private storageNotificationState!: StorageNotificationState;

  // Parent-child action tracking for proper execution ordering
  // When a child action is created during parent execution, parent must run first
  private executingAction: Action | null = null;
  currentActionId?: string;
  private dependencyGraphState!: DependencyGraphState;
  private dependencyUpdateState!: DependencyUpdateState;
  private triggerSubscriptionState!: TriggerSubscriptionState;
  private dirtySchedulingState!: DirtySchedulingState;
  private pendingPullRunnableState!: PendingPullRunnableState;
  private dirtyPullRunnableState!: DirtyPullRunnableState;
  private dirtyPullRunnableStateWithDebounce!:
    DirtyPullRunnableStateWithDebounce;
  private pullSchedulingState!: PullSchedulingState;
  private writePropagationState!: WritePropagationState;
  private subscriptionState!: SchedulerSubscriptionState;

  // Dependency population callbacks for first-time subscriptions
  // Called in execute() to discover what cells the action will read
  private populateDependenciesCallbacks = new WeakMap<
    Action,
    PopulateDependenciesEntry
  >();
  // Actions that need dependency population before first run
  private pendingDependencyCollection = new Set<Action>();
  private pendingDependencyCollectionState!: PendingDependencyCollectionState;
  private dependencyCollectionState!: DependencyCollectionState;
  private subscribeActionState!: SchedulerSubscribeActionState;
  private unsubscribeState!: SchedulerUnsubscribeActionState;

  private idlePromises: (() => void)[] = [];
  private backgroundTasks = new Set<Promise<unknown>>();
  // In-flight commits from user-intent event handlers (writes that changed
  // values). Event commits are issued fire-and-forget so the scheduler can keep
  // processing later events against the locally applied state while server
  // confirmation is in flight. The client-facing idle
  // (RuntimeProcessor.handleIdle) waits for these to settle so a just-issued
  // event write is durable before the client treats the runtime as quiescent —
  // a client that reads "idle" as a safe point to navigate or reload would
  // otherwise drop the in-flight commit when the page (and this worker) is torn
  // down. Distinct from backgroundTasks, which re-trigger scheduling.
  private pendingEventCommits = new Set<Promise<unknown>>();
  private initialRehydrationTokens = new WeakMap<Action, symbol>();
  private loopCounter = new WeakMap<Action, number>();
  private errorHandlers = new Set<ErrorHandler>();
  private consoleHandler: ConsoleHandler;
  private _running: Promise<unknown> | undefined = undefined;
  private scheduled = false;
  private disposed = false;
  private actionRunState!: SchedulerActionRunState;
  private graphSnapshotState!: SchedulerGraphSnapshotState;
  private cycleBreakState!: PullCycleBreakState;
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
   * The action will be scheduled to run immediately. Before running, the
   * populateDependencies callback will be called to discover what cells the
   * action will read. After running, the scheduler automatically re-subscribes
   * using the reactivity log from the run.
   *
   * @param action The action to subscribe
   * @param populateDependencies Callback to discover the action's read dependencies,
   *   or a ReactivityLog for backwards compatibility (deprecated)
   * @param options Configuration options for the subscription
   * @returns A cancel function to unsubscribe
   */
  subscribe(
    action: Action,
    populateDependencies: PopulateDependencies | ReactivityLog,
    options: {
      isEffect?: boolean;
      debounce?: number;
      noDebounce?: boolean;
      throttle?: number;
      changeGroup?: ChangeGroup;
      rehydrateFromStorage?: SchedulerStorageRehydrationOptions;
      awaitSyncBeforeInitialRun?: SchedulerAwaitSyncOptions;
    } = {},
  ): Cancel {
    const { rehydrateFromStorage, awaitSyncBeforeInitialRun } = options;
    if (rehydrateFromStorage) {
      this.setActionObservationIdentity(action, rehydrateFromStorage);
    }
    // Hold the initial run when either restoring persisted scheduler state
    // (rehydrate) or waiting for the space to finish syncing. Both defer so the
    // action's first execution reads confirmed-loaded inputs.
    const subscribeOptions = {
      isEffect: options.isEffect,
      debounce: options.debounce,
      noDebounce: options.noDebounce,
      throttle: options.throttle,
      changeGroup: options.changeGroup,
      deferInitialExecution: rehydrateFromStorage !== undefined ||
        awaitSyncBeforeInitialRun !== undefined,
    };
    this.updateMaterializerRegistration(action);
    const cancel = subscribePullSchedulerAction(
      this.subscribeActionState,
      action,
      populateDependencies,
      subscribeOptions,
    );
    if (rehydrateFromStorage) {
      this.queueInitialActionRehydration(action, rehydrateFromStorage);
    } else if (awaitSyncBeforeInitialRun) {
      this.queueInitialActionRunAfterSync(action, awaitSyncBeforeInitialRun);
    }
    return cancel;
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
    this.updateMaterializerRegistration(action);
    resubscribePullSchedulerAction(
      this.subscribeActionState,
      action,
      log,
      options,
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
      writes: observation.currentKnownWrites,
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
      // Static dependency setup ignores this in favor of the live annotation.
      writes: observation.currentKnownWrites,
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
      this.delays.setDebounce(action, actionOptions.debounceMs);
    }
    if (actionOptions?.noDebounce !== undefined) {
      this.delays.setNoDebounce(action, actionOptions.noDebounce);
    }
    if (actionOptions?.throttleMs !== undefined) {
      this.delays.setThrottle(action, actionOptions.throttleMs);
    }

    if (
      observation.status === "failed" ||
      snapshot.directDirtySeq !== undefined ||
      snapshot.staleSeq !== undefined ||
      snapshot.unknownReason !== undefined
    ) {
      this.staleness.markDirectDirty(action);
      this.pending.add(action);
      this.queueExecution();
      return true;
    }

    clearSchedulerDirectDirty(this.dirtySchedulingState, action);
    this.staleness.forceClearStale(action);
    this.pending.delete(action);
    this.pendingDependencyCollection.delete(action);
    this.scheduledFirstTime.delete(action);
    return true;
  }

  async rehydrateActionFromStorage(
    action: Action,
    space: MemorySpace,
    query: Omit<SchedulerActionSnapshotQuery, "actionId"> = {},
    options: {
      shouldApply?: () => boolean;
    } = {},
  ): Promise<boolean> {
    const provider = this.runtime.storageManager.open(space);
    const listSnapshots = provider.listSchedulerActionSnapshots;
    if (!listSnapshots) {
      return false;
    }

    const result = await listSnapshots.call(provider, {
      ...query,
      ownerSpace: query.ownerSpace ?? space,
      actionId: this.getActionId(action),
    });
    const snapshot = result.snapshots[0];
    if (!snapshot || !isSchedulerActionObservation(snapshot.observation)) {
      // Health counter: no persisted snapshot matched this action's id. On
      // reload this is the common reason an action re-runs instead of
      // rehydrating. Counts surface in getLoggerCounts().counts.scheduler.
      logger.debug("rehydrate/miss/no-snapshot", () => []);
      return false;
    }
    if (!this.observationMatchesCurrentAction(action, snapshot.observation)) {
      return false;
    }
    if (options.shouldApply && !options.shouldApply()) {
      logger.debug("rehydrate/skip/should-not-apply", () => []);
      return false;
    }

    logger.debug("rehydrate/ok", () => []);
    return this.rehydrateActionFromObservation(action, {
      observation: snapshot.observation,
      ...(snapshot.directDirtySeq !== undefined
        ? { directDirtySeq: snapshot.directDirtySeq }
        : {}),
      ...(snapshot.staleSeq !== undefined
        ? { staleSeq: snapshot.staleSeq }
        : {}),
      ...(snapshot.unknownReason !== undefined
        ? { unknownReason: snapshot.unknownReason }
        : {}),
    });
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

    const telemetry = getSchedulerActionTelemetryInfo(action);
    const matches = observation.implementationFingerprint ===
        schedulerImplementationFingerprint(action, actionId, telemetry) &&
      observation.runtimeFingerprint === schedulerRuntimeFingerprint("pull");
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

  private queueInitialActionRehydration(
    action: Action,
    options: SchedulerStorageRehydrationOptions,
  ): void {
    const token = Symbol("scheduler-initial-rehydration");
    this.initialRehydrationTokens.set(action, token);
    const task = (async () => {
      // The sync wait and the rehydration lookup share ONE timeout budget, so a
      // stuck sync can't double the resumed startup delay: each step is bounded
      // by the time remaining until this common deadline.
      const deadline = performance.now() +
        Math.max(
          0,
          options.timeoutMs ?? DEFAULT_INITIAL_REHYDRATION_TIMEOUT_MS,
        );
      const remainingMs = () => Math.max(0, deadline - performance.now());
      if (options.awaitSync) {
        // Resumed from a synced state: hold the initial rehydration/run until
        // the space has finished syncing so consumers don't race the data.
        await this.awaitSpaceSyncedWithTimeout(options.space, remainingMs());
        // The action may have been superseded while we waited for sync.
        if (!this.canApplyInitialActionRehydration(action, token)) return;
      }
      const rehydrated = await this.runInitialActionRehydrationWithTimeout(
        action,
        options.awaitSync ? { ...options, timeoutMs: remainingMs() } : options,
        token,
      );
      if (rehydrated === "timeout") {
        if (this.canApplyInitialActionRehydration(action, token)) {
          logger.warn("scheduler-rehydrate", () => [
            "Timed out rehydrating scheduler action; falling back to initial run",
            this.getActionId(action),
            options.timeoutMs ?? DEFAULT_INITIAL_REHYDRATION_TIMEOUT_MS,
          ]);
          this.initialRehydrationTokens.delete(action);
          logger.debug("rehydrate/fallback-run/timeout", () => []);
          this.scheduleInitialActionRun(action);
        }
        return;
      }
      if (!this.canApplyInitialActionRehydration(action, token)) {
        return;
      }
      if (!rehydrated) {
        logger.debug("rehydrate/fallback-run/no-match", () => []);
        this.scheduleInitialActionRun(action);
      }
    })().catch((error) => {
      logger.warn("scheduler-rehydrate", () => [
        "Failed to rehydrate scheduler action; falling back to initial run",
        this.getActionId(action),
        error,
      ]);
      if (!this.canApplyInitialActionRehydration(action, token)) {
        return;
      }
      this.scheduleInitialActionRun(action);
    });

    this.backgroundTasks.add(task);
    task.finally(() => {
      this.backgroundTasks.delete(task);
      if (this.initialRehydrationTokens.get(action) === token) {
        this.initialRehydrationTokens.delete(action);
      }
    });
  }

  // Defer an action's first run until its space has finished syncing, then
  // schedule it. No persisted observation is consulted (that is the rehydration
  // path); the action always runs, just once the space is synced so it derives
  // from confirmed-loaded inputs. A stuck sync is bounded by the timeout, after
  // which the action runs anyway. Shares the initial-rehydration token so a
  // superseding run cancels this deferral.
  private queueInitialActionRunAfterSync(
    action: Action,
    options: SchedulerAwaitSyncOptions,
  ): void {
    const token = Symbol("scheduler-initial-await-sync");
    this.initialRehydrationTokens.set(action, token);
    const task = (async () => {
      await this.awaitSpaceSyncedWithTimeout(options.space, options.timeoutMs);
      if (this.canApplyInitialActionRehydration(action, token)) {
        this.scheduleInitialActionRun(action);
      }
    })().catch((error) => {
      logger.warn("scheduler-rehydrate", () => [
        "Failed to await sync before initial run; running now",
        this.getActionId(action),
        error,
      ]);
      if (this.canApplyInitialActionRehydration(action, token)) {
        this.scheduleInitialActionRun(action);
      }
    });

    this.backgroundTasks.add(task);
    task.finally(() => {
      this.backgroundTasks.delete(task);
      if (this.initialRehydrationTokens.get(action) === token) {
        this.initialRehydrationTokens.delete(action);
      }
    });
  }

  // Wait for the space's storage replica to finish syncing, bounded by the
  // rehydration timeout so a stuck sync can't wedge the initial run forever.
  private async awaitSpaceSyncedWithTimeout(
    space: MemorySpace,
    timeoutMs?: number,
  ): Promise<void> {
    const provider = this.runtime.storageManager.open(space);
    const synced = provider?.synced?.bind(provider);
    if (!synced) return;
    const ms = Math.max(0, timeoutMs ?? DEFAULT_INITIAL_REHYDRATION_TIMEOUT_MS);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timeoutId = setTimeout(resolve, ms);
    });
    const syncedPromise = synced();
    // If the timeout wins the race the sync promise is left pending; swallow a
    // later rejection so it doesn't surface as an unhandled promise rejection.
    syncedPromise.catch(() => {});
    try {
      await Promise.race([syncedPromise, timeout]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  private async runInitialActionRehydrationWithTimeout(
    action: Action,
    options: SchedulerStorageRehydrationOptions,
    token: symbol,
  ): Promise<boolean | "timeout"> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs = Math.max(
      0,
      options.timeoutMs ?? DEFAULT_INITIAL_REHYDRATION_TIMEOUT_MS,
    );
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutId = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      return await Promise.race([
        this.rehydrateActionFromStorage(
          action,
          options.space,
          {
            ...(options.branch !== undefined ? { branch: options.branch } : {}),
            ownerSpace: options.ownerSpace ?? options.space,
            pieceId: options.pieceId,
            ...(options.processGeneration !== undefined
              ? { processGeneration: options.processGeneration }
              : {}),
          },
          {
            shouldApply: () =>
              this.canApplyInitialActionRehydration(action, token),
          },
        ),
        timeout,
      ]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  private canApplyInitialActionRehydration(
    action: Action,
    token: symbol,
  ): boolean {
    return this.initialRehydrationTokens.get(action) === token &&
      (this.nodes.effects.has(action) || this.nodes.computations.has(action)) &&
      !this.pending.has(action) &&
      !this.staleness.dirty.has(action);
  }

  private scheduleInitialActionRun(action: Action): void {
    if (
      !this.nodes.effects.has(action) && !this.nodes.computations.has(action)
    ) {
      return;
    }

    this.pendingDependencyCollection.add(action);
    this.staleness.markDirectDirty(action);
    this.pending.add(action);
    this.scheduledFirstTime.add(action);

    if (
      !this.nodes.isKnownEffect(action) &&
      this.writeIndex.getSchedulingWrites(action)?.length
    ) {
      this.scheduleAffectedEffects(action);
    }

    this.queueExecution();
  }

  unsubscribe(
    action: Action,
    options: { preserveChangeGroup?: boolean } = {},
  ): void {
    unsubscribeSchedulerAction(this.unsubscribeState, action, options);
    this.materializers.clearAction(action);
  }

  async run(action: Action): Promise<any> {
    return await runSchedulerAction(this.actionRunState, action);
  }

  idle(): Promise<void> {
    return this.#waitForQuiescence(false);
  }

  // Client-facing quiescence: reactive quiescence AND durability of in-flight
  // user-intent event commits. Event-handler commits are issued fire-and-forget
  // (events.ts), so plain idle() reports quiescence while such a commit is still
  // travelling to the server; a client that reads idle as a safe point to
  // navigate or reload would then drop that write when the page and its worker
  // are torn down. A landed commit also dirties readers of the committed write
  // (onEventCommitWrites), which can re-trigger scheduler work that produces
  // further commits, so durability and reactive quiescence are one joint
  // fixpoint. This reuses the same recursive convergence idle() uses — a pending
  // commit is just one more class of work to wait for — so there is no separate
  // retry loop and no round cap. It resolves exactly when the scheduler is
  // quiescent and no tracked commit is in flight, and (like idle()) never
  // resolves for a system that genuinely never settles.
  idleWithEventCommits(): Promise<void> {
    return this.#waitForQuiescence(true);
  }

  #waitForQuiescence(awaitEventCommits: boolean): Promise<void> {
    return new Promise<void>((resolve) => {
      // Re-evaluate every condition from scratch once the thing we are waiting
      // on settles.
      const recheck = () =>
        this.#waitForQuiescence(awaitEventCommits).then(resolve);
      // A parked waiter (idlePromises) resolves when the scheduler drains, but a
      // commit can still be in flight then, so the commit-aware variant re-checks
      // instead of resolving. That re-check is deferred to a microtask: it must
      // not re-enter #waitForQuiescence synchronously while resolveIdlePromises
      // is iterating idlePromises (draining runs before the scheduler marks
      // itself not-scheduled, so a synchronous re-check would push back into the
      // array mid-drain). The plain variant keeps the direct resolver.
      const park = awaitEventCommits ? () => queueMicrotask(recheck) : resolve;
      if (this.runningPromise) {
        // Something is currently running - wait for it then check again
        this.runningPromise.then(recheck);
      } else if (this.backgroundTasks.size > 0) {
        // Async scheduler work, such as event-triggered auto-start, is still in
        // flight. Wait for it to settle and then re-check the scheduler state.
        Promise.allSettled([...this.backgroundTasks]).then(recheck);
      } else if (awaitEventCommits && this.pendingEventCommits.size > 0) {
        // In-flight user-intent event commits. Wait for them to settle (server
        // confirmation or terminal failure) and then re-check: a landed commit
        // can dirty readers and re-trigger scheduler work.
        Promise.allSettled([...this.pendingEventCommits]).then(recheck);
      } else if (
        hasEventQueueWakeTimer(this.eventQueueWakeState) &&
        ((this.eventQueue.length > 0 &&
          isHeadEventParkedState(this.eventQueueWakeState)) ||
          this.hasDeferredDirtyEffectWork())
      ) {
        // A queued event is parked behind a throttled dependency. Wait for the
        // wake timer to re-schedule the queue and then re-check.
        this.idlePromises.push(park);
      } else if (this.hasPendingLineageHeadEvent()) {
        // A cross-space lineage head has no timer; its origin commit callback
        // is the wake source, so idle must stay open until that callback runs.
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
        resolve();
      } else {
        // Execution is scheduled - wait for it to complete
        this.idlePromises.push(park);
      }
    });
  }

  /**
   * Register an in-flight user-intent event-handler commit so the client-facing
   * idle can wait for it to become durable. Normalized to always resolve and
   * auto-removed once it settles, so a rejecting commit is safe and never leaks.
   */
  trackEventCommit(promise: Promise<unknown>): void {
    const tracked = promise.then(() => {}, () => {});
    this.pendingEventCommits.add(tracked);
    tracked.finally(() => this.pendingEventCommits.delete(tracked));
  }

  /**
   * Whether any user-intent event commit is still in flight. Introspection for
   * tests and diagnostics; the wait itself lives in idleWithEventCommits().
   */
  hasPendingEventCommits(): boolean {
    return this.pendingEventCommits.size > 0;
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
    retries: number = DEFAULT_RETRIES_FOR_EVENTS,
    // Internal-only commit callback. This runs after the final commit result,
    // including exhausted failure, so it must not perform external side
    // effects. Use the post-commit outbox for success-only effect release.
    onCommit?: (tx: IExtendedStorageTransaction) => void,
    doNotLoadPieceIfNotRunning: boolean = false,
    opts: { eventId?: string; originTx?: IExtendedStorageTransaction } = {},
  ): void {
    queueSchedulerEvent(this.eventQueueState, {
      eventLink,
      event,
      retries,
      onCommit,
      doNotLoadPieceIfNotRunning,
      eventId: opts.eventId,
      originTx: opts.originTx,
    });
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
    this.delays.setDebounce(action, ms);
  }

  /**
   * Gets the current debounce delay for an action, if set.
   */
  getDebounce(action: Action): number | undefined {
    return this.delays.getDebounce(action);
  }

  /**
   * Clears the debounce setting for an action.
   */
  clearDebounce(action: Action): void {
    this.delays.clearDebounce(action);
  }

  /**
   * Enables or disables auto-debounce detection for an action.
   * When set to true, this action opts OUT of auto-debounce.
   * By default, slow actions (> 50ms avg after 3 runs) will automatically get debounced.
   */
  setNoDebounce(action: Action, optOut: boolean): void {
    this.delays.setNoDebounce(action, optOut);
  }

  // ============================================================
  // Throttle infrastructure - "value can be stale by T ms"
  // ============================================================

  /**
   * Sets a throttle period for an action.
   * The action won't run if it ran within the last `ms` milliseconds.
   * Unlike debounce, throttled actions stay dirty and will be pulled
   * by effects when the throttle period expires. Event handlers whose head
   * dependencies are throttled are parked until the earliest eligible wake time.
   */
  setThrottle(action: Action, ms: number): void {
    this.delays.setThrottle(action, ms);
  }

  /**
   * Gets the current throttle period for an action, if set.
   */
  getThrottle(action: Action): number | undefined {
    return this.delays.getThrottle(action);
  }

  /**
   * Clears the throttle setting for an action.
   */
  clearThrottle(action: Action): void {
    this.delays.clearThrottle(action);
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
    return this.staleness.dirty.has(action);
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
   * Disabling also clears the last collected stats to avoid stale reads.
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
   * Disabling clears the current ring buffer to avoid stale reads.
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
   * Disabling clears the current ring buffer to avoid stale reads.
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
    this.disposed = true;
    // Clear all active debounce timers
    this.delays.clearActiveDebounceTimers();
    if (this.pendingQueueTaskTimer !== null) {
      clearTimeout(this.pendingQueueTaskTimer);
      this.pendingQueueTaskTimer = null;
    }
    this.triggerIndex.clear();
    cancelEventQueueWakeState(this.eventQueueWakeState);
    // Clean up diagnosis state
    if (this.diagnosisTimeout) {
      clearTimeout(this.diagnosisTimeout);
      this.diagnosisTimeout = null;
    }
    this.diagnosisEnabled = false;
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
    const { newActionsWithoutDependencies } = this
      .collectInitialExecuteDependencies();
    const eventBlockingDeps = await this.processExecuteEventPhase();
    this.collectPostEventDependencies();
    const initialSeeds = this.buildInitialExecuteSeeds(
      newActionsWithoutDependencies,
      eventBlockingDeps,
    );

    const settleResult = await this.runSettleLoop(initialSeeds);
    await breakPullCyclesIfNeeded(this.cycleBreakState, settleResult);
    this.applyAdaptiveCycleDebounce();
    this.recordExecuteEndTelemetry();
    this.applyExecuteContinuation();
    logger.timeEnd("scheduler", "execute");
  }

  private beginExecuteCycle(): void {
    // Track timing for cycle-aware debounce
    this.executeStartTime = performance.now();
    this.runsThisExecute.clear();
    this.activePassId = ++this.passCounter;
    this.provisionalDemandThisPass.clear();

    // Non-settling heuristic: record execute() start
    markExecuteStart(this.settlingTracker);
  }

  private collectInitialExecuteDependencies(): {
    newActionsWithoutDependencies: Action[];
  } {
    return collectInitialExecuteDependenciesState({
      pendingDependencyCollection: this.pendingDependencyCollection,
      populateDependenciesCallbacks: this.populateDependenciesCallbacks,
      effects: this.nodes.effects,
      getSchedulingWrites: (action) =>
        this.writeIndex.getSchedulingWrites(action),
      collectDependenciesForAction: (action, populateDependencies, options) =>
        this.collectDependenciesForAction(
          action,
          populateDependencies,
          options,
        ),
      getActionId: (action) => this.getActionId(action),
      scheduleAffectedEffects: (action) => this.scheduleAffectedEffects(action),
    });
  }

  private async processExecuteEventPhase(): Promise<Set<Action>> {
    // Track dirty dependencies that block events - these must be added to workSet
    const eventBlockingDeps = new Set<Action>();

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

  private collectPostEventDependencies(): void {
    collectPostEventDependenciesState({
      pendingDependencyCollection: this.pendingDependencyCollection,
      populateDependenciesCallbacks: this.populateDependenciesCallbacks,
      effects: this.nodes.effects,
      getSchedulingWrites: (action) =>
        this.writeIndex.getSchedulingWrites(action),
      collectDependenciesForAction: (action, populateDependencies, options) =>
        this.collectDependenciesForAction(
          action,
          populateDependencies,
          options,
        ),
      getActionId: (action) => this.getActionId(action),
    });
  }

  private buildInitialExecuteSeeds(
    newActionsWithoutDependencies: Iterable<Action>,
    eventBlockingDeps: Iterable<Action>,
  ): Set<Action> {
    // Build initial seeds for pull mode (effects + special actions).
    return buildPullInitialSeeds({
      pending: this.pending,
      dirty: this.staleness.dirty,
      effects: this.nodes.effects,
      newActionsWithoutDependencies,
      eventBlockingDeps,
      computationDebounceFlushSeeds: this.delays.computationDebounceFlushSeeds,
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

    this.clearProvisionalDemandAtPassEnd();
    this.activePassId = undefined;

    return settleResult;
  }

  private applyExecuteContinuation(): void {
    applyPullExecuteContinuation(this.executeContinuationState);
  }

  private applyAdaptiveCycleDebounce(): void {
    // Apply cycle-aware debounce to effects that ran multiple times this execute().
    // Pull computations are already demand-gated; debouncing them can leave a
    // live renderer observing stale materialized data until an arbitrary timer
    // fires.
    const cycleDebouncePlan = planPullAdaptiveCycleDebounce({
      executeStartTime: this.executeStartTime,
      runsThisExecute: this.runsThisExecute,
      canAutomaticallyDebounce: (action) =>
        this.canAutomaticallyDebounce(
          action,
        ),
      getCurrentDebounce: (action) => this.delays.getDebounce(action),
    });
    for (
      const { action, runs, delayMs } of cycleDebouncePlan.updates
    ) {
      this.delays.setDebounce(action, delayMs);
      logger.debug("schedule-cycle-debounce", () => [
        `[CYCLE-DEBOUNCE] Action ${this.getActionId(action)} ` +
        `ran ${runs}x in ${cycleDebouncePlan.elapsedMs.toFixed(1)}ms, ` +
        `setting debounce to ${delayMs}ms`,
      ]);
    }
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

  private collectDependenciesForAction(
    action: Action,
    populateDependencies: PopulateDependenciesEntry,
    options: {
      errorLogLabel: string;
      errorMessage: (action: Action, error: unknown) => string;
      updateDependents?: boolean;
      useRawReadsForTriggers?: boolean;
    },
  ): { log: ReactivityLog; entities: Set<SpaceScopeAndURI> } {
    return collectDependenciesForActionState(
      this.dependencyCollectionState,
      action,
      populateDependencies,
      options,
    );
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
    this.eventQueueWakeState = this.createEventQueueWakeState();
    this.writeIndex = this.createWriteIndex();
    this.delayControlState = this.createDelayControlState();
    this.dirtyDependencyCollectionState = this
      .createDirtyDependencyCollectionState();
    this.dependencyGraphState = this.createDependencyGraphState();
    this.dependencyUpdateState = this.createDependencyUpdateState();
    this.triggerSubscriptionState = this.createTriggerSubscriptionState();
    this.dirtySchedulingState = this.createDirtySchedulingState();
    this.storageNotificationState = this.createStorageNotificationState();
    this.pendingPullRunnableState = this.createPendingPullRunnableState();
    this.dirtyPullRunnableState = this.createDirtyPullRunnableState();
    this.dirtyPullRunnableStateWithDebounce = this
      .createDirtyPullRunnableStateWithDebounce();
    this.pullSchedulingState = this.createPullSchedulingState();
    this.writePropagationState = this.createWritePropagationState();
    this.subscriptionState = this.createSubscriptionState();
    this.pendingDependencyCollectionState = this
      .createPendingDependencyCollectionState();
    this.subscribeActionState = this.createSubscribeActionState();
    this.unsubscribeState = this.createUnsubscribeState();
    this.cycleBreakState = this.createCycleBreakState();
    this.settleLoopState = this.createSettleLoopState();
    this.executeContinuationState = this.createExecuteContinuationState();
    this.eventQueueState = this.createEventQueueState();
    this.eventExecutionState = this.createEventExecutionState();
    this.dependencyCollectionState = this.createDependencyCollectionState();
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

  private createEventQueueWakeState(): EventQueueWakeState {
    return {
      timer: null,
      wakeAt: null,
      eventQueue: this.eventQueue,
      isDisposed: () => this.disposed,
      queueExecution: () => this.queueExecution(),
    };
  }

  private createWriteIndex(): SchedulerWriteIndex {
    return new SchedulerWriteIndex();
  }

  private createDelayControlState(): SchedulerDelayControlState {
    return {
      delays: this.delays,
      computations: this.nodes.computations,
      effects: this.nodes.effects,
      dirty: this.staleness.dirty,
      pending: this.pending,
      queueExecution: () => this.queueExecution(),
      logDebounce: (message) =>
        logger.debug("schedule-debounce", () => [message]),
      shouldDebounceFirstRun: (action) => {
        const record = this.nodes.get(action);
        return record?.provisionalDemand === true &&
          record.status === "never-ran";
      },
    };
  }

  private createDirtyDependencyCollectionState(): DirtyDependencyCollectionState {
    return {
      collectStack: this.collectStack,
      getTrace: () => this.dirtyDependencyTraceContext,
      dirty: this.staleness.dirty,
      pending: this.pending,
      computations: this.nodes.computations,
      reverseDependencies: this.reverseDependencies,
      dependencies: this.dependencies,
      writersByEntity: this.writeIndex.writersByEntity,
      effects: this.nodes.effects,
      materializerIndex: this.materializers,
      isStale: (target) => this.staleness.isStale(target),
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
      staleness: this.staleness,
      nodes: this.nodes,
      materializerIndex: this.materializers,
      getSchedulingWrites: (action) =>
        this.writeIndex.getSchedulingWrites(action),
      isStale: (action) => this.staleness.isStale(action),
      queueExecution: () => this.queueExecution(),
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

  private createDirtySchedulingState(): DirtySchedulingState {
    return {
      staleness: this.staleness,
      computations: this.nodes.computations,
      scheduleComputationDebounce: (action) =>
        this.scheduleComputationDebounce(action),
      clearComputationDebounceState: (action) =>
        this.delays.clearComputationDebounceState(action),
      isLiveComputation: (action) => this.isDemandedPullComputation(action),
      materializerIndex: this.materializers,
      queueExecution: () => this.queueExecution(),
    };
  }

  private createStorageNotificationState(): StorageNotificationState {
    return {
      triggerIndex: this.triggerIndex,
      cfcTriggerReads: this.cfcTriggerReads,
      getDiagnosisEnabled: () => this.diagnosisEnabled,
      getCollectTriggerTrace: () => this.collectTriggerTrace,
      changeGroupToActionId: this.changeGroupToActionId,
      recordCausalEdge: (edge) => {
        this.causalEdges.push(edge);
      },
      actionChangeGroups: this.actionChangeGroups,
      effects: this.nodes.effects,
      pending: this.pending,
      dirty: this.staleness.dirty,
      conditionallyScheduledEffects: this.conditionallyScheduledEffects,
      getActionId: (target) => this.getActionId(target),
      recordCellUpdate: (change) =>
        this.runtime.telemetry.submit({
          type: "cell.update",
          change,
        }),
      recordTriggerTrace: (entry) =>
        recordTriggerTraceState({ triggerTrace: this.triggerTrace }, entry),
      scheduleWithDebounce: (target) => this.scheduleWithDebounce(target),
      markDirty: (target) =>
        markSchedulerDirty(this.dirtySchedulingState, target),
      materializerIndex: this.materializers,
      queueExecution: () => this.queueExecution(),
      scheduleAffectedEffects: (target) => this.scheduleAffectedEffects(target),
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
    processPullStorageNotification(
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
      isThrottled: (action) => this.delays.isThrottled(action),
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
      changedWritesHistory: this.changedWritesHistory,
      conditionallyScheduledEffects: this.conditionallyScheduledEffects,
      dependencies: this.dependencies,
      pending: this.pending,
      dirty: this.staleness.dirty,
      effects: this.nodes.effects,
      materializerIndex: this.materializers,
      dependents: this.dependents,
      pendingPullRunnableState: this.pendingPullRunnableState,
      dirtyPullRunnableState: this.dirtyPullRunnableState,
      dirtyPullRunnableStateWithDebounce: this
        .dirtyPullRunnableStateWithDebounce,
      getDebounce: (action) => this.delays.getDebounce(action),
      scheduleWithDebounce: (action) => this.scheduleWithDebounce(action),
      getActionId: (action) => this.getActionId(action),
    };
  }

  private createWritePropagationState(): WritePropagationState {
    return {
      triggerIndex: this.triggerIndex,
      changedWritesHistory: this.changedWritesHistory,
      effects: this.nodes.effects,
      computations: this.nodes.computations,
      conditionallyScheduledEffects: this.conditionallyScheduledEffects,
      nodes: this.nodes,
      pending: this.pending,
      markPullDemandContinuation: (action) =>
        this.markPullDemandContinuation(action),
      scheduleWithDebounce: (action) => this.scheduleWithDebounce(action),
      markDirty: (action) =>
        markSchedulerDirty(this.dirtySchedulingState, action),
      materializerIndex: this.materializers,
      scheduleAffectedEffects: (action) => {
        this.scheduleAffectedEffects(action);
      },
      queueExecution: () => this.queueExecution(),
    };
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

  private createPendingDependencyCollectionState(): PendingDependencyCollectionState {
    return {
      pendingDependencyCollection: this.pendingDependencyCollection,
      effects: this.nodes.effects,
      isThrottled: (action) => this.delays.isThrottled(action),
      getSchedulingWrites: (action) =>
        this.writeIndex.getSchedulingWrites(action),
      hasDependentPath: (from, to) =>
        hasDependentPath(this.dependents, from, to),
    };
  }

  private createSubscribeActionState(): SchedulerSubscribeActionState {
    return {
      subscriptionState: this.subscriptionState,
      dependencyUpdateState: this.dependencyUpdateState,
      triggerSubscriptionState: this.triggerSubscriptionState,
      pendingDependencyCollectionState: this.pendingDependencyCollectionState,
      populateDependenciesCallbacks: this.populateDependenciesCallbacks,
      pendingDependencyCollection: this.pendingDependencyCollection,
      markProvisionalDemand: (record) => this.markProvisionalDemand(record),
      pending: this.pending,
      scheduledFirstTime: this.scheduledFirstTime,
      effects: this.nodes.effects,
      dirty: this.staleness.dirty,
      stale: this.staleness.stale,
      writeIndex: this.writeIndex,
      setDebounce: (action, ms) => this.setDebounce(action, ms),
      setNoDebounce: (action, optOut) => this.setNoDebounce(action, optOut),
      setThrottle: (action, ms) => this.setThrottle(action, ms),
      getSchedulingWrites: (action) =>
        this.writeIndex.getSchedulingWrites(action),
      isThrottled: (action) => this.delays.isThrottled(action),
      isStale: (action) => this.staleness.isStale(action),
      markDirectDirty: (action) => {
        this.staleness.markDirectDirty(action);
      },
      markEffectConditionallyScheduled: (action) =>
        this.markEffectConditionallyScheduled(action),
      updateDependents: (action, log) => this.updateDependents(action, log),
      registerWriterDependents: (action, writes) =>
        registerDependentsForWriterSurface(
          this.dependencyGraphState,
          action,
          writes,
        ),
      scheduleAffectedEffects: (action) => this.scheduleAffectedEffects(action),
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
      cfcTriggerReads: this.cfcTriggerReads,
      actionChangeGroups: this.actionChangeGroups,
      changeGroupToActionId: this.changeGroupToActionId,
      pending: this.pending,
      conditionallyScheduledEffects: this.conditionallyScheduledEffects,
      reverseDependencies: this.reverseDependencies,
      dependents: this.dependents,
      dependencyGraphState: this.dependencyGraphState,
      nodes: this.nodes,
      writeIndex: this.writeIndex,
      populateDependenciesCallbacks: this.populateDependenciesCallbacks,
      pendingDependencyCollection: this.pendingDependencyCollection,
      getActionId: (target) => this.getActionId(target),
      clearDirectDirty: (target) =>
        clearSchedulerDirectDirty(this.dirtySchedulingState, target),
      forceClearStale: (target) => this.staleness.forceClearStale(target),
      cancelDebounceTimer: (target) => this.delays.cancelDebounceTimer(target),
      clearComputationDebounceState: (target, targetOptions) =>
        this.delays.clearComputationDebounceState(target, targetOptions),
    };
  }

  private createCycleBreakState(): PullCycleBreakState {
    return {
      dirty: this.staleness.dirty,
      effects: this.nodes.effects,
      runsThisExecute: this.runsThisExecute,
      pending: this.pending,
      isThrottled: (action) => this.delays.isThrottled(action),
      clearDirty: (action) =>
        clearSchedulerDirty(this.dirtySchedulingState, action),
      unsubscribe: (action) => this.unsubscribe(action),
      recordExecuted: () => {
        this.filterStats.executed++;
      },
      getActionId: (action) => this.getActionId(action),
      runAction: (action) => this.run(action),
    };
  }

  private createSettleLoopState(): SchedulerSettleLoopState {
    return {
      getCollectSettleStats: () => this.collectSettleStats,
      pendingDependencyCollection: this.pendingDependencyCollection,
      populateDependenciesCallbacks: this.populateDependenciesCallbacks,
      effects: this.nodes.effects,
      computations: this.nodes.computations,
      pending: this.pending,
      dirty: this.staleness.dirty,
      dependencies: this.dependencies,
      nodes: this.nodes,
      dependents: this.dependents,
      conditionallyScheduledEffects: this.conditionallyScheduledEffects,
      filterStats: this.filterStats,
      getLoopCounter: () => this.loopCounter,
      runsThisExecute: this.runsThisExecute,
      materializerIndex: this.materializers,
      getSchedulingWrites: (action) =>
        this.writeIndex.getSchedulingWrites(action),
      getSchedulingWritesMap: () => this.writeIndex.getSchedulingWritesMap(),
      collectDependenciesForAction: (action, populateDependencies, options) =>
        this.collectDependenciesForAction(
          action,
          populateDependencies,
          options,
        ),
      collectPullIterationSeeds: (seeds) =>
        this.collectPullIterationSeeds(seeds),
      collectDirtyDependencies: (seed, targetWorkSet, memo) =>
        this.collectDirtyDependencies(seed, targetWorkSet, memo),
      collectDirtyDependenciesFromTraversalRoot: (
        seed,
        targetWorkSet,
        memo,
      ) =>
        this.collectDirtyDependenciesFromTraversalRoot(
          seed,
          targetWorkSet,
          memo,
        ),
      getActionId: (action) => this.getActionId(action),
      clearDirty: (action) =>
        clearSchedulerDirty(this.dirtySchedulingState, action),
      markDirectDirty: (action) => this.staleness.markDirectDirty(action),
      isThrottled: (action) => this.delays.isThrottled(action),
      isDebouncedComputationWaiting: (action) =>
        this.isDebouncedComputationWaiting(action),
      clearComputationDebounceState: (action) =>
        this.delays.clearComputationDebounceState(action),
      conditionalEffectHasChangedInputs: (action) =>
        this.conditionalEffectHasChangedInputs(action),
      handleError: (error, action) => this.handleError(error, action),
      runAction: (action) => this.run(action),
    };
  }

  private createExecuteContinuationState(): ExecuteContinuationState {
    return {
      pending: this.pending,
      dirty: this.staleness.dirty,
      effects: this.nodes.effects,
      eventQueue: this.eventQueue,
      eventQueueWakeState: this.eventQueueWakeState,
      idlePromises: this.idlePromises,
      scheduledFirstTime: this.scheduledFirstTime,
      conditionallyScheduledEffects: this.conditionallyScheduledEffects,
      changedWritesHistory: this.changedWritesHistory,
      consumeRerunAfterCurrentExecute: () => {
        const shouldRerun = this.rerunAfterCurrentExecute;
        this.rerunAfterCurrentExecute = false;
        return shouldRerun;
      },
      isDemandedPullComputation: (action) =>
        this.isDemandedPullComputation(action),
      materializerIndex: this.materializers,
      shouldRunFirstPullComputationInDemandContext: (action) =>
        this.shouldRunFirstPullComputationInDemandContext(action),
      isDebouncedComputationWaiting: (action) =>
        this.isDebouncedComputationWaiting(action),
      getNextDebounceRunTime: (action) => this.getNextDebounceRunTime(action),
      getNextEligibleRunTime: (action) =>
        this.delays.getNextEligibleRunTime(action),
      hasPendingLineageHeadEvent: () => this.hasPendingLineageHeadEvent(),
      resetLoopCounter: () => {
        this.loopCounter = new WeakMap();
      },
      setScheduled: (scheduled) => {
        this.scheduled = scheduled;
      },
      resetSettlingTracker: () => {
        this.settlingTracker = createSettlingTracker();
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
      queueExecution: () => this.queueExecution(),
      queueEvent: (
        targetEventLink,
        targetEvent,
        targetRetries,
        targetOnCommit,
        targetDoNotLoad,
        targetOpts,
      ) =>
        this.queueEvent(
          targetEventLink,
          targetEvent,
          targetRetries,
          targetOnCommit,
          targetDoNotLoad,
          targetOpts,
        ),
      recordLineageEvent: (originTx, queuedEvent) => {
        this.lineage.recordEvent(originTx, queuedEvent);
      },
    };
  }

  private createEventExecutionState(): SchedulerEventExecutionState {
    const getEventPreflightTelemetryEnabled = () =>
      this.eventPreflightTelemetryEnabled;
    return {
      runtime: this.runtime,
      eventQueue: this.eventQueue,
      dirty: this.staleness.dirty,
      pending: this.pending,
      backpressure: this.runtime.commitBackpressure,
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
      setDirtyDependencyTraceContext: (trace) => {
        this.dirtyDependencyTraceContext = trace;
      },
      collectDirtyDependenciesForLog: (deps, dirtyDeps, dirtyDepMemo) =>
        this.collectDirtyDependenciesForLog(
          deps,
          dirtyDeps,
          dirtyDepMemo,
        ),
      isDebouncedComputationWaiting: (target) =>
        this.isDebouncedComputationWaiting(target),
      getNextDebounceRunTime: (target) => this.getNextDebounceRunTime(target),
      getNextEligibleRunTime: (target) =>
        this.delays.getNextEligibleRunTime(target),
      scheduleEventQueueWake: (notBefore) =>
        scheduleEventQueueWakeState(this.eventQueueWakeState, notBefore),
      lineageStatus: (originTx) => this.lineage.originStatus(originTx),
      releaseLineageEvent: (originTx, queuedEvent) => {
        this.lineage.release(originTx, queuedEvent);
      },
      recordLineageEvent: (originTx, queuedEvent) => {
        this.lineage.recordEvent(originTx, queuedEvent);
      },
      getOriginLocalSeq: (originTx, targetSpace) =>
        getCommitLocalSeq(originTx.tx, targetSpace),
      snapshotDirtyDependencyTraceContext: (trace) =>
        snapshotDirtyDependencyTraceContext(
          this.dirtyDependencyCollectionState,
          trace,
        ),
      onEventCommitWrites: (sourceAction, writes) => {
        recordChangedWritesHistory(this.writePropagationState, writes);
        markReadersDirtyForChangedWrites(
          this.writePropagationState,
          sourceAction,
          writes,
        );
      },
    };
  }

  private createDependencyCollectionState(): DependencyCollectionState {
    return {
      runtime: this.runtime,
      dependencyUpdateState: this.dependencyUpdateState,
      triggerSubscriptionState: this.triggerSubscriptionState,
      updateDependents: (action, log) => this.updateDependents(action, log),
    };
  }

  private createActionRunState(): SchedulerActionRunState {
    return {
      runtime: this.runtime,
      takeCfcTriggerReads: (target) => {
        const pending = this.cfcTriggerReads.get(target);
        if (pending === undefined) {
          return undefined;
        }
        this.cfcTriggerReads.delete(target);
        return pending.addresses;
      },
      restoreCfcTriggerReads: (target, addresses) => {
        for (const address of addresses) {
          addCfcTriggerRead(
            { cfcTriggerReads: this.cfcTriggerReads },
            target,
            address,
          );
        }
      },
      actionChangeGroups: this.actionChangeGroups,
      actionTimingState: this.actionTimingState,
      retries: this.retries,
      pending: this.pending,
      actionRunTrace: this.actionRunTrace,
      nodes: this.nodes,
      diagnosisHistory: this.diagnosisHistory,
      diagnosisNonIdempotent: this.diagnosisNonIdempotent,
      idempotencyViolations: this.idempotencyViolations,
      getRunningPromise: () => this.runningPromise,
      setRunningPromise: (promise) => {
        this.runningPromise = promise;
      },
      modeLabel: () => "pull",
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
      getDebounce: (target) => this.delays.getDebounce(target),
      getNoDebounce: (target) => this.delays.getNoDebounce(target),
      getThrottle: (target) => this.delays.getThrottle(target),
      maybeAutoDebounce: (target) => this.maybeAutoDebounce(target),
      markActionHasRun: (target) => {
        this.delays.markActionHasRun(target);
        this.initialRehydrationTokens.delete(target);
      },
      markNodeHasRun: (target) => this.markNodeHasRun(target),
      handleError: (error, target) => this.handleError(error, target),
      resubscribe: (target, log) => this.resubscribe(target, log),
      markDirectDirty: (target) => this.staleness.markDirectDirty(target),
      recordChangedComputationWrites: (target, tx, log) => {
        return recordChangedComputationWrites(
          this.writePropagationState,
          target,
          tx,
          log,
        );
      },
      markReadersDirtyForChangedWrites: (target, changedWrites) => {
        if (!this.nodes.computations.has(target)) return;
        clearSchedulerDirectDirty(this.dirtySchedulingState, target);
        markReadersDirtyForChangedWrites(
          this.writePropagationState,
          target,
          changedWrites,
        );
      },
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
      pullMode: true,
      effects: this.nodes.effects,
      computations: this.nodes.computations,
      pending: this.pending,
      dirty: this.staleness.dirty,
      conditionallyScheduledEffects: this.conditionallyScheduledEffects,
      dependencies: this.dependencies,
      dependents: this.dependents,
      nodes: this.nodes,
      actionStats: this.actionStats,
      getDebounce: (action) => this.delays.getDebounce(action),
      getThrottle: (action) => this.delays.getThrottle(action),
      hasActiveDebounceTimer: (action) =>
        this.delays.hasActiveDebounceTimer(action),
      getActionId: (action) => this.getActionId(action),
      getSchedulingWrites: (action) =>
        this.writeIndex.getSchedulingWrites(action),
      getNextDebounceRunTime: (action) => this.getNextDebounceRunTime(action),
      getNextEligibleRunTime: (action) =>
        this.delays.getNextEligibleRunTime(action),
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

  private isPullDemandRootEffect(action: Action): boolean {
    const record = this.nodes.get(action);
    return record?.kind === "effect" &&
      (this.writeIndex.getSchedulingWrites(action)?.length ?? 0) === 0;
  }

  /**
   * Collects computations that must run before `action` can observe up-to-date
   * values. This includes explicitly dirty computations and clean intermediates
   * whose own inputs flow from dirty upstream computations.
   *
   * Returns whether `action` itself is stale with respect to the current dirty
   * set.
   */
  private collectDirtyDependencies(
    action: Action,
    workSet: Set<Action>,
    memo = new Map<Action, boolean>(),
  ): boolean {
    return collectDirtyDependenciesState(
      this.dirtyDependencyCollectionState,
      action,
      workSet,
      memo,
    );
  }

  private collectDirtyDependenciesFromTraversalRoot(
    action: Action,
    workSet: Set<Action>,
    memo = new Map<Action, boolean>(),
  ): boolean {
    return collectDirtyDependenciesFromTraversalRootState(
      this.dirtyDependencyCollectionState,
      action,
      workSet,
      memo,
    );
  }

  private collectDirtyDependenciesForLog(
    log: ReactivityLog,
    workSet: Set<Action>,
    memo = new Map<Action, boolean>(),
  ): boolean {
    return collectDirtyDependenciesForLogState(
      this.dirtyDependencyCollectionState,
      log,
      workSet,
      memo,
    );
  }

  private canAutomaticallyDebounce(action: Action): boolean {
    return canAutomaticallyDebounceState(this.delayControlState, action);
  }

  private markEffectConditionallyScheduled(effect: Action): void {
    markEffectConditionallyScheduledState(this.pullSchedulingState, effect);
  }

  private conditionalEffectHasChangedInputs(effect: Action): boolean {
    return conditionalEffectHasChangedInputsState(
      this.pullSchedulingState,
      effect,
    );
  }

  private collectPullIterationSeeds(workSet: Set<Action>): void {
    collectPullIterationSeedsState(this.pullSchedulingState, workSet);
  }

  private hasRunnablePullWork(): boolean {
    return hasRunnablePullWorkState(this.pullSchedulingState);
  }

  private hasDeferredDirtyEffectWork(): boolean {
    return hasDeferredDirtyEffectWorkState(this.pullSchedulingState);
  }

  private hasPendingLineageHeadEvent(): boolean {
    const head = this.eventQueue[0];
    if (head?.originTx === undefined) return false;
    if (this.lineage.originStatus(head.originTx) !== "pending") return false;
    return getCommitLocalSeq(head.originTx.tx, head.eventLink.space) ===
      undefined;
  }

  private scheduleAffectedEffects(
    computation: Action,
  ): TriggerTraceScheduledEffect[] {
    return scheduleAffectedEffectsState(this.pullSchedulingState, computation);
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

  private markPullDemandContinuation(action: Action): void {
    const record = this.nodes.get(action);
    if (!record) return;
    setNodeProvisionalDemand(this.dependencyGraphState, record, true);
  }

  private markNodeHasRun(action: Action): void {
    const record = this.nodes.get(action);
    if (!record) return;

    if (record.status === "never-ran") {
      record.status = "clean";
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
    return getNextDebounceRunTimeState(this.delayControlState, action);
  }

  private isDebouncedComputationWaiting(action: Action): boolean {
    return isDebouncedComputationWaitingState(this.delayControlState, action);
  }

  private scheduleComputationDebounce(action: Action): void {
    scheduleComputationDebounceState(this.delayControlState, action);
  }

  /**
   * Schedules an action with debounce support.
   * If the action has a debounce delay, it will wait before being added to pending.
   * Otherwise, it's added immediately.
   */
  private scheduleWithDebounce(action: Action): void {
    scheduleWithDebounceState(this.delayControlState, action);
  }

  /**
   * Checks if an action should be auto-debounced based on its performance stats.
   * Called after recording action time to potentially enable debouncing for slow actions.
   * Auto-debounce is enabled by default; use noDebounce to opt out.
   */
  private maybeAutoDebounce(action: Action): void {
    const update = maybeAutoDebounceState(this.delayControlState, action);
    if (update) {
      logger.debug("schedule-debounce", () => [
        `[AUTO-DEBOUNCE] Action ${update.actionId} ` +
        `auto-debounced (avg ${
          update.averageTime.toFixed(1)
        }ms >= ${update.thresholdMs}ms)`,
      ]);
    }
  }
}
