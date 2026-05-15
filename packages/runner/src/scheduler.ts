import { getLogger } from "@commonfabric/utils/logger";
import type { Cancel } from "./cancel.ts";
import { ConsoleEvent } from "./harness/console.ts";
import type {
  ConsoleHandler,
  ErrorHandler,
  ErrorWithContext,
  Runtime,
} from "./runtime.ts";
import { type NormalizedFullLink, toMemorySpaceAddress } from "./link-utils.ts";
import type {
  ChangeGroup,
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IStorageSubscription,
  IStorageTransaction,
} from "./storage/interface.ts";
import type { SortedAndCompactPaths } from "./reactive-dependencies.ts";
import {
  allowMutableTransactionRead,
  ignoreReadForScheduling,
  markReadAsPotentialWrite,
} from "./storage/reactivity-log.ts";
import type {
  ActionStats,
  NonIdempotentReport,
  SchedulerDiagnosisResult,
  SchedulerEventPreflightActionSummary,
  SchedulerEventPreflightStats,
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
  detectCausalCycles,
  type DiagnosisRecord,
} from "./scheduler/diagnosis.ts";
import {
  collectDirectWritersForLog,
  type DependencyGraphState,
  type DependencyUpdateState,
  getSchedulingWrites as getSchedulingWritesFromState,
  getSchedulingWritesMap as getSchedulingWritesMapFromState,
  pendingDependencyCollectionMightAffect
    as pendingDependencyCollectionMightAffectState,
  readsOverlapWrites,
  replaceActionTriggerPaths,
  type SchedulingWriteState,
  setCancelForTriggerEntities,
  setSchedulerDependencies,
  type TriggerIndexState,
  type TriggerSubscriptionState,
  updateDependentEdgesForLog,
  type WriterIndexState,
} from "./scheduler/dependency-index.ts";
import {
  type InFlightSourceState,
  runSchedulerAction,
} from "./scheduler/action-run.ts";
import {
  buildPullInitialSeeds,
  collectPendingDependencyActions,
  createSettlingTracker,
  isDirtyPullActionRunnable,
  isPendingPullActionRunnable,
  markExecuteStart,
  planAdaptiveCycleDebounce,
  planCycleBreak,
  planExecuteContinuation,
  pushBoundedHistory,
  recordExecuteEnd,
  runSchedulerSettleLoop,
  type SchedulerSettleResult,
  type SettlingTracker,
} from "./scheduler/execution.ts";
import { SchedulerDelays } from "./scheduler/delays.ts";
import { processStorageNotification } from "./scheduler/notifications.ts";
import {
  clearSchedulerDirectDirty,
  clearSchedulerDirty,
  type DirtySchedulingState,
  markSchedulerDirty,
  SchedulerStaleness,
} from "./scheduler/staleness.ts";
import {
  registerParentChildAction,
  type SchedulerSubscriptionState,
  unsubscribeSchedulerAction,
  updateSchedulerActionChangeGroup,
  updateSchedulerActionType,
} from "./scheduler/subscriptions.ts";
import { type WritePropagationState } from "./scheduler/write-propagation.ts";
import {
  type ActionTimingState,
  getActionStats as getActionStatsFromState,
} from "./scheduler/timing.ts";
import { txToReactivityLog } from "./scheduler/reactivity.ts";
import {
  addSchedulerEventHandler,
  cancelEventQueueWake as cancelEventQueueWakeState,
  type EventQueueWakeState,
  hasEventQueueWakeTimer,
  isHeadEventParked as isHeadEventParkedState,
  processQueuedEventDuringExecute,
  queueSchedulerEvent,
  scheduleEventQueueWake as scheduleEventQueueWakeState,
} from "./scheduler/events.ts";
import { buildSchedulerGraphSnapshot } from "./scheduler/graph-snapshot.ts";
import { entityKey } from "./scheduler/keys.ts";
import { collectTransitiveEffects } from "./scheduler/topology.ts";
import type {
  Action,
  ActionRunTraceEntry,
  DirtyDependencyTraceContext,
  EventHandler,
  PopulateDependencies,
  PopulateDependenciesEntry,
  QueuedEvent,
  ReactivityLog,
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
  markReadAsPotentialWrite,
};

export class Scheduler {
  private eventQueue: QueuedEvent[] = [];
  private eventHandlers: [NormalizedFullLink, EventHandler][] = [];

  private pending = new Set<Action>();
  private dependencies = new WeakMap<Action, ReactivityLog>();
  private cancels = new WeakMap<Action, Cancel>();
  private triggerIndexState: TriggerIndexState = {
    triggers: new Map<
      SpaceScopeAndURI,
      Map<Action, SortedAndCompactPaths>
    >(),
    nonRecursiveTriggers: new Map<
      SpaceScopeAndURI,
      Map<Action, SortedAndCompactPaths>
    >(),
  };
  private actionChangeGroups = new WeakMap<Action, ChangeGroup>();
  private retries = new WeakMap<Action, number>();

  // Effect/computation tracking for pull-based scheduling
  private effects = new Set<Action>();
  private computations = new Set<Action>();
  private dependents = new WeakMap<Action, Set<Action>>();
  private reverseDependencies = new WeakMap<Action, Set<Action>>();
  private activePullDemandActions = new WeakSet<Action>();
  private pullDemandedFirstRunComputations = new WeakSet<Action>();
  // Track which actions are effects persistently (survives unsubscribe/re-subscribe)
  private isEffectAction = new WeakMap<Action, boolean>();
  // In pull mode, `dirty` means direct dirty. `stale` additionally includes
  // actions with dirty upstream computations.
  private staleness = new SchedulerStaleness({
    dependents: this.dependents,
  });
  private pullMode = true;

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

  // Debounce infrastructure for throttling slow actions
  private pendingQueueTaskTimer: ReturnType<typeof setTimeout> | null = null;
  private eventQueueWakeState: EventQueueWakeState = {
    timer: null,
    wakeAt: null,
    eventQueue: this.eventQueue,
    isDisposed: () => this.disposed,
    queueExecution: () => this.queueExecution(),
  };
  private delays = new SchedulerDelays({
    actionStats: this.actionStats,
    getActionId: (action) => this.getActionId(action),
  });
  private inFlightSourceState: InFlightSourceState = {
    inFlightSources: new WeakMap<Action, Set<IStorageTransaction>>(),
  };

  private schedulingWriteState: SchedulingWriteState = {
    // Current-known writes are rebuilt on each dependency update from actual
    // writes plus declared/potential writes. This is the default scheduling view.
    currentKnownWrites: new WeakMap<Action, IMemorySpaceAddress[]>(),
    // Historical writes preserve the legacy cumulative union and are only used
    // when the experimental historical-write mode is enabled.
    historicalMightWrite: new WeakMap<Action, IMemorySpaceAddress[]>(),
    useHistoricalMightWrite: () =>
      this.runtime.experimental.schedulerHistoricalMightWrite === true,
  };
  private writerIndexState: WriterIndexState = {
    // Index: entity -> actions that write to it (for fast dependency lookup).
    // Updated from the active scheduling write set.
    writersByEntity: new Map<SpaceScopeAndURI, Set<Action>>(),
    // Reverse index: action -> entities it writes to (for cleanup)
    actionWriteEntities: new WeakMap<Action, Set<SpaceScopeAndURI>>(),
  };
  // Track actions scheduled for first time (bypass filter)
  private scheduledFirstTime = new Set<Action>();
  // Filter stats for diagnostics
  private filterStats = { filtered: 0, executed: 0 };

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

