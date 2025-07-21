import { isRecord } from "@commontools/utils/types";
import { arrayEqual, deepEqual } from "./path-utils.ts";
import type { JSONValue } from "./builder/types.ts";
import type { Action } from "./scheduler.ts";

export type TriggerPaths = string[][];
export type SortedAndCompactPaths = string[][];

type Keyable = Record<string, JSONValue | undefined>;

/**
 * Sorts and compactifies the paths.
 *
 * Compactifies by removing any entries that have another as a prefix.
 *
 * @param paths - The paths to sort and compactify.
 * @returns The sorted and compactified paths.
 */
export function sortAndCompactPaths(
  paths: TriggerPaths,
): SortedAndCompactPaths {
  if (paths.length === 0) return [];

  const sorted = paths.toSorted((a, b) => comparePaths(a, b));
  const result = [sorted[0]];
  let previous = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (!startsWith(sorted[i], previous)) {
      result.push(sorted[i]);
      previous = sorted[i];
    }
  }
  return result;
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
  dependencies: Map<Action, SortedAndCompactPaths>,
  before: JSONValue | undefined,
  after: JSONValue | undefined,
  startPath: string[] = [],
): Action[] {
  const triggeredActions: Action[] = [];

  let subscribers: { action: Action; paths: SortedAndCompactPaths }[] = Array
    .from(
      dependencies.entries(),
    ).map((
      [action, paths],
    ) => ({
      action,
      paths: paths.toReversed(),
    }));
  subscribers.sort((a, b) => comparePaths(a.paths[0], b.paths[0]));

  if (startPath.length > 0) {
    // If we're starting from a specific path, filter the subscribers to only
    // include those that start with that path.
    subscribers = subscribers.map(({ action, paths }) => ({
      action,
      paths: paths.filter((path) => startsWith(path, startPath)),
    })).filter(({ paths }) => paths.length > 0);

    // And prepend path to data, so we don't have to special case this.
    for (const key of startPath.toReversed()) {
      before = { [key]: before } as JSONValue;
      after = { [key]: after } as JSONValue;
    }
  }

  // Sort subscribers by last/longest path first.
  subscribers.sort((a, b) => comparePaths(b.paths[0], a.paths[0]));

  // Trabserval state:
  let currentPath: string[] = [];

  // *Values: An array of data values along currentPath
  const beforeValues: (JSONValue | undefined)[] = [before];
  const afterValues: (JSONValue | undefined)[] = [after];

  // *LastObject: Last key-able object along currentPath
  let beforeLastObject = isRecord(before) ? 0 : -1;
  let afterLastObject = isRecord(after) ? 0 : -1;

  while (subscribers.length > 0) {
    // Pull the next path from the queue
    const current = [subscribers.shift()!];
    const targetPath = current[0].paths.shift()!;

    // Also pull in all subscribers that have the same path
    while (
      subscribers.length > 0 && arrayEqual(targetPath, subscribers[0].paths[0])
    ) {
      subscribers[0].paths.shift();
      current.push(subscribers.shift()!);
    }

    // Now traverse the data to target path
    const overlap = commonPrefixLength(targetPath, currentPath);
    for (let i = overlap; i < targetPath.length; i++) {
      if (i <= beforeLastObject) {
        beforeValues[i + 1] = (beforeValues[i] as Keyable)[targetPath[i]!];
        if (isRecord(beforeValues[i + 1])) beforeLastObject = i + 1;
      }
      if (i <= afterLastObject) {
        afterValues[i + 1] = (afterValues[i] as Keyable)[targetPath[i]!];
        if (isRecord(afterValues[i + 1])) afterLastObject = i + 1;
      }
    }
    currentPath = targetPath;

    // Now get the value at the path, `undefined` if that path doesn't exist
    const beforeValue = beforeLastObject + 1 >= targetPath.length
      ? beforeValues[targetPath.length]
      : undefined;
    const afterValue = afterLastObject + 1 >= targetPath.length
      ? afterValues[targetPath.length]
      : undefined;

    if (!deepEqual(beforeValue, afterValue)) {
      // If the value changed, trigger the actions
      triggeredActions.push(...current.map(({ action }) => action));
    } else {
      // Otherwise, queue up the next path, keeping subscribers sorted by path
      for (const subscriber of current) {
        if (subscriber.paths.length > 0) {
          const nextPath = subscriber.paths[0];
          for (let i = 0; i <= subscribers.length; i++) {
            if (
              i === subscribers.length ||
              comparePaths(nextPath, subscribers[i].paths[0]) >= 0
            ) {
              subscribers.splice(i, 0, subscriber);
              break;
            }
          }
        }
      }
    }
  }

  return triggeredActions;
}

function startsWith(path: string[], prefix: string[]): boolean {
  return prefix.every((value, index) => value === path[index]);
}

function commonPrefixLength(a: string[], b: string[]): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) {
      return i;
    }
  }
  return Math.min(a.length, b.length);
}

function comparePaths(a: string[], b: string[]): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return a.length - b.length;
}
