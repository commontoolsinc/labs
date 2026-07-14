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
  /** Leading-edge grace for a remote invalidation of an exactly claimed
   * computation. Local invalidations release it immediately. */
  claimedRemoteSpeculationReadyAt?: number;
  backoffUntil?: number;
  backoffStreak: number;
  /** Backoff passes charged to the current idle-wait episode. */
  convergenceHoldPasses: number;
}

export interface SchedulerNode {
  readonly action: Action;
  // Monotonic registration ordinal, assigned once when the record is first
  // created and preserved across re-subscribe and re-registration (first
  // registration wins). The deterministic tie-break in `topologicalSort`
  // (spec §7.4 rule 3) falls back to this so run order does not depend on the
  // order actions were invalidated / arrived over the network.
  readonly ordinal: number;
  // Mutable for the one sanctioned transition: computation → effect
  // promotion on re-registration ("once an effect, stays an effect").
  kind: NodeKind;
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
}

export class NodeRegistry {
  private records = new WeakMap<Action, SchedulerNode>();
  private childActionsByParent = new WeakMap<Action, Set<Action>>();
  private all = new Set<SchedulerNode>();
  private activeEffects = new Set<Action>();
  private activeComputations = new Set<Action>();
  // Active nodes whose status is `invalid` or `never-ran` — i.e. the nodes
  // `isInvalidOrNeverRan` would match. Maintained incrementally through
  // setStatus/activate/remove so the event-preflight gate (decision 15) and
  // the pull seed scans can iterate the (small) invalid set instead of every
  // registered node. Membership tracks both status AND active membership:
  // a removed node drops out even though its record persists in `records`.
  private invalidNodes = new Set<Action>();
  // Source of monotonic registration ordinals (see SchedulerNode.ordinal).
  private nextOrdinal = 0;
  // Invalidates derived indexes of active effect registration surfaces. Effect
  // annotations are read at registration time, so every effect registration
  // (including reactivation and computation -> effect promotion) advances the
  // generation; removal advances it only when an active effect is removed.
  private effectRegistrationGeneration = 0;

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
        // v1 parity: a computation re-subscribed with `isEffect: true` is
        // promoted ("once an effect, stays an effect"). Demotion has no
        // sanctioned caller and stays an error.
        if (existing.kind === "computation" && kind === "effect") {
          existing.kind = "effect";
        } else {
          throw new Error(
            `Scheduler action re-registered as ${kind}; was ${existing.kind}`,
          );
        }
      }
      this.activate(existing);
      if (existing.kind === "effect") {
        this.effectRegistrationGeneration++;
      }
      return existing;
    }

    const record: SchedulerNode = {
      action,
      ordinal: this.nextOrdinal++,
      kind,
      status: "never-ran",
      declaredReads: [],
      invalidCauses: [],
      liveRefs: 0,
      provisionalDemand: false,
      gate: { backoffStreak: 0, convergenceHoldPasses: 0 },
      passRuns: 0,
    };
    this.records.set(action, record);
    const children = this.childActionsByParent.get(action);
    if (children) {
      record.children = children;
    }
    this.activate(record);
    if (record.kind === "effect") {
      this.effectRegistrationGeneration++;
    }
    if (parentAction !== undefined) {
      this.captureParentAction(record, parentAction);
    }
    return record;
  }

  remove(action: Action): SchedulerNode | undefined {
    const record = this.records.get(action);
    if (!record) return undefined;
    this.all.delete(record);
    if (this.activeEffects.delete(action)) {
      this.effectRegistrationGeneration++;
    }
    this.activeComputations.delete(action);
    this.invalidNodes.delete(action);
    return record;
  }

  get(action: Action): SchedulerNode | undefined {
    return this.records.get(action);
  }

  /**
   * The stable registration ordinal for `action`, or `undefined` if it was
   * never registered. Assigned once at first registration and preserved
   * across re-subscribe/re-registration (the record persists in `records`
   * even after `remove`), so it is a stable, arrival-order-independent
   * tie-break key for `topologicalSort` (spec §7.4 rule 3).
   */
  getRegistrationOrdinal(action: Action): number | undefined {
    return this.records.get(action)?.ordinal;
  }

  /**
   * Monotonic invalidation token for indexes derived from active effects and
   * their registration-time annotations.
   */
  getEffectRegistrationGeneration(): number {
    return this.effectRegistrationGeneration;
  }

  /**
   * The only sanctioned status mutator. Routing every status write here keeps
   * the `invalidNodes` index in lockstep with `record.status` (the index is a
   * derived view, never authoritative). Callers keep their own transition
   * guards (e.g. clean→invalid only); this just assigns and re-indexes.
   */
  setStatus(action: Action, status: NodeStatus): void {
    const record = this.records.get(action);
    if (!record) return;
    record.status = status;
    this.syncInvalidIndex(record);
  }

  /**
   * Active nodes whose status is `invalid` or `never-ran`. Seeds the inverted
   * event-preflight walk (decision 15) and the pull scheduling scans.
   */
  getInvalidNodes(): ReadonlySet<Action> {
    return this.invalidNodes;
  }

  private syncInvalidIndex(record: SchedulerNode): void {
    if (
      this.all.has(record) &&
      (record.status === "invalid" || record.status === "never-ran")
    ) {
      this.invalidNodes.add(record.action);
    } else {
      this.invalidNodes.delete(record.action);
    }
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

  /**
   * The captured parent ACTION, independent of whether the parent's record
   * is (still/already) registered — exact parity with the v1 parent WeakMap.
   * Demand and trace checks key off action objects, so they must see the
   * parent through registration churn windows where parentOf() is undefined.
   */
  parentActionOf(action: Action): Action | undefined {
    return this.records.get(action)?.parentAction;
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
    // A freshly registered node is born `never-ran`; a reactivated record
    // re-enters the index iff its (preserved) status still qualifies.
    this.syncInvalidIndex(record);
  }
}