  // Parent-child action tracking for proper execution ordering
  // When a child action is created during parent execution, parent must run first
  private executingAction: Action | null = null;
  currentActionId?: string;
  private actionParent = new WeakMap<Action, Action>();
  private actionChildren = new WeakMap<Action, Set<Action>>();
  private dependencyGraphState: DependencyGraphState = {
    triggers: this.triggerIndexState.triggers,
    nonRecursiveTriggers: this.triggerIndexState.nonRecursiveTriggers,
    writersByEntity: this.writerIndexState.writersByEntity,
    dependencies: this.dependencies,
    dependents: this.dependents,
    reverseDependencies: this.reverseDependencies,
    staleness: this.staleness,
    getSchedulingWrites: (action) =>
      getSchedulingWritesFromState(this.schedulingWriteState, action),
    isStale: (action) => this.staleness.isStale(action),
    isDemandedPullComputation: (action) =>
      this.isDemandedPullComputation(action),
    queueExecution: () => this.queueExecution(),
  };
  private dependencyUpdateState: DependencyUpdateState = {
    writersByEntity: this.writerIndexState.writersByEntity,
    actionWriteEntities: this.writerIndexState.actionWriteEntities,
    dependencies: this.dependencies,
    currentKnownWrites: this.schedulingWriteState.currentKnownWrites,
    historicalMightWrite: this.schedulingWriteState.historicalMightWrite,
    dependencyGraph: this.dependencyGraphState,
    useHistoricalMightWrite: this.schedulingWriteState.useHistoricalMightWrite,
    isPullMode: () => this.pullMode,
  };
  private triggerSubscriptionState: TriggerSubscriptionState = {
    triggers: this.triggerIndexState.triggers,
    nonRecursiveTriggers: this.triggerIndexState.nonRecursiveTriggers,
    cancels: this.cancels,
    getActionId: (action) => this.getActionId(action),
    onTriggerUnsubscribe: (actionId, entityCount) => {
      logger.debug("schedule-unsubscribe", () => [
        `Action: ${actionId}`,
        `Entities: ${entityCount}`,
      ]);
    },
  };
  private dirtySchedulingState: DirtySchedulingState = {
    staleness: this.staleness,
    computations: this.computations,
    scheduleComputationDebounce: (action) =>
      this.scheduleComputationDebounce(action),
    clearComputationDebounceState: (action) =>
      this.delays.clearComputationDebounceState(action),
    isDemandedPullComputation: (action) =>
      this.isDemandedPullComputation(action),
    queueExecution: () => this.queueExecution(),
  };
  private pendingPullRunnableState = {
    effects: this.effects,
    isDemandedPullComputation: (action: Action) =>
      this.isDemandedPullComputation(action),
    shouldRunFirstPullComputationInDemandContext: (action: Action) =>
      this.shouldRunFirstPullComputationInDemandContext(action),
  };
  private dirtyPullRunnableState = {
    effects: this.effects,
    isDemandedPullComputation: (action: Action) =>
      this.isDemandedPullComputation(action),
    isThrottled: (action: Action) => this.delays.isThrottled(action),
  };
  private dirtyPullRunnableStateWithDebounce = {
    ...this.dirtyPullRunnableState,
    isDebouncedComputationWaiting: (action: Action) =>
      this.isDebouncedComputationWaiting(action),
  };
  private writePropagationState: WritePropagationState = {
    triggers: this.triggerIndexState.triggers,
    nonRecursiveTriggers: this.triggerIndexState.nonRecursiveTriggers,
    changedWritesHistory: this.changedWritesHistory,
    effects: this.effects,
    computations: this.computations,
    conditionallyScheduledEffects: this.conditionallyScheduledEffects,
    isPullMode: () => this.pullMode,
    scheduleWithDebounce: (action) => this.scheduleWithDebounce(action),
    markDirty: (action) =>
      markSchedulerDirty(this.dirtySchedulingState, action),
    scheduleAffectedEffects: (action) => {
      this.scheduleAffectedEffects(action);
    },
  };
  private subscriptionState: SchedulerSubscriptionState = {
    actionChangeGroups: this.actionChangeGroups,
    changeGroupToActionId: this.changeGroupToActionId,
    isEffectAction: this.isEffectAction,
    effects: this.effects,
    computations: this.computations,
    getPullMode: () => this.pullMode,
    getIdempotencyCheckMode: () => this.idempotencyCheckMode,
    queueExecution: () => this.queueExecution(),
    getActionId: (target) => this.getActionId(target),
    getExecutingAction: () => this.executingAction,
    actionParent: this.actionParent,
    actionChildren: this.actionChildren,
  };

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

  // Dependency population callbacks for first-time subscriptions
  // Called in execute() to discover what cells the action will read
  private populateDependenciesCallbacks = new WeakMap<
    Action,
    PopulateDependenciesEntry
  >();
  // Actions that need dependency population before first run
  private pendingDependencyCollection = new Set<Action>();
  private pendingDependencyCollectionState = {
    pendingDependencyCollection: this.pendingDependencyCollection,
    effects: this.effects,
    isThrottled: (action: Action) => this.delays.isThrottled(action),
    getSchedulingWrites: (action: Action) =>
      getSchedulingWritesFromState(this.schedulingWriteState, action),
    hasDependentPath: (from: Action, to: Action) =>
      this.hasDependentPath(from, to),
  };

  private idlePromises: (() => void)[] = [];
  private backgroundTasks = new Set<Promise<unknown>>();
  private loopCounter = new WeakMap<Action, number>();
  private errorHandlers = new Set<ErrorHandler>();
  private consoleHandler: ConsoleHandler;
  private _running: Promise<unknown> | undefined = undefined;
  private scheduled = false;
  private disposed = false;

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

