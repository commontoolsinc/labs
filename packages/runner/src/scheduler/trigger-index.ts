import {
  addressesToPathByEntity,
  arraysOverlap,
  determineTriggeredActions,
  nonRecursiveReadMayOverlapWrite,
  type SortedAndCompactPaths,
} from "../reactive-dependencies.ts";
import type { Cancel } from "../cancel.ts";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type {
  IMemoryChange,
  IMemorySpaceAddress,
} from "../storage/interface.ts";
import { entityKey } from "./keys.ts";
import type { Action, SpaceScopeAndURI } from "./types.ts";

export interface TriggerIndexState {
  readonly triggers: Map<
    SpaceScopeAndURI,
    Map<Action, SortedAndCompactPaths>
  >;
  readonly nonRecursiveTriggers: Map<
    SpaceScopeAndURI,
    Map<Action, SortedAndCompactPaths>
  >;
  addActionReads(
    action: Action,
    reads: IMemorySpaceAddress[],
    shallowReads: IMemorySpaceAddress[],
  ): {
    entities: Set<SpaceScopeAndURI>;
    triggerPathsByEntity: Map<SpaceScopeAndURI, SortedAndCompactPaths>;
  };
  removeActionFromEntities(
    action: Action,
    entities: Iterable<SpaceScopeAndURI>,
  ): void;
  removeSpace(space: MemorySpace): void;
  collectReadersForWrite(write: IMemorySpaceAddress): Set<Action>;
  hasRegisteredTriggers(): boolean;
  clear(): void;
  collectTriggeredActionsForChange(
    space: MemorySpace,
    change: IMemoryChange,
  ): {
    entity: SpaceScopeAndURI;
    hasMatchingTriggerPaths: boolean;
    triggeredActions: Action[];
  };
}

export interface TriggerSubscriptionState extends TriggerIndexState {
  readonly cancels: WeakMap<Action, Cancel>;
  readonly getActionId: (action: Action) => string;
  readonly onTriggerUnsubscribe?: (
    actionId: string,
    entityCount: number,
  ) => void;
}

function removeActionFromTriggerMap(
  triggerMap: Map<SpaceScopeAndURI, Map<Action, SortedAndCompactPaths>>,
  entity: SpaceScopeAndURI,
  action: Action,
): void {
  const pathsByAction = triggerMap.get(entity);
  if (!pathsByAction) return;

  pathsByAction.delete(action);
  if (pathsByAction.size === 0) {
    triggerMap.delete(entity);
  }
}

function removeTriggerMapSpace(
  triggerMap: Map<SpaceScopeAndURI, Map<Action, SortedAndCompactPaths>>,
  spacePrefix: string,
): void {
  for (const entity of triggerMap.keys()) {
    if (entity.startsWith(spacePrefix)) {
      triggerMap.delete(entity);
    }
  }
}

export class SchedulerTriggerSubscriptions implements TriggerSubscriptionState {
  constructor(
    private readonly state: {
      readonly triggerIndex: TriggerIndexState;
      readonly cancels: WeakMap<Action, Cancel>;
      readonly getActionId: (action: Action) => string;
      readonly onTriggerUnsubscribe?: (
        actionId: string,
        entityCount: number,
      ) => void;
    },
  ) {}

  get triggers(): TriggerIndexState["triggers"] {
    return this.state.triggerIndex.triggers;
  }

  get nonRecursiveTriggers(): TriggerIndexState["nonRecursiveTriggers"] {
    return this.state.triggerIndex.nonRecursiveTriggers;
  }

  get cancels(): WeakMap<Action, Cancel> {
    return this.state.cancels;
  }

  get getActionId(): (action: Action) => string {
    return this.state.getActionId;
  }

  get onTriggerUnsubscribe():
    | ((actionId: string, entityCount: number) => void)
    | undefined {
    return this.state.onTriggerUnsubscribe;
  }

  addActionReads(
    action: Action,
    reads: IMemorySpaceAddress[],
    shallowReads: IMemorySpaceAddress[],
  ): {
    entities: Set<SpaceScopeAndURI>;
    triggerPathsByEntity: Map<SpaceScopeAndURI, SortedAndCompactPaths>;
  } {
    return this.state.triggerIndex.addActionReads(action, reads, shallowReads);
  }

  removeActionFromEntities(
    action: Action,
    entities: Iterable<SpaceScopeAndURI>,
  ): void {
    this.state.triggerIndex.removeActionFromEntities(action, entities);
  }

  removeSpace(space: MemorySpace): void {
    this.state.triggerIndex.removeSpace(space);
  }

