import { getLogger } from "@commonfabric/utils/logger";
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
  IStorageTransaction,
} from "./storage/interface.ts";
import {
  allowMutableTransactionRead,
  ignoreReadForScheduling,
  markReadAsPotentialWrite,
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
  updateDependentEdgesForLog,
} from "./scheduler/dependency-graph.ts";
import { type DependencyUpdateState } from "./scheduler/dependency-updates.ts";
import {
  readsOverlapWrites,
  SchedulerWriteIndex,
} from "./scheduler/scheduling-writes.ts";
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
  type DirtyDependencyCollectionState,
  snapshotDirtyDependencyTraceContext,
} from "./scheduler/dirty-dependencies.ts";
import {
  type InFlightSourceState,
  runSchedulerAction,
  type SchedulerActionRunState,
} from "./scheduler/action-run.ts";
import {
  buildPullInitialSeeds,
  collectInitialExecuteDependencies as collectInitialExecuteDependenciesState,
  collectPostEventDependencies as collectPostEventDependenciesState,
  createSettlingTracker,
  isDirtyPullActionRunnable,
  isPendingPullActionRunnable,
  markExecuteStart,
  planAdaptiveCycleDebounce,
  pushBoundedHistory,
  recordExecuteEnd,
  runSchedulerSettleLoop,
  type SchedulerSettleLoopState,
  type SchedulerSettleResult,
  type SettlingTracker,
} from "./scheduler/execution.ts";
import { breakCyclesIfNeeded } from "./scheduler/cycle-break.ts";
import { applyExecuteContinuation } from "./scheduler/continuation.ts";
import type { CycleBreakState } from "./scheduler/cycle-break.ts";
import type { ExecuteContinuationState } from "./scheduler/continuation.ts";
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
  hasDependentPath,
  isDemandedPullComputation,
  isLiveEffect,
  isPullDemandRootEffect,
  type PullDemandState,
  shouldRunFirstPullComputationInDemandContext,
} from "./scheduler/demand.ts";
import {
  createStorageSubscription,
  type StorageNotificationState,
} from "./scheduler/notifications.ts";
import {
  clearSchedulerDirectDirty,
  clearSchedulerDirty,
  type DirtySchedulingState,
  markSchedulerDirty,
  SchedulerStaleness,
} from "./scheduler/staleness.ts";
import {
  resubscribeSchedulerAction,
  type SchedulerSubscribeActionState,
  type SchedulerSubscriptionState,
  type SchedulerUnsubscribeActionState,
  subscribeSchedulerAction,
  unsubscribeSchedulerAction,
} from "./scheduler/subscriptions.ts";
import { type WritePropagationState } from "./scheduler/write-propagation.ts";
import {
  type ActionTimingState,
  getActionStats as getActionStatsFromState,
} from "./scheduler/timing.ts";
import {
  addSchedulerEventHandler,
  cancelEventQueueWake as cancelEventQueueWakeState,
  type EventQueueWakeState,
  hasEventQueueWakeTimer,
  isHeadEventParked as isHeadEventParkedState,
  processQueuedEventDuringExecute,
  queueSchedulerEvent,
  scheduleEventQueueWake as scheduleEventQueueWakeState,
  type SchedulerEventQueueState,
} from "./scheduler/events.ts";
import {
  buildSchedulerGraphSnapshot,
  type SchedulerGraphSnapshotState,
} from "./scheduler/graph-snapshot.ts";
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

type PendingPullRunnableState = Parameters<typeof isPendingPullActionRunnable>[
  0
];
type DirtyPullRunnableState = Parameters<typeof isDirtyPullActionRunnable>[0];
type DirtyPullRunnableStateWithDebounce = DirtyPullRunnableState & {
  readonly isDebouncedComputationWaiting: (action: Action) => boolean;
};
type PendingDependencyCollectionState =
  SchedulerSubscribeActionState["pendingDependencyCollectionState"];