  constructor(
    readonly runtime: Runtime,
    consoleHandler?: ConsoleHandler,
    errorHandlers?: ErrorHandler[],
  ) {
    this.consoleHandler = consoleHandler ||
      function (data) {
        // Default console handler returns arguments unaffected.
        return data.args;
      };

    if (errorHandlers) {
      errorHandlers.forEach((handler) => this.errorHandlers.add(handler));
    }

    // Subscribe to storage notifications
    this.runtime.storageManager.subscribe(this.createStorageSubscription());

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

  /**
   * Gets a stable identifier for an action based on its source location.
   * Prefers .src (set as backup) over .name, falls back to a generated ID.
   * This ID is used for stats tracking to persist across action recreation.
   */
  private getActionId(action: Action | EventHandler): string {
    return getSchedulerActionId(this.actionIdentityState, action);
  }

  // ── Inline idempotency check mode ──────────────────────────────────

  enableIdempotencyCheck(): void {
    this.idempotencyCheckMode = true;
    this.idempotencyViolations = [];
    if (this.pullMode) {
      this.queueExecution();
    }
  }

  disableIdempotencyCheck(): void {
    this.idempotencyCheckMode = false;
  }

  getIdempotencyViolations(): NonIdempotentReport[] {
    return [...this.idempotencyViolations];
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
    } = {},
  ): Cancel {
    // Handle backwards-compatible ReactivityLog argument
    let populateDependenciesEntry: PopulateDependenciesEntry;
    let immediateLog: ReactivityLog | undefined;
    if (typeof populateDependencies === "function") {
      populateDependenciesEntry = populateDependencies;
    } else {
      // ReactivityLog provided directly - set up dependencies immediately
      // (for backwards compatibility with code that passes reads/writes)
      immediateLog = populateDependencies;
      populateDependenciesEntry = immediateLog;
    }
    const {
      isEffect = false,
      debounce,
      noDebounce,
      throttle,
    } = options;

    updateSchedulerActionChangeGroup(this.subscriptionState, action, options);

    // Apply debounce settings if provided
    if (debounce !== undefined) {
      this.setDebounce(action, debounce);
    }
    if (noDebounce !== undefined) {
      this.setNoDebounce(action, noDebounce);
    }
    // Apply throttle setting if provided
    if (throttle !== undefined) {
      this.setThrottle(action, throttle);
    }

    const actionIsEffect = updateSchedulerActionType(
      this.subscriptionState,
      action,
      isEffect,
      {
        queueExecution: true,
      },
    );

    // Track parent-child relationship if action is created during another action's execution
    registerParentChildAction(this.subscriptionState, action);
    const parent = this.actionParent.get(action);
    if (
      this.pullMode &&
      !actionIsEffect &&
      parent &&
      this.activePullDemandActions.has(parent)
    ) {
      this.pullDemandedFirstRunComputations.add(action);
      this.queueExecution();
    }

    logger.debug(
      "schedule",
      () => [
        "Subscribing to action:",
        action,
        actionIsEffect ? "effect" : "computation",
      ],
    );

    // Store the populateDependencies callback for use in execute()
    this.populateDependenciesCallbacks.set(action, populateDependenciesEntry);

    // In pull mode, newly subscribed computations can be the replacement for an
    // already-running child graph (for example after a $TYPE change). Seed any
    // statically declared writes immediately so existing effects can discover
    // the new writer before the first execute() cycle.
    if (
      this.pullMode &&
      !actionIsEffect &&
      !immediateLog
    ) {
      const declaredWrites = (action as Partial<TelemetryAnnotations>).writes;
      if (declaredWrites && declaredWrites.length > 0) {
        setSchedulerDependencies(
          this.dependencyUpdateState,
          action,
          {
            reads: [],
            shallowReads: [],
            writes: declaredWrites.map(toMemorySpaceAddress),
          },
        );
      }
    }

    // If a ReactivityLog was provided directly, set up dependencies immediately.
    // This ensures writes are tracked right away for reverse dependency graph.
    if (immediateLog) {
      const { reads, shallowReads, log: schedulingLog } =
        setSchedulerDependencies(
          this.dependencyUpdateState,
          action,
          immediateLog,
        );
      this.updateDependents(action, schedulingLog);
      const { entities } = replaceActionTriggerPaths(
        this.triggerSubscriptionState,
        action,
        reads,
        shallowReads,
      );

      // Register the cancel function for the latest trigger set.
      setCancelForTriggerEntities(
        this.triggerSubscriptionState,
        action,
        entities,
      );
    } else {
      // Mark action for dependency collection before first run
      this.pendingDependencyCollection.add(action);
    }

    // Mark as dirty and pending for first-time execution
    // In pull mode this still doesn't mean execution: There needs to be an effect to trigger it.
    this.staleness.markDirectDirty(action);
    this.pending.add(action);
    this.scheduledFirstTime.add(action);

    if (
      this.pullMode &&
      !actionIsEffect &&
      getSchedulingWritesFromState(this.schedulingWriteState, action)?.length
    ) {
      this.scheduleAffectedEffects(action);
    }

    // Emit telemetry for new subscription
    const actionId = this.getActionId(action);
    this.runtime.telemetry.submit({
      type: "scheduler.subscribe",
      actionId,
      isEffect: actionIsEffect,
    });

    return () => this.unsubscribe(action);
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
    const { isEffect } = options;

    updateSchedulerActionChangeGroup(this.subscriptionState, action, options);

    const { reads, shallowReads, log: schedulingLog } =
      setSchedulerDependencies(this.dependencyUpdateState, action, log);

    // Track action type for pull-based scheduling
    // Once an action is marked as an effect, it stays an effect
    const actionIsEffect = updateSchedulerActionType(
      this.subscriptionState,
      action,
      isEffect,
    );
    const actionId = this.getActionId(action);

    // Update reverse dependency graph after the action type is restored. In
    // pull mode, registering a new edge to a live effect can be the moment a
    // stale upstream computation becomes demanded.
    if (this.pullMode) this.updateDependents(action, schedulingLog);

    // Track parent-child relationship if action is created during another action's execution
    // Only set if not already set (resubscribe can be called multiple times)
    registerParentChildAction(this.subscriptionState, action, {
      allowExisting: false,
    });

    const { entities, triggerPathsByEntity } = replaceActionTriggerPaths(
      this.triggerSubscriptionState,
      action,
      reads,
      shallowReads,
    );

    logger.debug("schedule-resubscribe", () => [
      `Action: ${actionId}`,
      `Entities: ${triggerPathsByEntity.size}`,
      `Reads: ${reads.length}`,
    ]);

    setCancelForTriggerEntities(
      this.triggerSubscriptionState,
      action,
      entities,
    );

    // In pull mode: When an effect resubscribes, check if any non-throttled dirty
    // computations write to what it reads. If so, mark the effect dirty so it can
    // pull those computations and see fresh data.
    // Skip throttled computations - they'll trigger via storage changes when unthrottled.
    // Use isEffectAction instead of effects because unsubscribe() clears effects before run()
    if (this.pullMode && actionIsEffect && this.staleness.stale.size > 0) {
      const effectReads = reads;
      const effectShallowReads = shallowReads;
      let shouldMarkDirty = false;

      // If there are pending computations whose dependencies haven't been
      // collected yet, only fall back to conservatism for unknown writes or
      // known writes that overlap what this effect reads.
      if (
        pendingDependencyCollectionMightAffectState(
          this.pendingDependencyCollectionState,
          action,
          effectReads,
          effectShallowReads,
        )
      ) {
        shouldMarkDirty = true;
      }

      // Use writersByEntity index for efficient lookup
      if (!shouldMarkDirty) {
        const entities = new Set<SpaceScopeAndURI>();
        for (const read of effectReads) {
          entities.add(entityKey(read));
        }
        for (const read of effectShallowReads) {
          entities.add(entityKey(read));
        }

        for (const entity of entities) {
          const writers = this.writerIndexState.writersByEntity.get(entity);
          if (!writers) continue;

          for (const writer of writers) {
            if (writer === action) continue;
            if (!this.staleness.isStale(writer)) continue;
            if (this.effects.has(writer)) continue; // Only check computations
            if (this.delays.isThrottled(writer)) continue; // Skip throttled - they trigger via storage

            // Check path overlap
            const writerWrites =
              getSchedulingWritesFromState(this.schedulingWriteState, writer) ??
                [];
            if (
              readsOverlapWrites(
                effectReads,
                effectShallowReads,
                writerWrites,
              )
            ) {
              shouldMarkDirty = true;
              break;
            }
            if (shouldMarkDirty) break;
          }
          if (shouldMarkDirty) break;
        }
      }

      if (shouldMarkDirty && !this.staleness.dirty.has(action)) {
        this.markEffectConditionallyScheduled(action);
        this.staleness.markDirectDirty(action);
        this.pending.add(action);
        this.queueExecution();
      }
    }
  }

  unsubscribe(
    action: Action,
    options: { preserveChangeGroup?: boolean } = {},
  ): void {
    unsubscribeSchedulerAction(
      {
        cancels: this.cancels,
        dependencies: this.dependencies,
        actionChangeGroups: this.actionChangeGroups,
        changeGroupToActionId: this.changeGroupToActionId,
        pending: this.pending,
        conditionallyScheduledEffects: this.conditionallyScheduledEffects,
        reverseDependencies: this.reverseDependencies,
        dependents: this.dependents,
        effects: this.effects,
        computations: this.computations,
        pullDemandedFirstRunComputations: this.pullDemandedFirstRunComputations,
        actionWriteEntities: this.writerIndexState.actionWriteEntities,
        writersByEntity: this.writerIndexState.writersByEntity,
        populateDependenciesCallbacks: this.populateDependenciesCallbacks,
        pendingDependencyCollection: this.pendingDependencyCollection,
        getActionId: (target) => this.getActionId(target),
        clearDirectDirty: (target) =>
          clearSchedulerDirectDirty(this.dirtySchedulingState, target),
        forceClearStale: (target) => this.staleness.forceClearStale(target),
        cancelDebounceTimer: (target) =>
          this.delays.cancelDebounceTimer(target),
        clearComputationDebounceState: (target, targetOptions) =>
          this.delays.clearComputationDebounceState(target, targetOptions),
      },
      action,
      options,
    );
  }

