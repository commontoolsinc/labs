import type { ActionStats } from "../telemetry.ts";
import {
  AUTO_DEBOUNCE_DELAY_MS,
  AUTO_DEBOUNCE_MIN_RUNS,
  AUTO_DEBOUNCE_THRESHOLD_MS,
} from "./constants.ts";
import type { Action } from "./types.ts";

interface DebouncedComputationContext {
  readonly computations: ReadonlySet<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly dirty: ReadonlySet<Action>;
  readonly pending: Set<Action>;
  readonly queueExecution: () => void;
  readonly logDebounce: (message: string) => void;
}

export class SchedulerDelays {
  private readonly actionDebounce = new WeakMap<Action, number>();
  private readonly actionThrottle = new WeakMap<Action, number>();
  private readonly actionHasRun = new WeakSet<Action>();
  private readonly computationDebounceReady = new WeakSet<Action>();
  private readonly computationDebounceReadyAt = new WeakMap<Action, number>();
  readonly computationDebounceFlushSeeds = new Set<Action>();
  // Actions that opt out of auto-debounce (inverted: true means NO auto-debounce).
  private readonly noDebounce = new WeakMap<Action, boolean>();
  private readonly debounceTimers = new WeakMap<
    Action,
    ReturnType<typeof setTimeout>
  >();
  private readonly activeDebounceTimers = new Set<
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly state: {
      readonly actionStats: ReadonlyMap<string, ActionStats>;
      readonly getActionId: (action: Action) => string;
    },
  ) {}

  setDebounce(action: Action, ms: number): void {
    if (ms <= 0) {
      this.actionDebounce.delete(action);
      this.clearComputationDebounceState(action);
    } else {
      this.actionDebounce.set(action, ms);
    }
  }

  getDebounce(action: Action): number | undefined {
    return this.actionDebounce.get(action);
  }

  clearDebounce(action: Action): void {
    this.actionDebounce.delete(action);
    this.cancelDebounceTimer(action);
    this.clearComputationDebounceState(action, { cancelTimer: false });
  }

  setNoDebounce(action: Action, optOut: boolean): void {
    if (optOut) {
      this.noDebounce.set(action, true);
    } else {
      this.noDebounce.delete(action);
    }
  }

  getNoDebounce(action: Action): boolean | undefined {
    return this.noDebounce.get(action);
  }

  canAutomaticallyDebounce(
    action: Action,
    context: {
      readonly effects: ReadonlySet<Action>;
      readonly isPullDemandRootEffect: (action: Action) => boolean;
    },
  ): boolean {
    if (this.noDebounce.get(action)) return false;
    if (!context.effects.has(action)) return false;
    return !context.isPullDemandRootEffect(action);
  }

  maybeAutoDebounce(
    action: Action,
    context: {
      readonly canAutomaticallyDebounce: (action: Action) => boolean;
    },
  ):
    | {
      actionId: string;
      averageTime: number;
      delayMs: number;
      thresholdMs: number;
    }
    | undefined {
    // Auto-debouncing computations in push mode makes observable derived state
    // lag behind writes. Pull-mode demand roots are effects, but delaying them
    // can leave a live renderer observing stale materialized data.
    if (!context.canAutomaticallyDebounce(action)) return undefined;

    // Check if already has a manual debounce set.
    if (this.actionDebounce.has(action)) return undefined;

    const actionId = this.state.getActionId(action);
    const stats = this.state.actionStats.get(actionId);
    if (!stats) return undefined;

    // Need minimum runs before auto-detecting.
    if (stats.runCount < AUTO_DEBOUNCE_MIN_RUNS) return undefined;

    // Check if action is slow enough to warrant debouncing.
    if (stats.averageTime < AUTO_DEBOUNCE_THRESHOLD_MS) return undefined;

    this.actionDebounce.set(action, AUTO_DEBOUNCE_DELAY_MS);
    return {
      actionId,
      averageTime: stats.averageTime,
      delayMs: AUTO_DEBOUNCE_DELAY_MS,
      thresholdMs: AUTO_DEBOUNCE_THRESHOLD_MS,
    };
  }

  markActionHasRun(action: Action): void {
    this.actionHasRun.add(action);
  }

  hasActionRun(action: Action): boolean {
    return this.actionHasRun.has(action);
  }

  clearComputationDebounceState(
    action: Action,
    options: { cancelTimer?: boolean } = {},
  ): void {
    this.computationDebounceReady.delete(action);
    this.computationDebounceReadyAt.delete(action);
    this.computationDebounceFlushSeeds.delete(action);
    if (options.cancelTimer ?? true) {
      this.cancelDebounceTimer(action);
    }
  }

  cancelDebounceTimer(action: Action): void {
    const timer = this.debounceTimers.get(action);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(action);
      this.activeDebounceTimers.delete(timer);
    }
  }

  getNextDebounceRunTime(
    action: Action,
    context: {
      readonly computations: ReadonlySet<Action>;
      readonly effects: ReadonlySet<Action>;
      readonly dirty: ReadonlySet<Action>;
    },
  ): number | undefined {
    if (!this.shouldDebouncePullComputation(action, context)) {
      return undefined;
    }
    if (!context.dirty.has(action)) return undefined;
    if (this.computationDebounceReady.has(action)) return undefined;
    return this.computationDebounceReadyAt.get(action);
  }

  isDebouncedComputationWaiting(
    action: Action,
    context: DebouncedComputationContext,
  ): boolean {
    if (
      this.shouldDebouncePullComputation(action, context) &&
      context.dirty.has(action) &&
      !this.computationDebounceReady.has(action) &&
      this.computationDebounceReadyAt.get(action) === undefined
    ) {
      this.scheduleComputationDebounce(action, context);
    }
    const readyAt = this.getNextDebounceRunTime(action, context);
    return readyAt !== undefined && readyAt > performance.now();
  }

  scheduleComputationDebounce(
    action: Action,
    context: DebouncedComputationContext,
  ): void {
    if (!this.shouldDebouncePullComputation(action, context)) return;
    const debounceMs = this.actionDebounce.get(action);
    if (!debounceMs || debounceMs <= 0) return;

    this.computationDebounceReady.delete(action);
    this.cancelDebounceTimer(action);

    const readyAt = performance.now() + debounceMs;
    this.computationDebounceReadyAt.set(action, readyAt);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(action);
      this.activeDebounceTimers.delete(timer);
      this.computationDebounceReadyAt.delete(action);

      if (!context.computations.has(action) || !context.dirty.has(action)) {
        return;
      }

      this.computationDebounceReady.add(action);
      this.computationDebounceFlushSeeds.add(action);
      context.pending.add(action);
      context.queueExecution();
    }, debounceMs);

    this.debounceTimers.set(action, timer);
    this.activeDebounceTimers.add(timer);
    context.logDebounce(
      `[DEBOUNCE] Computation ${this.state.getActionId(action)} ` +
        `trailing flush scheduled for ${debounceMs}ms`,
    );
  }

  scheduleWithDebounce(
    action: Action,
    context: {
      readonly pending: Set<Action>;
      readonly queueExecution: () => void;
      readonly logDebounce: (message: string) => void;
    },
  ): void {
    const debounceMs = this.actionDebounce.get(action);

    if (!debounceMs || debounceMs <= 0) {
      // No debounce - add immediately.
      context.pending.add(action);
      context.queueExecution();
      return;
    }

    // Clear existing timer if any.
    this.cancelDebounceTimer(action);

    // Set new timer.
    const timer = setTimeout(() => {
      this.debounceTimers.delete(action);
      this.activeDebounceTimers.delete(timer);
      context.pending.add(action);
      context.queueExecution();
    }, debounceMs);

    this.debounceTimers.set(action, timer);
    this.activeDebounceTimers.add(timer);
    context.logDebounce(
      `[DEBOUNCE] Action ${this.state.getActionId(action)} ` +
        `debounced for ${debounceMs}ms`,
    );
  }

  setThrottle(action: Action, ms: number): void {
    if (ms <= 0) {
      this.actionThrottle.delete(action);
    } else {
      this.actionThrottle.set(action, ms);
    }
  }

  getThrottle(action: Action): number | undefined {
    return this.actionThrottle.get(action);
  }

  clearThrottle(action: Action): void {
    this.actionThrottle.delete(action);
  }

  isThrottled(action: Action, now = performance.now()): boolean {
    const nextEligibleAt = this.getNextEligibleRunTime(action);
    return nextEligibleAt !== undefined && nextEligibleAt > now;
  }

  getNextEligibleRunTime(action: Action): number | undefined {
    const throttleMs = this.actionThrottle.get(action);
    if (!throttleMs) return undefined;

    const stats = this.state.actionStats.get(this.state.getActionId(action));
    if (!stats) return undefined;

    return stats.lastRunTimestamp + throttleMs;
  }

  hasActiveDebounceTimer(action: Action): boolean {
    return this.debounceTimers.has(action);
  }

  clearActiveDebounceTimers(): void {
    for (const timer of this.activeDebounceTimers) {
      clearTimeout(timer);
    }
    this.activeDebounceTimers.clear();
  }

  private shouldDebouncePullComputation(
    action: Action,
    context: {
      readonly computations: ReadonlySet<Action>;
      readonly effects: ReadonlySet<Action>;
    },
  ): boolean {
    const debounceMs = this.actionDebounce.get(action);
    return context.computations.has(action) &&
      !context.effects.has(action) &&
      this.actionHasRun.has(action) &&
      debounceMs !== undefined &&
      debounceMs > 0;
  }
}