type FilterStatsState = { filtered: number; executed: number };

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
  private triggerIndex = new SchedulerTriggerIndex();
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
  private diagnosisControlState!: SchedulerDiagnosisControlState;

  // Debounce infrastructure for throttling slow actions
  private pendingQueueTaskTimer: ReturnType<typeof setTimeout> | null = null;
  private eventQueueWakeState!: EventQueueWakeState;
  private eventQueueState!: SchedulerEventQueueState;
  private delays = new SchedulerDelays({
    actionStats: this.actionStats,
    getActionId: (action) => this.getActionId(action),
  });
  private delayControlState!: SchedulerDelayControlState;
  private inFlightSourceState: InFlightSourceState = {
    inFlightSources: new WeakMap<Action, Set<IStorageTransaction>>(),
  };

  private writeIndex!: SchedulerWriteIndex;
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
  private actionParent = new WeakMap<Action, Action>();
  private actionChildren = new WeakMap<Action, Set<Action>>();
  private pullDemandState!: PullDemandState;
  private dependencyGraphState!: DependencyGraphState;
  private dependencyUpdateState!: DependencyUpdateState;
  private triggerSubscriptionState!: TriggerSubscriptionState;
  private dirtySchedulingState!: DirtySchedulingState;
  private pendingPullRunnableState!: PendingPullRunnableState;
  private dirtyPullRunnableState!: DirtyPullRunnableState;
  private dirtyPullRunnableStateWithDebounce!:
    DirtyPullRunnableStateWithDebounce;
  private writePropagationState!: WritePropagationState;
  private subscriptionState!: SchedulerSubscriptionState;

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
  private pendingDependencyCollectionState!: PendingDependencyCollectionState;
  private dependencyCollectionState!: DependencyCollectionState;
  private subscribeActionState!: SchedulerSubscribeActionState;
  private unsubscribeState!: SchedulerUnsubscribeActionState;

  private idlePromises: (() => void)[] = [];
  private backgroundTasks = new Set<Promise<unknown>>();
  private loopCounter = new WeakMap<Action, number>();
  private errorHandlers = new Set<ErrorHandler>();
  private consoleHandler: ConsoleHandler;
  private _running: Promise<unknown> | undefined = undefined;
  private scheduled = false;
  private disposed = false;
  private actionRunState!: SchedulerActionRunState;
  private graphSnapshotState!: SchedulerGraphSnapshotState;
  private cycleBreakState!: CycleBreakState;
  private settleLoopState!: SchedulerSettleLoopState;
  private executeContinuationState!: ExecuteContinuationState;

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
      createStorageSubscription(this.storageNotificationState),
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

  // Keep state-bundle wiring explicit without making the field declarations
  // read like one large object graph.
  private initializeSchedulerState(): void {
    this.diagnosisControlState = this.createDiagnosisControlState();
    this.eventQueueWakeState = this.createEventQueueWakeState();
    this.writeIndex = this.createWriteIndex();
    this.pullDemandState = this.createPullDemandState();
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
      computations: this.computations,
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
    return new SchedulerWriteIndex({
      useHistoricalMightWrite: () =>
        this.runtime.experimental.schedulerHistoricalMightWrite === true,
    });
  }

  private createPullDemandState(): PullDemandState {
    return {
      getPullMode: () => this.pullMode,
      computations: this.computations,
      effects: this.effects,
      dependents: this.dependents,
      dependencies: this.dependencies,
      actionParent: this.actionParent,
      isEffectAction: this.isEffectAction,
      pullDemandedFirstRunComputations: this.pullDemandedFirstRunComputations,
      hasActionRun: (action) => this.delays.hasActionRun(action),
      getSchedulingWrites: (action) =>
        this.writeIndex.getSchedulingWrites(action),
    };
  }

  private createDelayControlState(): SchedulerDelayControlState {
    return {
      delays: this.delays,
      computations: this.computations,
      effects: this.effects,
      dirty: this.staleness.dirty,
      pending: this.pending,
      getPullMode: () => this.pullMode,
      isPullDemandRootEffect: (action) =>
        isPullDemandRootEffect(this.pullDemandState, action),
      queueExecution: () => this.queueExecution(),
      logDebounce: (message) =>
        logger.debug("schedule-debounce", () => [message]),
    };
  }

  private createDirtyDependencyCollectionState(): DirtyDependencyCollectionState {
    return {
      collectStack: this.collectStack,
      getTrace: () => this.dirtyDependencyTraceContext,
      dirty: this.staleness.dirty,
      pending: this.pending,
      computations: this.computations,
      reverseDependencies: this.reverseDependencies,
      dependencies: this.dependencies,
      writersByEntity: this.writeIndex.writersByEntity,
      effects: this.effects,
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
      getSchedulingWrites: (action) =>
        this.writeIndex.getSchedulingWrites(action),
      isStale: (action) => this.staleness.isStale(action),
      isDemandedPullComputation: (action) =>
        isDemandedPullComputation(this.pullDemandState, action),
      queueExecution: () => this.queueExecution(),
    };
  }

  private createDependencyUpdateState(): DependencyUpdateState {
    return {
      writeIndex: this.writeIndex,
      dependencies: this.dependencies,
      dependencyGraph: this.dependencyGraphState,
      isPullMode: () => this.pullMode,
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
      computations: this.computations,
      scheduleComputationDebounce: (action) =>
        this.scheduleComputationDebounce(action),
      clearComputationDebounceState: (action) =>
        this.delays.clearComputationDebounceState(action),
      isDemandedPullComputation: (action) =>
        isDemandedPullComputation(this.pullDemandState, action),
      queueExecution: () => this.queueExecution(),
    };
  }

  private createStorageNotificationState(): StorageNotificationState {
    return {
      triggerIndex: this.triggerIndex,
      getPullMode: () => this.pullMode,
      getDiagnosisEnabled: () => this.diagnosisEnabled,
      getCollectTriggerTrace: () => this.collectTriggerTrace,
      changeGroupToActionId: this.changeGroupToActionId,
      recordCausalEdge: (edge) => {
        this.causalEdges.push(edge);
      },
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
      scheduleAffectedEffects: (target) => this.scheduleAffectedEffects(target),
    };
  }

  private createPendingPullRunnableState(): PendingPullRunnableState {
    return {
      effects: this.effects,
      isDemandedPullComputation: (action) =>
        isDemandedPullComputation(this.pullDemandState, action),
      shouldRunFirstPullComputationInDemandContext: (action) =>
        shouldRunFirstPullComputationInDemandContext(
          this.pullDemandState,
          action,
        ),
    };
  }

  private createDirtyPullRunnableState(): DirtyPullRunnableState {
    return {
      effects: this.effects,
      isDemandedPullComputation: (action) =>
        isDemandedPullComputation(this.pullDemandState, action),
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

  private createWritePropagationState(): WritePropagationState {
    return {
      triggerIndex: this.triggerIndex,
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
  }

  private createSubscriptionState(): SchedulerSubscriptionState {
    return {
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
  }

  private createPendingDependencyCollectionState(): PendingDependencyCollectionState {
    return {
      pendingDependencyCollection: this.pendingDependencyCollection,
      effects: this.effects,
      isThrottled: (action) => this.delays.isThrottled(action),
      getSchedulingWrites: (action) =>
        this.writeIndex.getSchedulingWrites(action),
      hasDependentPath: (from, to) =>
        hasDependentPath(this.pullDemandState, from, to),
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
      activePullDemandActions: this.activePullDemandActions,
      pullDemandedFirstRunComputations: this.pullDemandedFirstRunComputations,
      actionParent: this.actionParent,
      pending: this.pending,
      scheduledFirstTime: this.scheduledFirstTime,
      effects: this.effects,
      dirty: this.staleness.dirty,
      stale: this.staleness.stale,
      writeIndex: this.writeIndex,
      getPullMode: () => this.pullMode,
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
      actionChangeGroups: this.actionChangeGroups,
      changeGroupToActionId: this.changeGroupToActionId,
      pending: this.pending,
      conditionallyScheduledEffects: this.conditionallyScheduledEffects,
      reverseDependencies: this.reverseDependencies,
      dependents: this.dependents,
      effects: this.effects,
      computations: this.computations,
      pullDemandedFirstRunComputations: this.pullDemandedFirstRunComputations,
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

  private createCycleBreakState(): CycleBreakState {
    return {
      getPullMode: () => this.pullMode,
      dirty: this.staleness.dirty,
      effects: this.effects,
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
      getPullMode: () => this.pullMode,
      getCollectSettleStats: () => this.collectSettleStats,
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
      getLoopCounter: () => this.loopCounter,
      runsThisExecute: this.runsThisExecute,
      activePullDemandActions: this.activePullDemandActions,
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
      isPullDemandRootEffect: (action) =>
        isPullDemandRootEffect(this.pullDemandState, action),
      handleError: (error, action) => this.handleError(error, action),
      runAction: (action) => this.run(action),
    };
  }

  private createExecuteContinuationState(): ExecuteContinuationState {
    return {
      getPullMode: () => this.pullMode,
      pending: this.pending,
      dirty: this.staleness.dirty,
      effects: this.effects,
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
        isDemandedPullComputation(this.pullDemandState, action),
      shouldRunFirstPullComputationInDemandContext: (action) =>
        shouldRunFirstPullComputationInDemandContext(
          this.pullDemandState,
          action,
        ),
      isDebouncedComputationWaiting: (action) =>
        this.isDebouncedComputationWaiting(action),
      getNextDebounceRunTime: (action) => this.getNextDebounceRunTime(action),
      getNextEligibleRunTime: (action) =>
        this.delays.getNextEligibleRunTime(action),
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
      ) =>
        this.queueEvent(
          targetEventLink,
          targetEvent,
          targetRetries,
          targetOnCommit,
          targetDoNotLoad,
        ),
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
        this.writeIndex.getSchedulingWrites(target),
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
    };
  }

  private createGraphSnapshotState(): SchedulerGraphSnapshotState {
    const getPullMode = () => this.pullMode;
    return {
      get pullMode() {
        return getPullMode();
      },
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
        this.writeIndex.getSchedulingWrites(action),
      getNextDebounceRunTime: (action) => this.getNextDebounceRunTime(action),
      getNextEligibleRunTime: (action) =>
        this.delays.getNextEligibleRunTime(action),
      isDemandedPullComputation: (action) =>
        isDemandedPullComputation(this.pullDemandState, action),
      isLiveEffect: (action) => isLiveEffect(this.pullDemandState, action),
      isPullDemandRootEffect: (action) =>
        isPullDemandRootEffect(this.pullDemandState, action),
      getPatternId: (action) => {
        const annotated = action as Partial<TelemetryAnnotations>;
        return annotated.pattern
          ? this.runtime.patternManager.getPatternId(annotated.pattern)
          : undefined;
      },
    };
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
    this.idempotencyViolations.length = 0;
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
    return subscribeSchedulerAction(
      this.subscribeActionState,
      action,
      populateDependencies,
      options,
    );
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
    resubscribeSchedulerAction(
      this.subscribeActionState,
      action,
      log,
      options,
    );
  }

  unsubscribe(
    action: Action,
    options: { preserveChangeGroup?: boolean } = {},
  ): void {
    unsubscribeSchedulerAction(this.unsubscribeState, action, options);
  }

  async run(action: Action): Promise<any> {
    return await runSchedulerAction(this.actionRunState, action);
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
    queueSchedulerEvent(this.eventQueueState, {
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
    return buildSchedulerGraphSnapshot(this.graphSnapshotState);
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
    return collectDirtyDependenciesState(
      this.dirtyDependencyCollectionState,
      action,
      workSet,
      memo,
    );
  }

  private canAutomaticallyDebounce(action: Action): boolean {
    return canAutomaticallyDebounceState(this.delayControlState, action);
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
    return collectDirtyDependenciesForLogState(
      this.dirtyDependencyCollectionState,
      log,
      workSet,
      memo,
    );
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
    return this.writeIndex.getSchedulingWrites(action);
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
   * Runs a diagnosis for the specified duration and returns the result.
   * This is the main entry point for external callers (IPC, console).
   */
  runDiagnosis(durationMs = 5000): Promise<SchedulerDiagnosisResult> {
    return runSchedulerDiagnosis(this.diagnosisControlState, durationMs);
  }

  /**
   * Checks all computations for idempotency by enabling inline mode
   * and force-running each computation through run(). Each run()
   * automatically gets a second synchronous run for comparison.
   */
  async runIdempotencyCheck(): Promise<SchedulerDiagnosisResult> {
    return await runSchedulerIdempotencyCheck(this.diagnosisControlState);
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
    await breakCyclesIfNeeded(this.cycleBreakState, settleResult);
    this.applyAdaptiveCycleDebounce();
    this.recordExecuteEndTelemetry();
    applyExecuteContinuation(this.executeContinuationState);
    logger.timeEnd("scheduler", "execute");
  }

  private beginExecuteCycle(): void {
    // Track timing for cycle-aware debounce
    this.executeStartTime = performance.now();
    this.runsThisExecute.clear();

    // Non-settling heuristic: record execute() start
    markExecuteStart(this.settlingTracker);
  }

  private collectInitialExecuteDependencies(): {
    newActionsWithoutDependencies: Action[];
  } {
    return collectInitialExecuteDependenciesState({
      pendingDependencyCollection: this.pendingDependencyCollection,
      populateDependenciesCallbacks: this.populateDependenciesCallbacks,
      effects: this.effects,
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
        getNextEligibleRunTime: (dep) =>
          this.delays.getNextEligibleRunTime(dep),
        scheduleEventQueueWake: (notBefore) =>
          scheduleEventQueueWakeState(this.eventQueueWakeState, notBefore),
        snapshotDirtyDependencyTraceContext: (trace) =>
          snapshotDirtyDependencyTraceContext(
            this.dirtyDependencyCollectionState,
            trace,
          ),
      });
      return eventBlockingDeps;
    } finally {
      logger.timeEnd("scheduler", "execute", "event");
    }
  }

  private collectPostEventDependencies(): void {
    collectPostEventDependenciesState({
      pendingDependencyCollection: this.pendingDependencyCollection,
      populateDependenciesCallbacks: this.populateDependenciesCallbacks,
      effects: this.effects,
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
      pullMode: this.pullMode,
      pending: this.pending,
      dirty: this.staleness.dirty,
      effects: this.effects,
      newActionsWithoutDependencies,
      eventBlockingDeps,
      computationDebounceFlushSeeds: this.delays.computationDebounceFlushSeeds,
    });
  }

  private async runSettleLoop(
    initialSeeds: ReadonlySet<Action>,
  ): Promise<SchedulerSettleResult> {
    const settleResult = await runSchedulerSettleLoop(
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

    return settleResult;
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