  async run(action: Action): Promise<any> {
    return await runSchedulerAction({
      runtime: this.runtime,
      actionChangeGroups: this.actionChangeGroups,
      inFlightSourceState: this.inFlightSourceState,
      actionTimingState: this.actionTimingState,
      pullDemandedFirstRunComputations: this.pullDemandedFirstRunComputations,
      retries: this.retries,
      pending: this.pending,
      actionRunTrace: this.actionRunTrace,
      actionParent: this.actionParent,
      isEffectAction: this.isEffectAction,
      diagnosisHistory: this.diagnosisHistory,
      diagnosisNonIdempotent: this.diagnosisNonIdempotent,
      idempotencyViolations: this.idempotencyViolations,
      writePropagationState: this.writePropagationState,
      computations: this.computations,
      getRunningPromise: () => this.runningPromise,
      setRunningPromise: (promise) => {
        this.runningPromise = promise;
      },
      getPullMode: () => this.pullMode,
      getCollectActionRunTrace: () => this.collectActionRunTrace,
      getDiagnosisEnabled: () => this.diagnosisEnabled,
      getIdempotencyCheckMode: () => this.idempotencyCheckMode,
      getActionId: (target) => this.getActionId(target),
      getActionTelemetryInfo: (target) =>
        getSchedulerActionTelemetryInfo(target),
      getSchedulingWrites: (target) =>
        getSchedulingWritesFromState(this.schedulingWriteState, target),
      maybeAutoDebounce: (target) => this.maybeAutoDebounce(target),
      markActionHasRun: (target) => this.delays.markActionHasRun(target),
      handleError: (error, target) => this.handleError(error, target),
      resubscribe: (target, log) => this.resubscribe(target, log),
      markDirectDirty: (target) => this.staleness.markDirectDirty(target),
      clearDirectDirty: (target) =>
        clearSchedulerDirectDirty(this.dirtySchedulingState, target),
      queueExecution: () => this.queueExecution(),
      setExecutingAction: (target, targetActionId) => {
        this.executingAction = target;
        this.currentActionId = targetActionId;
      },
      clearExecutingAction: () => {
        this.executingAction = null;
        this.currentActionId = undefined;
      },
    }, action);
  }

