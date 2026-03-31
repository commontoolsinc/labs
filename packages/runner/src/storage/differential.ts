import { unclaimed } from "@commonfabric/memory/fact";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isRecord } from "@commonfabric/utils/types";
import type {
  IMemoryAddress,
  IMemoryChange,
  IMergedChanges,
  State,
} from "./interface.ts";
import * as Address from "./transaction/address.ts";

export const create = () => new Changes();

interface Memory {
  get(entry: IMemoryAddress): State | undefined;
}

const toKey = (state: State) => `/${state.the}/${state.of}`;
const toAddress = (
  state: State,
  path: readonly string[] = [],
): IMemoryAddress => ({
  id: state.of,
  type: state.the,
  path: [...path],
});

const comparePaths = (
  left: readonly string[],
  right: readonly string[],
): number => {
  for (let index = 0; index < left.length && index < right.length; index += 1) {
    if (left[index] === right[index]) {
      continue;
    }
    return left[index]! < right[index]! ? -1 : 1;
  }
  return left.length - right.length;
};

const pushChangedPath = (
  paths: string[][],
  currentPath: string[],
  depth: number,
): void => {
  paths.push(currentPath.slice(0, depth));
};

const collectChangedPaths = (
  before: unknown,
  after: unknown,
  currentPath: string[],
  depth: number,
  paths: string[][],
): void => {
  if (Object.is(before, after)) {
    return;
  }

  if (before === undefined || after === undefined) {
    pushChangedPath(paths, currentPath, depth);
    return;
  }

  if (isRecord(before) && isRecord(after)) {
    if (deepEqual(before, after)) {
      return;
    }

    if (Array.isArray(before) && Array.isArray(after)) {
      if (before.length !== after.length) {
        pushChangedPath(paths, currentPath, depth);
      }

      const maxLength = Math.max(before.length, after.length);
      for (let index = 0; index < maxLength; index += 1) {
        const beforeHas = index in before;
        const afterHas = index in after;
        if (!beforeHas && !afterHas) {
          continue;
        }

        if (beforeHas && afterHas) {
          currentPath[depth] = String(index);
          collectChangedPaths(
            before[index],
            after[index],
            currentPath,
            depth + 1,
            paths,
          );
          continue;
        }

        if (before.length === after.length) {
          currentPath[depth] = String(index);
          pushChangedPath(paths, currentPath, depth + 1);
        }
      }
      currentPath.length = depth;
      return;
    }

    if (Array.isArray(before) !== Array.isArray(after)) {
      pushChangedPath(paths, currentPath, depth);
      return;
    }

    const beforeKeys = Object.keys(before);
    const afterKeys = Object.keys(after);

    if (beforeKeys.length === afterKeys.length) {
      let sameKeys = true;
      for (const key of beforeKeys) {
        if (!Object.hasOwn(after, key)) {
          sameKeys = false;
          break;
        }
      }

      if (sameKeys) {
        for (const key of beforeKeys) {
          currentPath[depth] = key;
          collectChangedPaths(
            before[key],
            after[key],
            currentPath,
            depth + 1,
            paths,
          );
        }
        currentPath.length = depth;
        return;
      }
    }

    const seen = new Set<string>();
    for (const key of beforeKeys) {
      seen.add(key);
      const afterHas = Object.hasOwn(after, key);
      currentPath[depth] = key;
      if (afterHas) {
        collectChangedPaths(
          before[key],
          after[key],
          currentPath,
          depth + 1,
          paths,
        );
        continue;
      }

      pushChangedPath(paths, currentPath, depth + 1);
    }

    for (const key of afterKeys) {
      if (seen.has(key)) {
        continue;
      }
      currentPath[depth] = key;
      pushChangedPath(paths, currentPath, depth + 1);
    }
    currentPath.length = depth;
    return;
  }

  if (!deepEqual(before, after)) {
    pushChangedPath(paths, currentPath, depth);
  }
};

const addStateChange = (
  changes: Changes,
  state: State,
  before: State["is"] | undefined,
  after: State["is"] | undefined,
): void => {
  if (deepEqual(before, after)) {
    return;
  }

  if (before === undefined || after === undefined) {
    changes.add({
      address: toAddress(state),
      before,
      after,
    });
    return;
  }

  const paths: string[][] = [];
  collectChangedPaths(before, after, [], 0, paths);
  if (paths.length === 0) {
    return;
  }

  paths.sort(comparePaths);
  for (const path of paths) {
    changes.add({
      address: toAddress(state, path),
      before,
      after,
    });
  }
};

/**
 * Checks out facts from the given memory so that we can compute changes
 * later on.
 */
export const checkout = (memory: Memory, facts: Iterable<State>) => {
  const checkout = new Checkout();
  for (const member of facts) {
    const address = toAddress(member);
    const existing = memory.get(address);
    if (existing) {
      checkout.add(existing);
    } else {
      checkout.add(unclaimed(member));
    }
  }
  return checkout;
};

export const load = (facts: Iterable<State>) => create().set(facts);

class Checkout {
  #model: Map<string, State> = new Map();
  add(state: State) {
    this.#model.set(toKey(state), state);
  }

  compare(memory: Memory) {
    const changes = new Changes();
    for (const fact of this.#model.values()) {
      const before = fact?.is;
      const after = memory.get(toAddress(fact))?.is;
      addStateChange(changes, fact, before, after);
    }
    return changes;
  }
}

class Changes implements IMergedChanges {
  #model: Map<string, IMemoryChange> = new Map();
  *[Symbol.iterator]() {
    yield* this.#model.values();
  }

  /**
   * Adds a new fact to the changeset.
   */
  set(facts: Iterable<State>) {
    for (const fact of facts) {
      addStateChange(this, fact, undefined, fact.is);
    }
    return this;
  }

  /**
   * Captures changes between what is in the given memory and
   * provided facts.
   */
  update(memory: Memory, facts: Iterable<State>) {
    for (const fact of facts) {
      const before = memory.get(toAddress(fact))?.is;
      const after = fact.is;
      addStateChange(this, fact, before, after);
    }
    return this;
  }

  add(change: IMemoryChange) {
    const key = Address.toString(change.address);

    if (!this.#model.has(key)) {
      this.#model.set(key, change);
    }
    return this;
  }

  toJSON() {
    return [...this.#model.values()];
  }

  close(): IMergedChanges {
    return this;
  }
}