  collectReadersForWrite(write: IMemorySpaceAddress): Set<Action> {
    return this.state.triggerIndex.collectReadersForWrite(write);
  }

  hasRegisteredTriggers(): boolean {
    return this.state.triggerIndex.hasRegisteredTriggers();
  }

  clear(): void {
    this.state.triggerIndex.clear();
  }

  collectTriggeredActionsForChange(
    space: MemorySpace,
    change: IMemoryChange,
  ): {
    entity: SpaceScopeAndURI;
    hasMatchingTriggerPaths: boolean;
    triggeredActions: Action[];
  } {
    return this.state.triggerIndex.collectTriggeredActionsForChange(
      space,
      change,
    );
  }
}

export class SchedulerTriggerIndex implements TriggerIndexState {
  readonly triggers = new Map<
    SpaceScopeAndURI,
    Map<Action, SortedAndCompactPaths>
  >();
  readonly nonRecursiveTriggers = new Map<
    SpaceScopeAndURI,
    Map<Action, SortedAndCompactPaths>
  >();

  addActionReads(
    action: Action,
    reads: IMemorySpaceAddress[],
    shallowReads: IMemorySpaceAddress[],
  ): {
    entities: Set<SpaceScopeAndURI>;
    triggerPathsByEntity: Map<SpaceScopeAndURI, SortedAndCompactPaths>;
  } {
    const pathsByEntity = addressesToPathByEntity(reads);
    const nonRecursivePathsByEntity = addressesToPathByEntity(shallowReads);
    const entities = new Set<SpaceScopeAndURI>();
    const triggerPathsByEntity = new Map<
      SpaceScopeAndURI,
      SortedAndCompactPaths
    >();

    for (const [spaceAndURI, paths] of pathsByEntity) {
      entities.add(spaceAndURI);
      let pathsByAction = this.triggers.get(spaceAndURI);
      if (!pathsByAction) {
        pathsByAction = new Map();
        this.triggers.set(spaceAndURI, pathsByAction);
      }
      pathsByAction.set(action, paths);
      triggerPathsByEntity.set(spaceAndURI, paths);
    }

    for (const [spaceAndURI, paths] of nonRecursivePathsByEntity) {
      entities.add(spaceAndURI);
      let pathsByAction = this.nonRecursiveTriggers.get(spaceAndURI);
      if (!pathsByAction) {
        pathsByAction = new Map();
        this.nonRecursiveTriggers.set(spaceAndURI, pathsByAction);
      }
      pathsByAction.set(action, paths);
    }

    return { entities, triggerPathsByEntity };
  }

  removeActionFromEntities(
    action: Action,
    entities: Iterable<SpaceScopeAndURI>,
  ): void {
    for (const spaceAndURI of entities) {
      removeActionFromTriggerMap(this.triggers, spaceAndURI, action);
      removeActionFromTriggerMap(
        this.nonRecursiveTriggers,
        spaceAndURI,
        action,
      );
    }
  }

  removeSpace(space: MemorySpace): void {
    const spacePrefix = `${space}/`;
    removeTriggerMapSpace(this.triggers, spacePrefix);
    removeTriggerMapSpace(this.nonRecursiveTriggers, spacePrefix);
  }

  collectReadersForWrite(write: IMemorySpaceAddress): Set<Action> {
    const entity = entityKey(write);
    const readers = new Set<Action>();

    const recursiveReaders = this.triggers.get(entity);
    if (recursiveReaders) {
      for (const [action, paths] of recursiveReaders) {
        if (paths.some((path) => arraysOverlap(write.path, path))) {
          readers.add(action);
        }
      }
    }

    const nonRecursiveReaders = this.nonRecursiveTriggers.get(entity);
    if (nonRecursiveReaders) {
      for (const [action, reads] of nonRecursiveReaders) {
        if (
          reads.some((read) =>
            nonRecursiveReadMayOverlapWrite(read, write.path)
          )
        ) {
          readers.add(action);
        }
      }
    }

    return readers;
  }

  hasRegisteredTriggers(): boolean {
    return this.triggers.size > 0 || this.nonRecursiveTriggers.size > 0;
  }

  clear(): void {
    this.triggers.clear();
    this.nonRecursiveTriggers.clear();
  }

