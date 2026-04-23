import { isRecord } from "@commonfabric/utils/types";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { isPrimitiveCellLink } from "./link-utils.ts";
import { arrayEqual } from "./path-utils.ts";
import type { Action, SpaceAndURI } from "./scheduler.ts";
import type {
  IMemorySpaceAddress,
  MemoryAddressPathComponent,
  ShallowReadDependency,
} from "./storage/interface.ts";

export type SortedAndCompactPaths = Array<
  readonly MemoryAddressPathComponent[]
>;

export interface NonRecursiveDependencyPath {
  path: readonly MemoryAddressPathComponent[];
  interestedChildren?: readonly MemoryAddressPathComponent[];
}

export type SortedAndCompactNonRecursiveDependencies = Array<
  NonRecursiveDependencyPath
>;

export type TriggerDependencyPath =
  | readonly MemoryAddressPathComponent[]
  | NonRecursiveDependencyPath;

export interface DetermineTriggeredActionsOptions {
  /**
   * Non-recursive reads are invalidated by parent/same-path writes only.
   * Child-path writes invalidate only if they add a new direct child key.
   */
  nonRecursive?: boolean;
}

type Keyable = Record<MemoryAddressPathComponent, FabricValue>;

/**
 * Sorts and compactifies the paths.
 *
 * Compactifies by removing any duplicate entries, and potentially entries
 * that have another as a prefix.
 *
 * @param paths - The paths to sort and compactify.
 * @param compactifyChildren - whether to remove entries that have the same prefix
 * @returns The sorted and compactified paths.
 */
export function sortAndCompactPaths<T extends IMemorySpaceAddress>(
  unsorted: readonly T[],
  compactifyChildren = true,
): T[] {
  if (unsorted.length === 0) return [];

  const sorted = unsorted.toSorted((a, b) =>
    a.space === b.space
      ? a.id === b.id
        ? a.type === b.type
          ? comparePaths(a.path, b.path)
          : a.type < b.type
          ? -1
          : 1
        : a.id < b.id
        ? -1
        : 1
      : a.space < b.space
      ? -1
      : 1
  );
  const result: T[] = [sorted[0]];
  let previous = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (
      sorted[i].space === previous.space &&
      sorted[i].id === previous.id &&
      sorted[i].type === previous.type &&
      // Is the previous path a prefix of the current path?
      previous.path.every((value, index) => value === sorted[i].path[index]) &&
      // If we compactifyChildren, or the paths are identical, skip this
      (compactifyChildren || previous.path.length === sorted[i].path.length)
    ) {
      result[result.length - 1] = mergeCompactablePaths(previous, sorted[i]);
      previous = result[result.length - 1];
      continue;
    }
    result.push(sorted[i]);
    previous = sorted[i];
  }
  return result;
}

/**
 * Converts a list of paths to a map of space/id to paths.
 *
 * @param addresses - The paths to convert.
 * @returns A map of space/id to paths.
 */
export function addressesToPathByEntity(
  addresses: IMemorySpaceAddress[],
): Map<SpaceAndURI, SortedAndCompactPaths> {
  const map = new Map<SpaceAndURI, SortedAndCompactPaths>();
  for (const address of addresses) {
    if (address.type !== "application/json") continue;
    const key: SpaceAndURI = `${address.space}/${address.id}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(address.path);
  }
  return map;
}

export function shallowReadsToDependencyByEntity(
  addresses: ShallowReadDependency[],
): Map<SpaceAndURI, SortedAndCompactNonRecursiveDependencies> {
  const map = new Map<SpaceAndURI, SortedAndCompactNonRecursiveDependencies>();
  for (const address of addresses) {
    if (address.type !== "application/json") continue;
    const key: SpaceAndURI = `${address.space}/${address.id}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push({
      path: address.path,
      interestedChildren: address.interestedChildren,
    });
  }
  return map;
}

/**
 * Determines the actions that are triggered based on the changes to the data.
 *
 * Functionally equivalent looking for any `!deepEqual` for `getAtPath` for all
 * the paths per action.
 *
 * @param dependencies - A map of actions to their sorted paths.
 * @param before - The data before the changes.
 * @param after - The data after the changes.
 * @param startPath - The path the passed in data starts at.
 * @returns The actions that need to be triggered.
 */
