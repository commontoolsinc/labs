import type { Action } from "./types.ts";

export class SchedulerStaleness {
  readonly dirty = new Set<Action>();
  readonly stale = new Set<Action>();
  private upstreamStaleWriters = new WeakMap<Action, Set<Action>>();
  private upstreamStaleCount = new WeakMap<Action, number>();

  constructor(
    private readonly state: {
      readonly dependents: WeakMap<Action, Set<Action>>;
    },
  ) {}

  isDirty(action: Action): boolean {
    return this.dirty.has(action);
  }

  isStale(action: Action): boolean {
    return this.stale.has(action);
  }

  getUpstreamStaleCount(action: Action): number {
    return this.upstreamStaleCount.get(action) ?? 0;
  }

  markDirectDirty(action: Action): boolean {
    if (this.dirty.has(action)) return false;

    this.dirty.add(action);
    this.setStaleFromInputs(action);
    return true;
  }

  clearDirectDirty(action: Action): boolean {
    if (!this.dirty.delete(action)) return false;
    this.setStaleFromInputs(action);
    return true;
  }

  forceClearStale(action: Action): void {
    this.upstreamStaleWriters.delete(action);
    this.upstreamStaleCount.delete(action);
    if (!this.stale.delete(action)) return;
    this.propagateStaleTransition(action, false);
  }

  clearAll(): void {
    this.dirty.clear();
    this.stale.clear();
    this.resetUpstreamStaleState();
  }

  resetUpstreamStaleState(): void {
    this.upstreamStaleWriters = new WeakMap();
    this.upstreamStaleCount = new WeakMap();
  }

  setStaleFromInputs(action: Action): void {
    const shouldBeStale = this.dirty.has(action) ||
      this.getUpstreamStaleCount(action) > 0;
    const isCurrentlyStale = this.stale.has(action);
    if (shouldBeStale === isCurrentlyStale) return;

    if (shouldBeStale) {
      this.stale.add(action);
    } else {
      this.stale.delete(action);
    }
    this.propagateStaleTransition(action, shouldBeStale);
  }

  addStaleUpstream(writer: Action, dependent: Action): void {
    let writers = this.upstreamStaleWriters.get(dependent);
    if (!writers) {
      writers = new Set();
      this.upstreamStaleWriters.set(dependent, writers);
    }
    if (writers.has(writer)) return;

    writers.add(writer);
    this.upstreamStaleCount.set(dependent, writers.size);
    this.setStaleFromInputs(dependent);
  }

  removeStaleUpstream(writer: Action, dependent: Action): void {
    const writers = this.upstreamStaleWriters.get(dependent);
    if (!writers?.delete(writer)) return;

    if (writers.size === 0) {
      this.upstreamStaleWriters.delete(dependent);
      this.upstreamStaleCount.delete(dependent);
    } else {
      this.upstreamStaleCount.set(dependent, writers.size);
    }
    this.setStaleFromInputs(dependent);
  }

  private propagateStaleTransition(
    action: Action,
    becameStale: boolean,
  ): void {
    const dependents = this.state.dependents.get(action);
    if (!dependents) return;

    const delta = becameStale ? 1 : -1;
    for (const dependent of dependents) {
      if (delta > 0) {
        this.addStaleUpstream(action, dependent);
      } else {
        this.removeStaleUpstream(action, dependent);
      }
    }
  }
}

export interface DirtySchedulingState {
  readonly staleness: SchedulerStaleness;
  readonly computations: ReadonlySet<Action>;
  readonly scheduleComputationDebounce: (action: Action) => void;
  readonly clearComputationDebounceState: (action: Action) => void;
  readonly isDemandedPullComputation: (action: Action) => boolean;
  readonly queueExecution: () => void;
}

export function isActionStale(
  staleness: SchedulerStaleness,
  action: Action,
): boolean {
  return staleness.isStale(action);
}

export function getUpstreamStaleCount(
  staleness: SchedulerStaleness,
  action: Action,
): number {
  return staleness.getUpstreamStaleCount(action);
}

export function markDirectDirty(
  staleness: SchedulerStaleness,
  action: Action,
): boolean {
  return staleness.markDirectDirty(action);
}

export function markSchedulerDirty(
  state: DirtySchedulingState,
  action: Action,
): void {
  state.staleness.markDirectDirty(action);
  state.scheduleComputationDebounce(action);
  if (state.isDemandedPullComputation(action)) {
    state.queueExecution();
  }
}

export function clearSchedulerDirectDirty(
  state: DirtySchedulingState,
  action: Action,
): boolean {
  if (!state.staleness.isDirty(action)) return false;
  if (state.computations.has(action)) {
    state.clearComputationDebounceState(action);
  }
  return state.staleness.clearDirectDirty(action);
}

export function clearSchedulerDirty(
  state: DirtySchedulingState,
  action: Action,
): void {
  clearSchedulerDirectDirty(state, action);
}
