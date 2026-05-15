import {
  addressesToPathByEntity,
  arraysOverlap,
  nonRecursiveReadMayOverlapWrite,
  type SortedAndCompactPaths,
} from "../reactive-dependencies.ts";
import type { Cancel } from "../cancel.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
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
}

export interface TriggerSubscriptionState extends TriggerIndexState {
  readonly cancels: WeakMap<Action, Cancel>;
  readonly getActionId: (action: Action) => string;
  readonly onTriggerUnsubscribe?: (
    actionId: string,
    entityCount: number,
  ) => void;
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
  const pathsByEntity = addressesToPathByEntity(reads);
  const nonRecursivePathsByEntity = addressesToPathByEntity(shallowReads);
  const entities = new Set<SpaceScopeAndURI>();
  const triggerPathsByEntity = new Map<
    SpaceScopeAndURI,
    SortedAndCompactPaths
  >();

  for (const [spaceAndURI, paths] of pathsByEntity) {
    entities.add(spaceAndURI);
    let pathsByAction = state.triggers.get(spaceAndURI);
    if (!pathsByAction) {
      pathsByAction = new Map();
      state.triggers.set(spaceAndURI, pathsByAction);
    }
    pathsByAction.set(action, paths);
    triggerPathsByEntity.set(spaceAndURI, paths);
  }

  for (const [spaceAndURI, paths] of nonRecursivePathsByEntity) {
    entities.add(spaceAndURI);
    let pathsByAction = state.nonRecursiveTriggers.get(spaceAndURI);
    if (!pathsByAction) {
      pathsByAction = new Map();
      state.nonRecursiveTriggers.set(spaceAndURI, pathsByAction);
    }
    pathsByAction.set(action, paths);
  }

  return { entities, triggerPathsByEntity };
}

export function replaceActionTriggerPaths(
  state: TriggerSubscriptionState,
  action: Action,
  reads: IMemorySpaceAddress[],
  shallowReads: IMemorySpaceAddress[],
): {
  entities: Set<SpaceScopeAndURI>;
  triggerPathsByEntity: Map<SpaceScopeAndURI, SortedAndCompactPaths>;
} {
  clearActionTriggers(state, action);
  return addTriggerPathsToIndex(state, action, reads, shallowReads);
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
    removeActionFromTriggerIndex(state, action, entities);
  });
}

export function removeActionFromTriggerIndex(
  state: TriggerIndexState,
  action: Action,
  entities: Iterable<SpaceScopeAndURI>,
): void {
  for (const spaceAndURI of entities) {
    state.triggers.get(spaceAndURI)?.delete(action);
    state.nonRecursiveTriggers.get(spaceAndURI)?.delete(action);
  }
}

export function collectReadersForWrite(
  state: TriggerIndexState,
  write: IMemorySpaceAddress,
): Set<Action> {
  const entity = entityKey(write);
  const readers = new Set<Action>();

  const recursiveReaders = state.triggers.get(entity);
  if (recursiveReaders) {
    for (const [action, paths] of recursiveReaders) {
      if (paths.some((path) => arraysOverlap(write.path, path))) {
        readers.add(action);
      }
    }
  }

  const nonRecursiveReaders = state.nonRecursiveTriggers.get(entity);
  if (nonRecursiveReaders) {
    for (const [action, reads] of nonRecursiveReaders) {
      if (
        reads.some((read) => nonRecursiveReadMayOverlapWrite(read, write.path))
      ) {
        readers.add(action);
      }
    }
  }

  return readers;
}