  collectTriggeredActionsForChange(
    space: MemorySpace,
    change: IMemoryChange,
  ): {
    entity: SpaceScopeAndURI;
    hasMatchingTriggerPaths: boolean;
    triggeredActions: Action[];
  } {
    const entity = entityKey({ ...change.address, space });
    const paths = this.triggers.get(entity);
    const nonRecursivePaths = this.nonRecursiveTriggers.get(entity);

    if (!paths && !nonRecursivePaths) {
      return {
        entity,
        hasMatchingTriggerPaths: false,
        triggeredActions: [],
      };
    }

    const triggeredActionSet = new Set<Action>();
    if (paths) {
      for (
        const action of determineTriggeredActions(
          paths,
          change.before,
          change.after,
          change.address.path,
        )
      ) {
        triggeredActionSet.add(action);
      }
    }
    if (nonRecursivePaths) {
      for (
        const action of determineTriggeredActions(
          nonRecursivePaths,
          change.before,
          change.after,
          change.address.path,
          { nonRecursive: true },
        )
      ) {
        triggeredActionSet.add(action);
      }
    }

    return {
      entity,
      hasMatchingTriggerPaths: true,
      triggeredActions: [...triggeredActionSet],
    };
  }
}

export function addTriggerPathsToIndex(
  state: TriggerIndexState,
  action: Action,
  reads: IMemorySpaceAddress[],
  shallowReads: IMemorySpaceAddress[],
): {
  entities: Set<SpaceScopeAndURI>;
  triggerPathsByEntity: Map<SpaceScopeAndURI, SortedAndCompactPaths>;
} {
  return state.addActionReads(action, reads, shallowReads);
}

// Last-registered reads per (subscription state, action), so a re-run whose
// read set is unchanged — the overwhelmingly common case for steady-state
// sinks and settle re-runs — skips the O(read-entities) clear + re-add of
// the trigger index. Keyed by the state's `cancels` map (stable identity per
// scheduler) so actions never cross-contaminate between runtimes.
const lastTriggerReadsByState = new WeakMap<
  object,
  WeakMap<Action, {
    reads: IMemorySpaceAddress[];
    shallowReads: IMemorySpaceAddress[];
    result: {
      entities: Set<SpaceScopeAndURI>;
      triggerPathsByEntity: Map<SpaceScopeAndURI, SortedAndCompactPaths>;
    };
  }>
>();

const addressesEqual = (
  a: readonly IMemorySpaceAddress[],
  b: readonly IMemorySpaceAddress[],
): boolean => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (
      x.space !== y.space || x.id !== y.id || x.type !== y.type ||
      x.scope !== y.scope || x.path.length !== y.path.length
    ) {
      return false;
    }
    for (let j = 0; j < x.path.length; j++) {
      if (x.path[j] !== y.path[j]) return false;
    }
  }
  return true;
};

export function replaceActionTriggerPaths(
  state: TriggerSubscriptionState,
  action: Action,
  reads: IMemorySpaceAddress[],
  shallowReads: IMemorySpaceAddress[],
): {
  entities: Set<SpaceScopeAndURI>;
  triggerPathsByEntity: Map<SpaceScopeAndURI, SortedAndCompactPaths>;
} {
  let byAction = lastTriggerReadsByState.get(state.cancels);
  // Only skip while the action is still registered: an unsubscribe runs the
  // cancel (removing the action from the entity index), so a later
  // re-subscribe must re-add even with identical reads.
  const prev = state.cancels.has(action) ? byAction?.get(action) : undefined;
  if (
    prev !== undefined &&
    addressesEqual(prev.reads, reads) &&
    addressesEqual(prev.shallowReads, shallowReads)
  ) {
    return prev.result;
  }
  clearActionTriggers(state, action);
  const result = addTriggerPathsToIndex(state, action, reads, shallowReads);
  if (byAction === undefined) {
    byAction = new WeakMap();
    lastTriggerReadsByState.set(state.cancels, byAction);
  }
  byAction.set(action, { reads, shallowReads, result });
  return result;
}

export function clearActionTriggers(
  state: TriggerSubscriptionState,
  action: Action,
): void {
  const cancel = state.cancels.get(action);
  if (!cancel) return;

  cancel();
  state.cancels.delete(action);
}

export function setCancelForTriggerEntities(
  state: TriggerSubscriptionState,
  action: Action,
  entities: Set<SpaceScopeAndURI>,
): void {
  const actionId = state.getActionId(action);
  state.cancels.set(action, () => {
    state.onTriggerUnsubscribe?.(actionId, entities.size);
    state.removeActionFromEntities(action, entities);
  });
}

export function removeActionFromTriggerIndex(
  state: TriggerIndexState,
  action: Action,
  entities: Iterable<SpaceScopeAndURI>,
): void {
  state.removeActionFromEntities(action, entities);
}

export function collectReadersForWrite(
  state: TriggerIndexState,
  write: IMemorySpaceAddress,
): Set<Action> {
  return state.collectReadersForWrite(write);
}