export function determineTriggeredActions(
  dependencies: Map<
    Action,
    SortedAndCompactPaths | SortedAndCompactNonRecursiveDependencies
  >,
  before: FabricValue,
  after: FabricValue,
  startPath: readonly MemoryAddressPathComponent[] = [],
  options?: DetermineTriggeredActionsOptions,
): Action[] {
  const triggeredActions: Action[] = [];

  let subscribers: {
    action: Action;
    paths: TriggerDependencyPath[];
  }[] = Array
    .from(
      dependencies.entries(),
    ).map((
      [action, paths],
    ) => ({
      action,
      paths: [...paths].toReversed(),
    }));

  if (startPath.length > 0) {
    // If we're starting from a specific path, filter the subscribers to only
    // include those that can be affected by that path.
    subscribers = subscribers.map(({ action, paths }) => ({
      action,
      paths: paths.filter((path) =>
        arraysOverlap(dependencyPath(path), startPath)
      ),
    })).filter(({ paths }) => paths.length > 0);
  }

  // Sort subscribers by last/longest path first.
  subscribers.sort((a, b) =>
    comparePaths(dependencyPath(b.paths[0]), dependencyPath(a.paths[0]))
  );

  // Traversal state:
  let currentPath: readonly MemoryAddressPathComponent[] = [];

  // *Values: An array of data values along currentPath
  const beforeValues: FabricValue[] = [before];
  const afterValues: FabricValue[] = [after];

  // *LastObject: Last key-able object along currentPath
  let beforeLastObject = isRecord(before) ? 0 : -1;
  let afterLastObject = isRecord(after) ? 0 : -1;

  while (subscribers.length > 0) {
    // Pull the next path from the queue
    const current = [{
      action: subscribers[0].action,
      path: subscribers[0].paths.shift()!,
      paths: subscribers[0].paths,
    }];
    subscribers.shift();
    const targetPath = dependencyPath(current[0].path);

    // Also pull in all subscribers that have the same path
    while (
      subscribers.length > 0 &&
      arrayEqual(targetPath, dependencyPath(subscribers[0].paths[0]))
    ) {
      current.push({
        action: subscribers[0].action,
        path: subscribers[0].paths.shift()!,
        paths: subscribers[0].paths,
      });
      subscribers.shift();
    }

    // Now traverse the data to target path
    const overlap = commonPrefixLength(targetPath, currentPath);
    for (let i = overlap; i < targetPath.length; i++) {
      if (i <= beforeLastObject) {
        beforeValues[i + 1] = (beforeValues[i] as Keyable)[targetPath[i]!];
        if (isRecord(beforeValues[i + 1])) beforeLastObject = i + 1;
        else beforeLastObject = i;
      }
      if (i <= afterLastObject) {
        afterValues[i + 1] = (afterValues[i] as Keyable)[targetPath[i]!];
        if (isRecord(afterValues[i + 1])) afterLastObject = i + 1;
        else afterLastObject = i;
      }
    }
    currentPath = targetPath;

    // Check if we could traverse far enough to reach the target path
    const beforeCanReach = beforeLastObject + 1 >= targetPath.length;
    const afterCanReach = afterLastObject + 1 >= targetPath.length;

    // Determine if there was a change. For recursive reads, trigger if:
    // 1. Both paths are reachable and the values differ
    // 2. Reachability changed (one can reach, the other can't)
    // 3. Neither can reach, but the depth of reachability changed
    //    (e.g., before we couldn't get past "a", now we can get to "a.b")
    let hasChanged: boolean;
    if (beforeCanReach && afterCanReach) {
      // Both reachable - compare actual values
      if (!options?.nonRecursive) {
        hasChanged = !deepEqual(
          beforeValues[targetPath.length],
          afterValues[targetPath.length],
        );
      } else {
        hasChanged = current.some(({ path }) =>
          !shallowEqual(
            beforeValues[targetPath.length],
            afterValues[targetPath.length],
            interestedChildren(path),
          )
        );
      }
    } else if (beforeCanReach !== afterCanReach) {
      // Reachability changed - definitely a structural change
      hasChanged = true;
    } else {
      // Neither reachable - check if we can traverse to different depths
      // This detects when intermediate path segments appear/disappear
      hasChanged = beforeLastObject !== afterLastObject;
    }

    if (hasChanged) {
      for (const subscriber of current) {
        const interested = options?.nonRecursive
          ? interestedChildren(subscriber.path)
          : undefined;
        const subscriberChanged = beforeCanReach && afterCanReach
          ? options?.nonRecursive
            ? !shallowEqual(
              beforeValues[targetPath.length],
              afterValues[targetPath.length],
              interested,
            )
            : !deepEqual(
              beforeValues[targetPath.length],
              afterValues[targetPath.length],
            )
          : beforeCanReach !== afterCanReach ||
            beforeLastObject !== afterLastObject;
        if (subscriberChanged) {
          triggeredActions.push(subscriber.action);
        } else if (subscriber.paths.length > 0) {
          requeueSubscriber(subscribers, subscriber);
        }
      }
    } else {
      // Otherwise, queue up the next path, keeping subscribers sorted by path
      for (const subscriber of current) {
        if (subscriber.paths.length > 0) {
          requeueSubscriber(subscribers, subscriber);
        }
      }
    }
  }

  return triggeredActions;
}

export function arraysOverlap(
  a: readonly MemoryAddressPathComponent[],
  b: readonly MemoryAddressPathComponent[],
): boolean {
  return (a.length > b.length)
    ? b.every((value, index) => value === a[index])
    : a.every((value, index) => value === b[index]);
}

