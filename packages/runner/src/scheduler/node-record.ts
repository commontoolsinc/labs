import type { IMemorySpaceAddress } from "../storage/interface.ts";
import type { Action } from "./types.ts";

export type NodeKind = "computation" | "effect";
export type NodeStatus = "never-ran" | "clean" | "invalid";

export interface SchedulerGateState {
  debounceMs?: number;
  noAutoDebounce?: boolean;
  throttleMs?: number;
  debounceReadyAt?: number;
  throttleReadyAt?: number;
  backoffUntil?: number;
  backoffStreak: number;
}

export interface SchedulerNode {
  readonly action: Action;
  readonly kind: NodeKind;
  parentAction?: Action;
  children?: Set<Action>;
  status: NodeStatus;
  declaredReads: IMemorySpaceAddress[];
  invalidCauses: IMemorySpaceAddress[];
  liveRefs: number;
  provisionalDemand: boolean;
  provisionalDemandPass?: number;
  gate: SchedulerGateState;
  passRuns: number;
  retries: number;
}

export class NodeRegistry {
  private records = new WeakMap<Action, SchedulerNode>();
  private childActionsByParent = new WeakMap<Action, Set<Action>>();
  private all = new Set<SchedulerNode>();
  private activeEffects = new Set<Action>();
  private activeComputations = new Set<Action>();

  readonly effects: ReadonlySet<Action> = this.activeEffects;
  readonly computations: ReadonlySet<Action> = this.activeComputations;

  register(
    action: Action,
    kind: NodeKind,
    parentAction?: Action,
  ): SchedulerNode {
    const existing = this.records.get(action);
    if (existing) {
      if (existing.kind !== kind) {
        throw new Error(
          `Scheduler action re-registered as ${kind}; was ${existing.kind}`,
        );
      }
      this.activate(existing);
      return existing;
    }

    const record: SchedulerNode = {
      action,
      kind,
      status: "never-ran",
      declaredReads: [],
      invalidCauses: [],
      liveRefs: 0,
      provisionalDemand: false,
      gate: { backoffStreak: 0 },
      passRuns: 0,
      retries: 0,
    };
    this.records.set(action, record);
    const children = this.childActionsByParent.get(action);
    if (children) {
      record.children = children;
    }
    this.activate(record);
    if (parentAction !== undefined) {
      this.captureParentAction(record, parentAction);
    }
    return record;
  }

  remove(action: Action): SchedulerNode | undefined {
    const record = this.records.get(action);
    if (!record) return undefined;
    this.all.delete(record);
    this.activeEffects.delete(action);
    this.activeComputations.delete(action);
    return record;
  }

  get(action: Action): SchedulerNode | undefined {
    return this.records.get(action);
  }

  linkParent(
    childAction: Action,
    parentAction: Action | null | undefined,
    options: { allowExisting?: boolean } = {},
  ): SchedulerNode | undefined {
    const { allowExisting = true } = options;
    if (!parentAction || parentAction === childAction) return undefined;

    const child = this.records.get(childAction);
    if (!child) return undefined;
    if (!allowExisting && child.parentAction) {
      return this.parentOf(childAction);
    }

    if (child.parentAction && child.parentAction !== parentAction) {
      this.childActionsByParent.get(child.parentAction)?.delete(child.action);
    }
    this.captureParentAction(child, parentAction);
    return this.parentOf(childAction);
  }

  parentOf(action: Action): SchedulerNode | undefined {
    const parentAction = this.records.get(action)?.parentAction;
    return parentAction ? this.records.get(parentAction) : undefined;
  }

  childrenOf(action: Action): ReadonlySet<SchedulerNode> | undefined {
    const childActions = this.childActionsByParent.get(action);
    if (!childActions) return undefined;

    const children = new Set<SchedulerNode>();
    for (const childAction of childActions) {
      const child = this.records.get(childAction);
      if (child) children.add(child);
    }
    return children;
  }

  isEffect(action: Action): boolean {
    return this.activeEffects.has(action);
  }

  isComputation(action: Action): boolean {
    return this.activeComputations.has(action);
  }

  isKnownEffect(action: Action): boolean {
    return this.records.get(action)?.kind === "effect";
  }

  isKnownComputation(action: Action): boolean {
    return this.records.get(action)?.kind === "computation";
  }

  *nodes(kind?: NodeKind): IterableIterator<SchedulerNode> {
    for (const record of this.all) {
      if (kind === undefined || record.kind === kind) {
        yield record;
      }
    }
  }

  size(kind: NodeKind): number {
    return kind === "effect"
      ? this.activeEffects.size
      : this.activeComputations.size;
  }

  isAncestor(
    sourceAction: Action,
    candidateAncestor: Action,
  ): boolean {
    let parentAction = this.records.get(sourceAction)?.parentAction;
    while (parentAction) {
      if (parentAction === candidateAncestor) {
        return true;
      }
      parentAction = this.records.get(parentAction)?.parentAction;
    }
    return false;
  }

  private captureParentAction(
    child: SchedulerNode,
    parentAction: Action,
  ): void {
    child.parentAction = parentAction;

    let children = this.childActionsByParent.get(parentAction);
    if (!children) {
      children = new Set();
      this.childActionsByParent.set(parentAction, children);
    }
    children.add(child.action);

    const parent = this.records.get(parentAction);
    if (parent) {
      parent.children = children;
    }
  }

  private activate(record: SchedulerNode): void {
    this.all.add(record);
    if (record.kind === "effect") {
      this.activeEffects.add(record.action);
      this.activeComputations.delete(record.action);
    } else {
      this.activeComputations.add(record.action);
      this.activeEffects.delete(record.action);
    }
  }
}
