import type { ActionStats } from "../telemetry.ts";
import {
  AUTO_DEBOUNCE_DELAY_MS,
  AUTO_DEBOUNCE_MIN_RUNS,
  AUTO_DEBOUNCE_THRESHOLD_MS,
} from "./constants.ts";
import type {
  NodeRegistry,
  SchedulerGateState,
  SchedulerNode,
} from "./node-record.ts";
import type { Action } from "./types.ts";

interface DebouncedComputationContext {
  readonly computations: ReadonlySet<Action>;
  readonly effects: ReadonlySet<Action>;
  readonly isInvalid: (action: Action) => boolean;
  readonly pending: Set<Action>;
  readonly queueExecution: () => void;
  readonly logDebounce: (message: string) => void;
  readonly shouldDebounceFirstRun?: (action: Action) => boolean;
}

export class SchedulerGates {
  private readonly stagedGates = new WeakMap<Action, SchedulerGateState>();
  private readonly computationDebounceReady = new WeakSet<Action>();
  readonly computationDebounceFlushSeeds = new Set<Action>();
  private readonly debounceTimers = new WeakMap<
    Action,
    ReturnType<typeof setTimeout>
  >();
  private readonly activeDebounceTimers = new Set<
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly state: {
      readonly nodes: NodeRegistry;
      readonly actionStats: ReadonlyMap<string, ActionStats>;
      readonly getActionId: (action: Action) => string;
    },
  ) {}

  adopt(action: Action): void {
    const record = this.state.nodes.get(action);
    const staged = this.stagedGates.get(action);
    if (!record || !staged) return;
    record.gate = { ...record.gate, ...staged };
    this.stagedGates.delete(action);
  }

  setDebounce(action: Action, ms: number): void {
    const gate = this.mutableGate(action);
    if (ms <= 0) {
      delete gate.debounceMs;
      this.clearComputationDebounceState(action);
    } else {
      gate.debounceMs = ms;
    }
  }

  getDebounce(action: Action): number | undefined {
    return this.gate(action)?.debounceMs;
  }

  clearDebounce(action: Action): void {
    const gate = this.gate(action);
    if (gate) delete gate.debounceMs;
    this.cancelDebounceTimer(action);
    this.clearComputationDebounceState(action, { cancelTimer: false });
  }

  setNoDebounce(action: Action, optOut: boolean): void {
    const gate = this.mutableGate(action);
    if (optOut) {
      gate.noAutoDebounce = true;
    } else {
      delete gate.noAutoDebounce;
    }
  }

  getNoDebounce(action: Action): boolean | undefined {
    return this.gate(action)?.noAutoDebounce ? true : undefined;
  }

  canAutomaticallyDebounce(
    action: Action,
    context: {
      readonly effects: ReadonlySet<Action>;
    },
  ): boolean {
    if (this.gate(action)?.noAutoDebounce) return false;
    return context.effects.has(action);
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
    if (!context.canAutomaticallyDebounce(action)) return undefined;

    const gate = this.mutableGate(action);
    if (gate.debounceMs !== undefined) return undefined;

    const actionId = this.state.getActionId(action);
    const stats = this.state.actionStats.get(actionId);
    if (!stats) return undefined;
    if (stats.runCount < AUTO_DEBOUNCE_MIN_RUNS) return undefined;
    if (stats.averageTime < AUTO_DEBOUNCE_THRESHOLD_MS) return undefined;

    gate.debounceMs = AUTO_DEBOUNCE_DELAY_MS;
    return {
      actionId,
      averageTime: stats.averageTime,
      delayMs: AUTO_DEBOUNCE_DELAY_MS,
      thresholdMs: AUTO_DEBOUNCE_THRESHOLD_MS,
    };
  }

  markActionHasRun(action: Action): void {
    this.armThrottleFromStats(action);
  }

  onInvalidated(
    node: SchedulerNode,
    now = performance.now(),
    context?: DebouncedComputationContext,
  ): void {
    if (!context || !this.shouldDebouncePullComputation(node.action, context)) {
      return;
    }
    this.armComputationDebounce(node.action, context, now);
  }

  onRunCompleted(
    node: SchedulerNode,
    context: {
      readonly canAutomaticallyDebounce: (action: Action) => boolean;
    },
    _now = performance.now(),
  ):
    | {
      actionId: string;
      averageTime: number;
      delayMs: number;
      thresholdMs: number;
    }
    | undefined {
    this.armThrottleFromStats(node.action);
    return this.maybeAutoDebounce(node.action, context);
  }

  clearComputationDebounceState(
    action: Action,
    options: { cancelTimer?: boolean } = {},
  ): void {
    const gate = this.gate(action);
    this.computationDebounceReady.delete(action);
    if (gate) delete gate.debounceReadyAt;
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
      readonly isInvalid: (action: Action) => boolean;
    },
  ): number | undefined {
    if (!this.shouldDebouncePullComputation(action, context)) {
      return undefined;
    }
    if (!context.isInvalid(action)) return undefined;
    if (this.computationDebounceReady.has(action)) return undefined;
    return this.gate(action)?.debounceReadyAt;
  }

  isDebouncedComputationWaiting(
    action: Action,
    context: DebouncedComputationContext,
  ): boolean {
    if (
      this.shouldDebouncePullComputation(action, context) &&
      context.isInvalid(action) &&
      !this.computationDebounceReady.has(action) &&
      this.gate(action)?.debounceReadyAt === undefined
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
    const record = this.state.nodes.get(action);
    if (!record) return;
    this.onInvalidated(record, performance.now(), context);
  }

  scheduleWithDebounce(
    action: Action,
    context: {
      readonly pending: Set<Action>;
      readonly queueExecution: () => void;
      readonly logDebounce: (message: string) => void;
    },
  ): void {
    const debounceMs = this.gate(action)?.debounceMs;

    if (!debounceMs || debounceMs <= 0) {
      context.pending.add(action);
      context.queueExecution();
      return;
    }

    this.cancelDebounceTimer(action);

    const gate = this.mutableGate(action);
    const readyAt = performance.now() + debounceMs;
    gate.debounceReadyAt = readyAt;
    const timer = setTimeout(() => {
      this.debounceTimers.delete(action);
      this.activeDebounceTimers.delete(timer);
      delete this.gate(action)?.debounceReadyAt;
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
    const gate = this.mutableGate(action);
    if (ms <= 0) {
      delete gate.throttleMs;
      delete gate.throttleReadyAt;
    } else {
      gate.throttleMs = ms;
      this.armThrottleFromStats(action);
    }
  }

  getThrottle(action: Action): number | undefined {
    return this.gate(action)?.throttleMs;
  }

  clearThrottle(action: Action): void {
    const gate = this.gate(action);
    if (!gate) return;
    delete gate.throttleMs;
    delete gate.throttleReadyAt;
  }

  isThrottled(action: Action, now = performance.now()): boolean {
    const record = this.state.nodes.get(action);
    if (!record) return false;
    return (record.gate.throttleReadyAt ?? 0) > now;
  }

  eligibleAt(node: SchedulerNode): number {
    return Math.max(
      node.gate.debounceReadyAt ?? 0,
      node.gate.throttleReadyAt ?? 0,
      node.gate.backoffUntil ?? 0,
    );
  }

  isEligible(node: SchedulerNode, now = performance.now()): boolean {
    return now >= this.eligibleAt(node);
  }

  getNextEligibleRunTime(
    action: Action,
    now = performance.now(),
  ): number | undefined {
    const record = this.state.nodes.get(action);
    if (!record) return undefined;
    const eligibleAt = this.eligibleAt(record);
    return eligibleAt > now ? eligibleAt : undefined;
  }

  nextWake(
    candidates: Iterable<SchedulerNode>,
    now = performance.now(),
  ): number | undefined {
    let wakeAt: number | undefined;
    for (const candidate of candidates) {
      const eligibleAt = this.eligibleAt(candidate);
      if (eligibleAt <= now) continue;
      wakeAt = wakeAt === undefined ? eligibleAt : Math.min(wakeAt, eligibleAt);
    }
    return wakeAt;
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

  clearBackoff(node: SchedulerNode): void {
    delete node.gate.backoffUntil;
    node.gate.backoffStreak = 0;
  }

  private armComputationDebounce(
    action: Action,
    context: DebouncedComputationContext,
    now: number,
  ): void {
    const debounceMs = this.gate(action)?.debounceMs;
    if (!debounceMs || debounceMs <= 0) return;

    this.computationDebounceReady.delete(action);
    this.cancelDebounceTimer(action);

    const gate = this.mutableGate(action);
    const readyAt = now + debounceMs;
    gate.debounceReadyAt = readyAt;
    const timer = setTimeout(() => {
      this.debounceTimers.delete(action);
      this.activeDebounceTimers.delete(timer);
      delete this.gate(action)?.debounceReadyAt;

      if (!context.computations.has(action) || !context.isInvalid(action)) {
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

  private shouldDebouncePullComputation(
    action: Action,
    context: {
      readonly computations: ReadonlySet<Action>;
      readonly effects: ReadonlySet<Action>;
      readonly shouldDebounceFirstRun?: (action: Action) => boolean;
    },
  ): boolean {
    const gate = this.gate(action);
    const debounceMs = gate?.debounceMs;
    const hasRun = this.state.nodes.get(action)?.status !== "never-ran";
    return context.computations.has(action) &&
      !context.effects.has(action) &&
      (hasRun || context.shouldDebounceFirstRun?.(action) === true) &&
      debounceMs !== undefined &&
      debounceMs > 0;
  }

  private armThrottleFromStats(action: Action): void {
    const gate = this.gate(action);
    const throttleMs = gate?.throttleMs;
    if (!gate || !throttleMs || throttleMs <= 0) {
      if (gate) delete gate.throttleReadyAt;
      return;
    }

    const stats = this.state.actionStats.get(this.state.getActionId(action));
    if (!stats) {
      delete gate.throttleReadyAt;
      return;
    }
    gate.throttleReadyAt = stats.lastRunTimestamp + throttleMs;
  }

  private gate(action: Action): SchedulerGateState | undefined {
    return this.state.nodes.get(action)?.gate ?? this.stagedGates.get(action);
  }

  private mutableGate(action: Action): SchedulerGateState {
    const record = this.state.nodes.get(action);
    if (record) return record.gate;

    let gate = this.stagedGates.get(action);
    if (!gate) {
      gate = { backoffStreak: 0 };
      this.stagedGates.set(action, gate);
    }
    return gate;
  }
}
