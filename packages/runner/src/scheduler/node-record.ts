import type { IMemorySpaceAddress } from "../storage/interface.ts";
import type { Action } from "./types.ts";

export type NodeKind = "computation" | "effect";
export type NodeStatus = "never-ran" | "clean" | "invalid";

export interface SchedulerNode {
  readonly action: Action;
  readonly kind: NodeKind;
  parent?: SchedulerNode;
  children?: Set<SchedulerNode>;
  status: NodeStatus;
  invalidCauses: IMemorySpaceAddress[];
  liveRefs: number;
  provisionalDemand: boolean;
  passRuns: number;
  retries: number;
}

export class NodeRegistry {
  private records = new WeakMap<Action, SchedulerNode>();
  private all = new Set<SchedulerNode>();
  private activeEffects = new Set<Action>();
  private activeComputations = new Set<Action>();

  readonly effects: ReadonlySet<Action> = this.activeEffects;
  readonly computations: ReadonlySet<Action> = this.activeComputations;

  register(
    action: Action,
    kind: NodeKind,
    parent?: SchedulerNode,
  ): SchedulerNode {
    const existing = this.records.get(action);
    if (existing) {
      if (existing.kind !== kind) {
        throw new Error(
          `Scheduler action re-registered as ${kind}; was ${existing.kind}`,
        );
      }
      if (parent !== undefined) existing.parent = parent;
      this.activate(existing);
      return existing;
    }

    const record: SchedulerNode = {
      action,
      kind,
      ...(parent !== undefined ? { parent } : {}),
      status: "never-ran",
      invalidCauses: [],
      liveRefs: 0,
      provisionalDemand: false,
      passRuns: 0,
      retries: 0,
    };
    this.records.set(action, record);
    this.activate(record);
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