export function nonRecursiveReadMayOverlapWrite(
  read: NonRecursiveDependencyPath,
  writePath: readonly MemoryAddressPathComponent[],
): boolean {
  if (
    writePath.length > read.path.length + 1 ||
    !arraysOverlap(writePath, read.path)
  ) {
    return false;
  }

  if (writePath.length <= read.path.length) {
    return true;
  }

  const interested = read.interestedChildren;
  if (!interested || interested.length === 0) {
    return true;
  }

  const child = writePath[read.path.length];
  return interested.includes(child ?? "");
}

function commonPrefixLength(
  a: readonly MemoryAddressPathComponent[],
  b: readonly MemoryAddressPathComponent[],
): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) {
      return i;
    }
  }
  return Math.min(a.length, b.length);
}

/**
 * Returns true if the SHALLOW structure of `before` and `after` are the same.
 *
 * For non-recursive reads, only structural changes at the target level
 * (key additions/removals, type changes, link identity changes) should
 * trigger re-evaluation. Deep value changes inside existing keys should not.
 *
 * - Links: compared by identity (deepEqual), since a link IS the pointer.
 * - Objects: changed iff the key set changed (not the values).
 * - Arrays: changed iff the key set changed (not the values).
 * - Primitives: changed iff the value changed.
 */
function shallowEqual(
  before: FabricValue,
  after: FabricValue,
  interestedChildren?: readonly MemoryAddressPathComponent[],
): boolean {
  // Links compare by full identity — a different link target matters.
  if (isPrimitiveCellLink(before) || isPrimitiveCellLink(after)) {
    return deepEqual(before, after);
  }

  if (isRecord(before) && isRecord(after)) {
    if (interestedChildren && interestedChildren.length > 0) {
      return interestedChildren.every((key) => {
        const beforeHas = Object.hasOwn(before, key);
        const afterHas = Object.hasOwn(after, key);
        return beforeHas === afterHas &&
          (!beforeHas || deepEqual(before[key], after[key]));
      });
    }
    const beforeKeys = Object.keys(before);
    const afterKeys = Object.keys(after);
    if (beforeKeys.length !== afterKeys.length) return false;
    // if one is an array, both must be
    if (Array.isArray(before) != Array.isArray(after)) return false;
    // if our array length changed, we've changed
    if (Array.isArray(before) && before.length !== after.length) return false;
    return beforeKeys.every((k) => Object.hasOwn(after, k));
  }

  // Primitives (null, number, string, boolean, undefined)
  return deepEqual(before, after);
}

function comparePaths(
  a: readonly MemoryAddressPathComponent[],
  b: readonly MemoryAddressPathComponent[],
): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return a.length - b.length;
}

function mergeCompactablePaths<T extends IMemorySpaceAddress>(
  left: T,
  right: T,
): T {
  const leftChildren =
    (left as Partial<ShallowReadDependency>).interestedChildren;
  const rightChildren = (right as Partial<ShallowReadDependency>)
    .interestedChildren;

  if (!leftChildren && !rightChildren) {
    return left;
  }

  const interestedChildren = mergeInterestedChildren(
    leftChildren,
    rightChildren,
  );
  if (!interestedChildren) {
    return left;
  }

  return {
    ...left,
    interestedChildren,
  } as T;
}

function dependencyPath(
  dependency: TriggerDependencyPath,
): readonly MemoryAddressPathComponent[] {
  return isNonRecursiveDependencyPath(dependency)
    ? dependency.path
    : dependency;
}

function interestedChildren(
  dependency: TriggerDependencyPath,
): readonly MemoryAddressPathComponent[] | undefined {
  return isNonRecursiveDependencyPath(dependency)
    ? dependency.interestedChildren
    : undefined;
}

function requeueSubscriber(
  subscribers: Array<{
    action: Action;
    paths: TriggerDependencyPath[];
  }>,
  subscriber: {
    action: Action;
    paths: TriggerDependencyPath[];
  },
): void {
  const nextPath = dependencyPath(subscriber.paths[0]);
  for (let i = 0; i <= subscribers.length; i++) {
    if (
      i === subscribers.length ||
      comparePaths(nextPath, dependencyPath(subscribers[i].paths[0])) >= 0
    ) {
      subscribers.splice(i, 0, subscriber);
      return;
    }
  }
}

function isNonRecursiveDependencyPath(
  dependency: TriggerDependencyPath,
): dependency is NonRecursiveDependencyPath {
  return !Array.isArray(dependency);
}

function mergeInterestedChildren(
  left?: readonly MemoryAddressPathComponent[],
  right?: readonly MemoryAddressPathComponent[],
): readonly MemoryAddressPathComponent[] | undefined {
  if (!left?.length) return right;
  if (!right?.length) return left;

  const merged = new Set(left);
  for (const child of right) {
    merged.add(child);
  }
  return [...merged];
}