  idle(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.runningPromise) {
        // Something is currently running - wait for it then check again
        this.runningPromise.then(() => this.idle().then(resolve));
      } else if (this.backgroundTasks.size > 0) {
        // Async scheduler work, such as event-triggered auto-start, is still in
        // flight. Wait for it to settle and then re-check the scheduler state.
        Promise.allSettled([...this.backgroundTasks]).then(() =>
          this.idle().then(resolve)
        );
      } else if (
        hasEventQueueWakeTimer(this.eventQueueWakeState) &&
        ((this.eventQueue.length > 0 &&
          isHeadEventParkedState(this.eventQueueWakeState)) ||
          this.hasDeferredDirtyEffectWork())
      ) {
        // A queued event is parked behind a throttled dependency. Wait for the
        // wake timer to re-schedule the queue and then re-check.
        this.idlePromises.push(resolve);
      } else if (!this.scheduled) {
        if (this.pullMode && this.hasRunnablePullWork()) {
          this.queueExecution();
          this.idlePromises.push(resolve);
          return;
        }
        // Nothing is scheduled to run - we're idle.
        // In pull mode, pending computations won't run without an effect to pull them,
        // so we don't wait for them.
        resolve();
      } else {
        // Execution is scheduled - wait for it to complete
        this.idlePromises.push(resolve);
      }
    });
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
  ): void {
    queueSchedulerEvent({
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
      ) =>
        this.queueEvent(
          targetEventLink,
          targetEvent,
          targetRetries,
          targetOnCommit,
          targetDoNotLoad,
        ),
    }, {
      eventLink,
      event,
      retries,
      onCommit,
      doNotLoadPieceIfNotRunning,
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

  /**
   * Creates and returns a new storage subscription that can be used to receive storage notifications.
   *
   * @returns A new IStorageSubscription instance
   */
  private createStorageSubscription(): IStorageSubscription {
    return {
      next: (notification) => {
        processStorageNotification({
          triggers: this.triggerIndexState.triggers,
          nonRecursiveTriggers: this.triggerIndexState.nonRecursiveTriggers,
          pullMode: this.pullMode,
          diagnosisEnabled: this.diagnosisEnabled,
          collectTriggerTrace: this.collectTriggerTrace,
          changeGroupToActionId: this.changeGroupToActionId,
          causalEdges: this.causalEdges,
          actionChangeGroups: this.actionChangeGroups,
          effects: this.effects,
          pending: this.pending,
          dirty: this.staleness.dirty,
          inFlightSources: this.inFlightSourceState.inFlightSources,
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
          scheduleAffectedEffects: (target) =>
            this.scheduleAffectedEffects(target),
        }, notification);
        return { done: false };
      },
    } satisfies IStorageSubscription;
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
    let log: ReactivityLog;
    if (typeof populateDependencies === "function") {
      const depTx = this.runtime.edit();
      try {
        logger.timeStart("collectDependencies", "populate");
        try {
          populateDependencies(depTx);
        } finally {
          logger.timeEnd("collectDependencies", "populate");
        }
      } catch (error) {
        logger.debug(options.errorLogLabel, () => [
          options.errorMessage(action, error),
        ]);
      }
      log = txToReactivityLog(depTx);
      depTx.abort();
    } else {
      log = populateDependencies;
    }

    const { reads, shallowReads, log: schedulingLog } =
      setSchedulerDependencies(this.dependencyUpdateState, action, log);
    if (options.updateDependents ?? true) {
      this.updateDependents(action, schedulingLog);
    }

    const readsForTriggers = options.useRawReadsForTriggers ? log.reads : reads;
    const shallowReadsForTriggers = options.useRawReadsForTriggers
      ? log.shallowReads
      : shallowReads;
    const { entities } = replaceActionTriggerPaths(
      this.triggerSubscriptionState,
      action,
      readsForTriggers,
      shallowReadsForTriggers,
    );
    setCancelForTriggerEntities(
      this.triggerSubscriptionState,
      action,
      entities,
    );

    return { log, entities };
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

  /**
   * Returns diagnostic statistics about the scheduler state.
   * Useful for debugging and monitoring pull-based scheduling behavior.
   */
  getStats(): { effects: number; computations: number; pending: number } {
    return {
      effects: this.effects.size,
      computations: this.computations.size,
      pending: this.pending.size,
    };
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
   * Returns a snapshot of the current dependency graph for visualization.
   * Uses getActionId for the identifier (includes code location).
   */
  getGraphSnapshot(): SchedulerGraphSnapshot {
    return buildSchedulerGraphSnapshot({
      pullMode: this.pullMode,
      effects: this.effects,
      computations: this.computations,
      pending: this.pending,
      dirty: this.staleness.dirty,
      conditionallyScheduledEffects: this.conditionallyScheduledEffects,
      dependencies: this.dependencies,
      dependents: this.dependents,
      actionParent: this.actionParent,
      actionChildren: this.actionChildren,
      actionStats: this.actionStats,
      getDebounce: (action) => this.delays.getDebounce(action),
      getThrottle: (action) => this.delays.getThrottle(action),
      hasActiveDebounceTimer: (action) =>
        this.delays.hasActiveDebounceTimer(action),
      getActionId: (action) => this.getActionId(action),
      getSchedulingWrites: (action) =>
        getSchedulingWritesFromState(this.schedulingWriteState, action),
      getNextDebounceRunTime: (action) => this.getNextDebounceRunTime(action),
      getNextEligibleRunTime: (action) =>
        this.delays.getNextEligibleRunTime(action),
      isDemandedPullComputation: (action) =>
        this.isDemandedPullComputation(action),
      isLiveEffect: (action) => this.isLiveEffect(action),
      isPullDemandRootEffect: (action) => this.isPullDemandRootEffect(action),
      getPatternId: (action) => {
        const annotated = action as Partial<TelemetryAnnotations>;
        return annotated.pattern
          ? this.runtime.patternManager.getPatternId(annotated.pattern)
          : undefined;
      },
    });
  }

  /**
   * Returns whether an action is registered as an effect.
   */
  isEffect(action: Action): boolean {
    return this.effects.has(action);
  }

  /**
   * Returns whether an action is registered as a computation.
   */
  isComputation(action: Action): boolean {
    return this.computations.has(action);
  }

  /**
   * Returns the set of actions that depend on this action's output.
   */
  getDependents(action: Action): Set<Action> {
    return this.dependents.get(action) ?? new Set();
  }

  // ============================================================
  // Pull-based scheduling methods
  // ============================================================

  /**
   * Enables pull-based scheduling mode.
   * In pull mode, only effects are scheduled; computations are marked dirty
   * and pulled on demand when effects need their values.
   */
  enablePullMode(): void {
    this.pullMode = true;
    this.staleness.stale.clear();
    this.staleness.resetUpstreamStaleState();

    // Rebuild reverse dependency graph (dependents map) from current dependencies.
    // In push mode, processRun() doesn't update dependents, so the map may be stale.
    // We need accurate dependents for markDirty() propagation and scheduleAffectedEffects().
    for (const action of [...this.effects, ...this.computations]) {
      const log = this.dependencies.get(action);
      if (log) {
        this.updateDependents(action, log);
      }
    }
    for (const action of this.staleness.dirty) {
      this.staleness.setStaleFromInputs(action);
    }

    this.runtime.telemetry.submit({
      type: "scheduler.mode.change",
      pullMode: true,
    });
    this.queueExecution();
  }

  /**
   * Disables pull-based scheduling mode (returns to push mode).
   */
  disablePullMode(): void {
    this.pullMode = false;
    // Clear dirty set when switching back to push mode
    this.staleness.clearAll();
    this.runtime.telemetry.submit({
      type: "scheduler.mode.change",
      pullMode: false,
    });
    this.queueExecution();
  }

  /**
   * Returns whether pull mode is enabled.
   */
  isPullModeEnabled(): boolean {
    return this.pullMode;
  }

  setEventPreflightTelemetryEnabled(enabled: boolean): void {
    this.eventPreflightTelemetryEnabled = enabled;
  }

  isEventPreflightTelemetryEnabled(): boolean {
    return this.eventPreflightTelemetryEnabled;
  }

  private getTraceActionSummary(
    trace: DirtyDependencyTraceContext,
    action: Action,
  ): SchedulerEventPreflightActionSummary {
    let summary = trace.actionSummaries.get(action);
    if (!summary) {
      const log = this.dependencies.get(action);
      const writes =
        getSchedulingWritesFromState(this.schedulingWriteState, action) ?? [];
      summary = {
        actionId: this.getActionId(action),
        actionType: this.effects.has(action)
          ? "effect"
          : this.computations.has(action)
          ? "computation"
          : "unknown",
        visitCount: 0,
        memoHitCount: 0,
        dirtyInputCount: 0,
        resultTrueCount: 0,
        reverseDependencyEdgeCount: 0,
        maxDirectWriterCount: 0,
        dirty: this.staleness.dirty.has(action),
        pending: this.pending.has(action),
        readCount: log?.reads.length ?? 0,
        shallowReadCount: log?.shallowReads.length ?? 0,
        writeCount: writes.length,
      };
      trace.actionSummaries.set(action, summary);
    } else {
      summary.dirty ||= this.staleness.dirty.has(action);
      summary.pending ||= this.pending.has(action);
    }
    return summary;
  }

  private snapshotDirtyDependencyTraceContext(
    context: DirtyDependencyTraceContext,
  ): SchedulerEventPreflightStats {
    const {
      depth: _depth,
      actionSummaries,
      rootDirectWriterActions,
      ...stats
    } = context;
    const actionRows = [...actionSummaries.values()];
    const topBy = (
      rows: SchedulerEventPreflightActionSummary[],
      key: "visitCount" | "reverseDependencyEdgeCount",
    ) =>
      rows
        .filter((row) => row[key] > 0)
        .sort((a, b) =>
          b[key] - a[key] ||
          b.visitCount - a.visitCount ||
          a.actionId.localeCompare(b.actionId)
        )
        .slice(0, 12);

    const rootDirectWriterRows = [...rootDirectWriterActions].map((action) =>
      this.getTraceActionSummary(context, action)
    );

    return {
      ...stats,
      hotActions: topBy(actionRows, "visitCount"),
      hotFanoutActions: topBy(actionRows, "reverseDependencyEdgeCount"),
      rootDirectWriters: topBy(rootDirectWriterRows, "visitCount"),
    };
  }

  /**
   * Returns whether an action is marked as dirty.
   */
  isDirty(action: Action): boolean {
    return this.staleness.dirty.has(action);
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
    const collectStart = performance.now();
    let addedToStack = false;
    const trace = this.dirtyDependencyTraceContext;

    try {
      if (trace) {
        trace.visitCount++;
        trace.maxDepth = Math.max(trace.maxDepth, trace.depth);
        const actionSummary = this.getTraceActionSummary(trace, action);
        actionSummary.visitCount++;
        if (this.staleness.dirty.has(action)) {
          trace.dirtyInputCount++;
          actionSummary.dirtyInputCount++;
        }
      }

      const cached = memo.get(action);
      if (cached !== undefined) {
        if (trace) {
          trace.memoHitCount++;
          this.getTraceActionSummary(trace, action).memoHitCount++;
        }
        if (
          cached && this.staleness.dirty.has(action) &&
          this.computations.has(action)
        ) {
          if (!workSet.has(action) && trace) trace.workSetAddCount++;
          workSet.add(action);
        }
        return cached;
      }

      if (!this.staleness.isStale(action)) {
        memo.set(action, false);
        return false;
      }

      if (this.collectStack.has(action)) {
        if (trace) trace.cycleHitCount++;
        const cycleResult = this.staleness.isStale(action) ||
          workSet.has(action);
        memo.set(action, cycleResult);
        return cycleResult;
      }

      this.collectStack.add(action);
      addedToStack = true;

      let actionNeedsRun = this.staleness.isStale(action);
      const directWriters = this.reverseDependencies.get(action);
      if (directWriters) {
        if (trace) {
          trace.reverseDependencyActionCount++;
          trace.reverseDependencyEdgeCount += directWriters.size;
          const actionSummary = this.getTraceActionSummary(trace, action);
          actionSummary.reverseDependencyEdgeCount += directWriters.size;
          actionSummary.maxDirectWriterCount = Math.max(
            actionSummary.maxDirectWriterCount,
            directWriters.size,
          );
        }
        for (const writer of directWriters) {
          if (!this.staleness.isStale(writer)) {
            memo.set(writer, false);
            continue;
          }
          if (trace) trace.depth++;
          let writerNeedsRun: boolean;
          try {
            writerNeedsRun = this.collectDirtyDependencies(
              writer,
              workSet,
              memo,
            );
          } finally {
            if (trace) trace.depth--;
          }
          if (writerNeedsRun) {
            actionNeedsRun = true;
          }
        }
      } else {
        if (trace) trace.logFallbackCount++;
        const log = this.dependencies.get(action);
        if (log) {
          if (this.collectDirtyDependenciesForLog(log, workSet, memo)) {
            actionNeedsRun = true;
          }
        }
      }

      if (
        this.staleness.dirty.has(action) && this.computations.has(action)
      ) {
        if (!workSet.has(action) && trace) trace.workSetAddCount++;
        workSet.add(action);
      }

      if (actionNeedsRun && trace) {
        trace.resultTrueCount++;
        this.getTraceActionSummary(trace, action).resultTrueCount++;
      }
      memo.set(action, actionNeedsRun);
      return actionNeedsRun;
    } finally {
      if (addedToStack) {
        this.collectStack.delete(action);
      }
      logger.time(
        collectStart,
        "scheduler",
        "execute",
        "collectDirtyDependencies",
      );
    }
  }

  private hasDependentPath(
    from: Action,
    to: Action,
    visited = new Set<Action>(),
  ): boolean {
    if (from === to) return true;
    if (visited.has(from)) return false;
    visited.add(from);

    const dependents = this.dependents.get(from);
    if (!dependents) return false;

    for (const dependent of dependents) {
      if (this.hasDependentPath(dependent, to, visited)) {
        return true;
      }
    }

    return false;
  }

  private hasTransitiveEffectDependent(
    action: Action,
    visited = new Set<Action>(),
  ): boolean {
    if (visited.has(action)) return false;
    visited.add(action);

    const dependents = this.dependents.get(action);
    if (!dependents) return false;

    for (const dependent of dependents) {
      if (this.isLiveEffect(dependent)) return true;
      if (this.hasTransitiveEffectDependent(dependent, visited)) {
        return true;
      }
    }

    return false;
  }

  private isDemandedPullComputation(
    action: Action,
    visited = new Set<Action>(),
  ): boolean {
    if (
      !this.pullMode ||
      !this.computations.has(action) ||
      this.isLiveEffect(action)
    ) {
      return false;
    }
    if (visited.has(action)) return false;
    visited.add(action);

    return this.hasTransitiveEffectDependent(action) ||
      this.hasDemandedParentContext(action, visited);
  }

  private hasDemandedParentContext(
    action: Action,
    visited = new Set<Action>(),
  ): boolean {
    const parent = this.actionParent.get(action);
    if (!parent) return false;

    if (this.isLiveEffect(parent)) {
      return (
        getSchedulingWritesFromState(this.schedulingWriteState, parent)
          ?.length ?? 0
      ) === 0;
    }

    return this.isDemandedPullComputation(parent, visited);
  }

  private isLiveEffect(action: Action): boolean {
    if (this.effects.has(action)) return true;

    // During resubscribe, dependencies can be registered before all effect
    // bookkeeping is restored. Treat only dependency-bearing historical effects
    // as live so unsubscribed effects do not keep old pull graphs demanded.
    return (this.isEffectAction.get(action) ?? false) &&
      this.dependencies.has(action);
  }

  private isPullDemandRootEffect(action: Action): boolean {
    return this.pullMode &&
      this.effects.has(action) &&
      (getSchedulingWritesFromState(this.schedulingWriteState, action)
          ?.length ?? 0) === 0;
  }

  private canAutomaticallyDebounce(action: Action): boolean {
    return this.delays.canAutomaticallyDebounce(action, {
      effects: this.effects,
      isPullDemandRootEffect: (candidate) =>
        this.isPullDemandRootEffect(candidate),
    });
  }

  private shouldRunFirstPullComputationInDemandContext(
    action: Action,
  ): boolean {
    if (
      !this.pullMode ||
      !this.computations.has(action) ||
      this.effects.has(action) ||
      this.delays.hasActionRun(action)
    ) {
      return false;
    }

    return this.pullDemandedFirstRunComputations.has(action);
  }

  private markEffectConditionallyScheduled(effect: Action): void {
    if (!this.conditionallyScheduledEffects.has(effect)) {
      this.conditionallyScheduledEffects.set(
        effect,
        this.changedWritesHistory.length,
      );
    }
  }

  private conditionalEffectHasChangedInputs(effect: Action): boolean {
    const changedWritesStart = this.conditionallyScheduledEffects.get(effect);
    if (changedWritesStart === undefined) return true;

    const changedWrites = this.changedWritesHistory.slice(changedWritesStart);
    if (changedWrites.length === 0) return false;

    const log = this.dependencies.get(effect);
    if (!log) return false;

    return readsOverlapWrites(log.reads, log.shallowReads, changedWrites);
  }

  private collectDirtyDependenciesForLog(
    log: ReactivityLog,
    workSet: Set<Action>,
    memo = new Map<Action, boolean>(),
  ): boolean {
    const lookupStart = performance.now();
    const trace = this.dirtyDependencyTraceContext;
    let directWriters: Set<Action>;
    try {
      directWriters = collectDirectWritersForLog({
        writersByEntity: this.writerIndexState.writersByEntity,
        effects: this.effects,
        getSchedulingWrites: (writer) =>
          getSchedulingWritesFromState(this.schedulingWriteState, writer),
        trace,
      }, log);
    } finally {
      logger.time(
        lookupStart,
        "scheduler",
        "execute",
        "collectDirtyDependencies",
        "writerLookup",
      );
    }

    if (trace) trace.directWriterCount += directWriters.size;
    if (trace && trace.depth === 0) {
      for (const writer of directWriters) {
        trace.rootDirectWriterActions.add(writer);
        this.getTraceActionSummary(trace, writer);
      }
    }

    let hasDirtyDependencies = false;
    for (const writer of directWriters) {
      if (!this.staleness.isStale(writer)) {
        memo.set(writer, false);
        continue;
      }

      if (trace) trace.depth++;
      let writerNeedsRun: boolean;
      try {
        writerNeedsRun = this.collectDirtyDependencies(
          writer,
          workSet,
          memo,
        );
      } finally {
        if (trace) trace.depth--;
      }
      if (writerNeedsRun) {
        hasDirtyDependencies = true;
        if (
          this.staleness.dirty.has(writer) && this.computations.has(writer)
        ) {
          if (!workSet.has(writer) && trace) trace.workSetAddCount++;
          workSet.add(writer);
        }
      }
    }

    return hasDirtyDependencies;
  }

  /**
   * In pull mode, only effects are runnable seeds by default.
   *
   * Inline idempotency mode intentionally does not widen this to computations:
   * it rechecks computations that already run due to explicit demand or an
   * effect pull, rather than turning pull mode back into eager push mode.
   */
  private collectPullIterationSeeds(workSet: Set<Action>): void {
    for (const action of this.pending) {
      if (isPendingPullActionRunnable(this.pendingPullRunnableState, action)) {
        workSet.add(action);
      }
    }

    for (const action of this.staleness.dirty) {
      if (isDirtyPullActionRunnable(this.dirtyPullRunnableState, action)) {
        this.pending.add(action);
        workSet.add(action);
      }
    }
  }

  private hasRunnablePullWork(): boolean {
    for (const action of this.pending) {
      if (isPendingPullActionRunnable(this.pendingPullRunnableState, action)) {
        return true;
      }
    }

    for (const action of this.staleness.dirty) {
      if (
        isDirtyPullActionRunnable(
          this.dirtyPullRunnableStateWithDebounce,
          action,
        )
      ) {
        return true;
      }
    }

    return false;
  }
  private hasDeferredDirtyEffectWork(): boolean {
    for (const action of this.staleness.dirty) {
      if (this.effects.has(action)) return true;
    }
    return false;
  }

  /**
   * Finds and schedules all effects that transitively depend on the given computation.
   */
  private scheduleAffectedEffects(
    computation: Action,
  ): TriggerTraceScheduledEffect[] {
    const start = performance.now();
    const scheduledEffects: TriggerTraceScheduledEffect[] = [];

    try {
      for (
        const effect of collectTransitiveEffects(
          { dependents: this.dependents, effects: this.effects },
          computation,
        )
      ) {
        const pendingBefore = this.pending.has(effect);
        const dirtyBefore = this.staleness.dirty.has(effect);
        const debounceMs = this.delays.getDebounce(effect);
        if (
          !pendingBefore && !dirtyBefore &&
          !this.conditionallyScheduledEffects.has(effect)
        ) {
          this.markEffectConditionallyScheduled(effect);
        }
        this.scheduleWithDebounce(effect);
        scheduledEffects.push({
          actionId: this.getActionId(effect),
          pendingBefore,
          dirtyBefore,
          debounceMs,
        });
      }
    } finally {
      logger.time(start, "scheduler", "scheduleAffectedEffects");
    }
    return scheduledEffects;
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

  private getNextDebounceRunTime(action: Action): number | undefined {
    return this.delays.getNextDebounceRunTime(
      action,
      {
        pullMode: this.pullMode,
        computations: this.computations,
        effects: this.effects,
        dirty: this.staleness.dirty,
      },
    );
  }

  private isDebouncedComputationWaiting(action: Action): boolean {
    return this.delays.isDebouncedComputationWaiting(
      action,
      {
        pullMode: this.pullMode,
        computations: this.computations,
        effects: this.effects,
        dirty: this.staleness.dirty,
        pending: this.pending,
        queueExecution: () => this.queueExecution(),
        logDebounce: (message) =>
          logger.debug("schedule-debounce", () => [message]),
      },
    );
  }

  private scheduleComputationDebounce(action: Action): void {
    this.delays.scheduleComputationDebounce(
      action,
      {
        pullMode: this.pullMode,
        computations: this.computations,
        effects: this.effects,
        dirty: this.staleness.dirty,
        pending: this.pending,
        queueExecution: () => this.queueExecution(),
        logDebounce: (message) =>
          logger.debug("schedule-debounce", () => [message]),
      },
    );
  }

  /**
   * Schedules an action with debounce support.
   * If the action has a debounce delay, it will wait before being added to pending.
   * Otherwise, it's added immediately.
   */
  private scheduleWithDebounce(action: Action): void {
    this.delays.scheduleWithDebounce(
      action,
      {
        pending: this.pending,
        queueExecution: () => this.queueExecution(),
        logDebounce: (message) =>
          logger.debug("schedule-debounce", () => [message]),
      },
    );
  }

  /**
   * Checks if an action should be auto-debounced based on its performance stats.
   * Called after recording action time to potentially enable debouncing for slow actions.
   * Auto-debounce is enabled by default; use noDebounce to opt out.
   */
  private maybeAutoDebounce(action: Action): void {
    const update = this.delays.maybeAutoDebounce(action, {
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

  // ============================================================
  // Push-triggered filtering
  // ============================================================

  /**
   * Returns the active scheduling write set for an action. By default this is
   * the current-known write set; experimental historical mode returns the
   * cumulative legacy view instead.
   */
  getMightWrite(action: Action): IMemorySpaceAddress[] | undefined {
    return getSchedulingWritesFromState(this.schedulingWriteState, action);
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
    this.filterStats = { filtered: 0, executed: 0 };
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
      this.actionRunTrace = [];
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

  // ============================================================
  // Idempotency diagnosis API (Phase 2 + 3)
  // ============================================================

  /**
   * Starts diagnosis mode: captures read/write values and causal edges.
   * Automatically stops after durationMs.
   */
  private startDiagnosis(durationMs = 5000): void {
    if (this.diagnosisEnabled) return;

    this.diagnosisEnabled = true;
    this.diagnosisStartTime = performance.now();
    this.diagnosisBusyTime = 0;
    this.diagnosisHistory.clear();
    this.diagnosisNonIdempotent = [];
    this.causalEdges = [];

    this.diagnosisTimeout = setTimeout(() => {
      this.stopDiagnosis();
    }, durationMs);
  }

  /**
   * Stops diagnosis mode and finalizes results.
   */
  private stopDiagnosis(): void {
    if (!this.diagnosisEnabled) return;

    this.diagnosisEnabled = false;
    if (this.diagnosisTimeout) {
      clearTimeout(this.diagnosisTimeout);
      this.diagnosisTimeout = null;
    }

    const duration = performance.now() - this.diagnosisStartTime;

    // Detect cycles from causal edges
    const cycles = detectCausalCycles(this.causalEdges);

    const result: SchedulerDiagnosisResult = {
      nonIdempotent: this.diagnosisNonIdempotent,
      cycles,
      duration,
      busyTime: this.diagnosisBusyTime,
    };

    // Clean up
    this.diagnosisHistory.clear();
    this.causalEdges = [];

    // Resolve the promise if someone is waiting
    if (this.diagnosisResolve) {
      this.diagnosisResolve(result);
      this.diagnosisResolve = null;
    }
  }

  /**
   * Runs a diagnosis for the specified duration and returns the result.
   * This is the main entry point for external callers (IPC, console).
   */
  runDiagnosis(durationMs = 5000): Promise<SchedulerDiagnosisResult> {
    // If already running, stop and start fresh
    if (this.diagnosisEnabled) {
      this.stopDiagnosis();
    }

    return new Promise<SchedulerDiagnosisResult>((resolve) => {
      this.diagnosisResolve = resolve;
      this.startDiagnosis(durationMs);
    });
  }

  /**
   * Checks all computations for idempotency by enabling inline mode
   * and force-running each computation through run(). Each run()
   * automatically gets a second synchronous run for comparison.
   */
  async runIdempotencyCheck(): Promise<SchedulerDiagnosisResult> {
    this.idempotencyViolations = [];
    this.idempotencyCheckMode = true;

    try {
      // Snapshot computations to avoid iterating a live Set
      const computationsSnapshot = [...this.computations];
      for (const action of computationsSnapshot) {
        await this.run(action);
      }
    } finally {
      this.idempotencyCheckMode = false;
    }

    return {
      nonIdempotent: [...this.idempotencyViolations],
      cycles: [],
      duration: 0,
      busyTime: 0,
    };
  }

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

    // Track timing for cycle-aware debounce
    this.executeStartTime = performance.now();
    this.runsThisExecute.clear();

    // Non-settling heuristic: record execute() start
    markExecuteStart(this.settlingTracker);

    logger.timeStart("scheduler", "execute", "depCollect");
    // Find computation actions whose writes are still unknown. We run them on
    // the first cycle to capture writes that cannot be inferred from declared
    // outputs or populateDependencies() potential writes.
    //
    // TODO(seefeld): Once we more reliably capture what they can write via
    // WriteableCell or so, then we can treat this more deliberately via the
    // dependency collection process above. We'll have to re-run it whenever
    // inputs change, as they might change what they can write to. We hope that
    // for now this will be sufficiently captured in mightWrite.
    const { newActionsWithoutDependencies } = collectPendingDependencyActions({
      pendingDependencyCollection: this.pendingDependencyCollection,
      populateDependenciesCallbacks: this.populateDependenciesCallbacks,
      effects: this.effects,
      getSchedulingWrites: (action) =>
        getSchedulingWritesFromState(this.schedulingWriteState, action),
      collectDependenciesForAction: (action, populateDependencies) =>
        this.collectDependenciesForAction(action, populateDependencies, {
          errorLogLabel: "schedule-dep-error",
          errorMessage: (target, error) =>
            `Error populating dependencies for ${
              this.getActionId(target)
            }: ${error}`,
        }),
      onCollected: (action, { log, entities }) =>
        logger.debug("schedule-dep-collect", () => [
          `Collected dependencies for ${
            this.getActionId(action)
          }: ${log.reads.length} reads, ${log.writes.length} writes, ${entities.size} entities`,
        ]),
      scheduleAffectedEffects: (action) => this.scheduleAffectedEffects(action),
    });
    logger.timeEnd("scheduler", "execute", "depCollect");

    // Track dirty dependencies that block events - these must be added to workSet
    const eventBlockingDeps = new Set<Action>();

    logger.timeStart("scheduler", "execute", "event");
    await processQueuedEventDuringExecute({
      runtime: this.runtime,
      eventQueue: this.eventQueue,
      pullMode: this.pullMode,
      dirty: this.staleness.dirty,
      pending: this.pending,
      eventBlockingDeps,
      eventPreflightTelemetryEnabled: this.eventPreflightTelemetryEnabled,
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
      isDebouncedComputationWaiting: (dep) =>
        this.isDebouncedComputationWaiting(dep),
      getNextDebounceRunTime: (dep) => this.getNextDebounceRunTime(dep),
      getNextEligibleRunTime: (dep) => this.delays.getNextEligibleRunTime(dep),
      scheduleEventQueueWake: (notBefore) =>
        scheduleEventQueueWakeState(this.eventQueueWakeState, notBefore),
      snapshotDirtyDependencyTraceContext: (trace) =>
        this.snapshotDirtyDependencyTraceContext(trace),
    });
    logger.timeEnd("scheduler", "execute", "event");

    // Process any newly subscribed actions that were added during event handling.
    // This handles cases like event handlers that create sub-patterns whose
    // computations need their dependencies discovered before we build the workSet.
    if (this.pendingDependencyCollection.size > 0) {
      collectPendingDependencyActions({
        pendingDependencyCollection: this.pendingDependencyCollection,
        populateDependenciesCallbacks: this.populateDependenciesCallbacks,
        effects: this.effects,
        getSchedulingWrites: (action) =>
          getSchedulingWritesFromState(this.schedulingWriteState, action),
        collectDependenciesForAction: (action, populateDependencies) =>
          this.collectDependenciesForAction(action, populateDependencies, {
            errorLogLabel: "schedule-dep-error-post-event",
            errorMessage: (target, error) =>
              `Error populating dependencies for ${
                this.getActionId(target)
              }: ${error}`,
          }),
        onCollected: (action) =>
          logger.debug("schedule-dep-collect-post-event", () => [
            `Collected dependencies for ${this.getActionId(action)}`,
          ]),
      });
    }

    // Build initial seeds for pull mode (effects + special actions).
    const initialSeeds = buildPullInitialSeeds({
      pullMode: this.pullMode,
      pending: this.pending,
      dirty: this.staleness.dirty,
      effects: this.effects,
      newActionsWithoutDependencies,
      eventBlockingDeps,
      computationDebounceFlushSeeds: this.delays.computationDebounceFlushSeeds,
    });

    const settleResult = await this.runSettleLoop(initialSeeds);
    await this.breakCyclesIfNeeded(settleResult);
    this.applyAdaptiveCycleDebounce();
    this.recordExecuteEndTelemetry();
    this.applyExecuteContinuation();
    logger.timeEnd("scheduler", "execute");
  }

  private async runSettleLoop(
    initialSeeds: ReadonlySet<Action>,
  ): Promise<SchedulerSettleResult> {
    const settleResult = await runSchedulerSettleLoop({
      pullMode: this.pullMode,
      collectSettleStats: this.collectSettleStats,
      pendingDependencyCollection: this.pendingDependencyCollection,
      populateDependenciesCallbacks: this.populateDependenciesCallbacks,
      effects: this.effects,
      computations: this.computations,
      pending: this.pending,
      dirty: this.staleness.dirty,
      dependencies: this.dependencies,
      actionParent: this.actionParent,
      dependents: this.dependents,
      conditionallyScheduledEffects: this.conditionallyScheduledEffects,
      filterStats: this.filterStats,
      loopCounter: this.loopCounter,
      runsThisExecute: this.runsThisExecute,
      activePullDemandActions: this.activePullDemandActions,
      getSchedulingWrites: (action) =>
        getSchedulingWritesFromState(this.schedulingWriteState, action),
      getSchedulingWritesMap: () =>
        getSchedulingWritesMapFromState(this.schedulingWriteState),
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
      isPullDemandRootEffect: (action) => this.isPullDemandRootEffect(action),
      handleError: (error, action) => this.handleError(error, action),
      runAction: (action) => this.run(action),
    }, initialSeeds);

    if (settleResult.settleStats) {
      this.lastSettleStats = settleResult.settleStats;
      pushBoundedHistory(
        this.settleStatsHistory,
        { recordedAt: performance.now(), stats: settleResult.settleStats },
        MAX_SETTLE_STATS_HISTORY,
      );
    }

    return settleResult;
  }

  private async breakCyclesIfNeeded(
    settleResult: SchedulerSettleResult,
  ): Promise<void> {
    // If we hit max iterations without settling, break the cycle:
    // 1. Clear dirty/pending for computations that were in early iterations AND still in last workSet
    // 2. Run all remaining dirty effects so they don't get lost
    const cycleBreakPlan = planCycleBreak({
      pullMode: this.pullMode,
      settledEarly: settleResult.settledEarly,
      lastWorkSet: settleResult.lastWorkSet,
      earlyIterationComputations: settleResult.earlyIterationComputations,
      dirty: this.staleness.dirty,
      effects: this.effects,
      runsThisExecute: this.runsThisExecute,
      isThrottled: (action) => this.delays.isThrottled(action),
    });
    if (!cycleBreakPlan.shouldBreak) return;

    logger.debug("schedule-cycle", () => [
      `[CYCLE-BREAK] Hit max iterations (${settleResult.maxSettleIterations}), breaking cycle`,
      `Early computations: ${settleResult.earlyIterationComputations.size}, Last workSet: ${settleResult.lastWorkSet.size}`,
    ]);

    // Clear computations that appear to be in the cycle
    // (present in early iterations AND still in the last workSet)
    // But don't clear throttled computations - they should stay dirty
    for (const comp of cycleBreakPlan.computationsToClear) {
      logger.debug("schedule-cycle", () => [
        `[CYCLE-BREAK] Clearing cyclic computation: ${this.getActionId(comp)}`,
      ]);
      clearSchedulerDirty(this.dirtySchedulingState, comp);
      this.pending.delete(comp);
    }

    // Run all remaining dirty effects - these shouldn't be lost
    // But skip throttled effects - they should stay dirty for later
    for (const effect of cycleBreakPlan.dirtyEffectsToRun) {
      if (this.effects.has(effect) && this.staleness.dirty.has(effect)) {
        logger.debug("schedule-cycle", () => [
          `[CYCLE-BREAK] Running dirty effect: ${this.getActionId(effect)}`,
        ]);
        clearSchedulerDirty(this.dirtySchedulingState, effect);
        this.pending.delete(effect);
        this.unsubscribe(effect);
        this.filterStats.executed++;
        await this.run(effect);
      }
    }
  }

  private applyAdaptiveCycleDebounce(): void {
    // Apply cycle-aware debounce to effects that ran multiple times this execute().
    // Pull computations are already demand-gated; debouncing them can leave a
    // live renderer observing stale materialized data until an arbitrary timer
    // fires.
    const cycleDebouncePlan = planAdaptiveCycleDebounce({
      pullMode: this.pullMode,
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

  private applyExecuteContinuation(): void {
    // In pull mode, we consider ourselves done when there are no effects or
    // effect-demanded computations to execute.
    const hasQueuedEventReadyNow = this.eventQueue.length > 0 &&
      !isHeadEventParkedState(this.eventQueueWakeState);
    const hasParkedHeadEvent = this.eventQueue.length > 0 &&
      isHeadEventParkedState(this.eventQueueWakeState);
    const shouldRerunAfterCurrentExecute = this.rerunAfterCurrentExecute;
    this.rerunAfterCurrentExecute = false;

    const continuation = planExecuteContinuation({
      pullMode: this.pullMode,
      pending: this.pending,
      dirty: this.staleness.dirty,
      effects: this.effects,
      shouldRerunAfterCurrentExecute,
      hasQueuedEventReadyNow,
      hasParkedHeadEvent,
      isDemandedPullComputation: (action) =>
        this.isDemandedPullComputation(action),
      shouldRunFirstPullComputationInDemandContext: (action) =>
        this.shouldRunFirstPullComputationInDemandContext(action),
      isDebouncedComputationWaiting: (action) =>
        this.isDebouncedComputationWaiting(action),
      getNextDebounceRunTime: (action) => this.getNextDebounceRunTime(action),
      getNextEligibleRunTime: (action) =>
        this.delays.getNextEligibleRunTime(action),
    });

    if (!continuation.shouldQueueAnotherTick) {
      if (continuation.nextDirtyPullRunAt !== undefined) {
        scheduleEventQueueWakeState(
          this.eventQueueWakeState,
          continuation.nextDirtyPullRunAt,
        );
        const promises = this.idlePromises;
        if (
          !continuation.hasParkedHeadEvent &&
          !continuation.nextDirtyPullRunWaitsForIdle
        ) {
          for (const resolve of promises) resolve();
          this.idlePromises.length = 0;
        }
        this.loopCounter = new WeakMap();
        this.scheduled = false;
      } else if (hasEventQueueWakeTimer(this.eventQueueWakeState)) {
        this.loopCounter = new WeakMap();
        this.scheduled = false;

        // Waiting on a future wake is quiescent from the scheduler's
        // perspective, so reset the non-settling tracker.
        this.settlingTracker = createSettlingTracker();
      } else {
        const promises = this.idlePromises;
        for (const resolve of promises) resolve();
        this.idlePromises.length = 0;
        this.loopCounter = new WeakMap();
        this.scheduled = false;

        // Reset settling tracker on idle
        this.settlingTracker = createSettlingTracker();

        this.scheduledFirstTime.clear();
        if (this.conditionallyScheduledEffects.size === 0) {
          this.changedWritesHistory.length = 0;
        }
      }
    } else {
      // Keep scheduled = true since we're queuing another execution
      this.pendingQueueTaskTimer = queueTask(() => {
        this.pendingQueueTaskTimer = null;
        this.execute();
      });
    }
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
    cancelEventQueueWakeState(this.eventQueueWakeState);
    // Clean up diagnosis state
    if (this.diagnosisTimeout) {
      clearTimeout(this.diagnosisTimeout);
      this.diagnosisTimeout = null;
    }
    this.diagnosisEnabled = false;
  }
}
