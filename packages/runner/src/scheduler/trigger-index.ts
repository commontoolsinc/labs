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
import type { Action, ReactivityLog, SpaceScopeAndURI } from "./types.ts";

export interface TriggerIndexState {
  readonly triggers: Map<
    SpaceScopeAndURI,
    Map<Action, SortedAndCompactPaths>
  >;
  readonly nonRecursiveTriggers: Map<
    SpaceScopeAndURI,
    Map<Action, SortedAndCompactPaths>
  >;
  readonly actionTriggerEntities: WeakMap<Action, Set<SpaceScopeAndURI>>;
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

  get actionTriggerEntities(): TriggerIndexState["actionTriggerEntities"] {
    return this.state.triggerIndex.actionTriggerEntities;
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
  readonly actionTriggerEntities = new WeakMap<
    Action,
    Set<SpaceScopeAndURI>
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

    this.actionTriggerEntities.set(action, entities);

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

export function applyActionReadDelta(
  state: TriggerIndexState,
  action: Action,
  prevLog: Pick<ReactivityLog, "reads" | "shallowReads">,
  nextLog: Pick<ReactivityLog, "reads" | "shallowReads">,
): {
  entities: Set<SpaceScopeAndURI>;
  triggerPathsByEntity: Map<SpaceScopeAndURI, SortedAndCompactPaths>;
} {
  const prevPathsByEntity = addressesToPathByEntity(prevLog.reads);
  const nextPathsByEntity = addressesToPathByEntity(nextLog.reads);
  const prevNonRecursivePathsByEntity = addressesToPathByEntity(
    prevLog.shallowReads,
  );
  const nextNonRecursivePathsByEntity = addressesToPathByEntity(
    nextLog.shallowReads,
  );

  applyActionReadDeltaToMap(
    state.triggers,
    action,
    prevPathsByEntity,
    nextPathsByEntity,
  );
  applyActionReadDeltaToMap(
    state.nonRecursiveTriggers,
    action,
    prevNonRecursivePathsByEntity,
    nextNonRecursivePathsByEntity,
  );

  const entities = new Set<SpaceScopeAndURI>([
    ...nextPathsByEntity.keys(),
    ...nextNonRecursivePathsByEntity.keys(),
  ]);
  state.actionTriggerEntities.set(action, entities);

  return { entities, triggerPathsByEntity: nextPathsByEntity };
}

export function ensureCancelForActionTriggers(
  state: TriggerSubscriptionState,
  action: Action,
): void {
  if (state.cancels.has(action)) return;

  const actionId = state.getActionId(action);
  state.cancels.set(action, () => {
    const entities = state.actionTriggerEntities.get(action) ?? new Set();
    state.onTriggerUnsubscribe?.(actionId, entities.size);
    state.removeActionFromEntities(action, entities);
    state.actionTriggerEntities.delete(action);
  });
}

function applyActionReadDeltaToMap(
  triggerMap: Map<SpaceScopeAndURI, Map<Action, SortedAndCompactPaths>>,
  action: Action,
  prevPathsByEntity: Map<SpaceScopeAndURI, SortedAndCompactPaths>,
  nextPathsByEntity: Map<SpaceScopeAndURI, SortedAndCompactPaths>,
): void {
  const entities = new Set<SpaceScopeAndURI>([
    ...prevPathsByEntity.keys(),
    ...nextPathsByEntity.keys(),
  ]);

  for (const entity of entities) {
    const prevPaths = prevPathsByEntity.get(entity);
    const nextPaths = nextPathsByEntity.get(entity);
    if (pathsEqual(prevPaths, nextPaths)) continue;

    if (nextPaths === undefined) {
      removeActionFromTriggerMap(triggerMap, entity, action);
      continue;
    }

    let pathsByAction = triggerMap.get(entity);
    if (!pathsByAction) {
      pathsByAction = new Map();
      triggerMap.set(entity, pathsByAction);
    }
    pathsByAction.set(action, nextPaths);
  }
}

function pathsEqual(
  a: SortedAndCompactPaths | undefined,
  b: SortedAndCompactPaths | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) return false;
    for (let j = 0; j < a[i].length; j++) {
      if (a[i][j] !== b[i][j]) return false;
    }
  }
  return true;
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
