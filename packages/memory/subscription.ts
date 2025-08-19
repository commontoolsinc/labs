import {
  Cause,
  Commit,
  Entity,
  MemorySpace,
  SchemaSelector,
  Selector,
  The,
} from "./interface.ts";
import { COMMIT_LOG_TYPE } from "./commit.ts";

export const match = (commit: Commit, watched: Set<string>) => {
  for (const at of Object.keys(commit) as MemorySpace[]) {
    const commitObj = commit[at][COMMIT_LOG_TYPE] ?? {};
    for (const { is: { transaction } } of Object.values(commitObj)) {
      // If commit on this space are watched we have a match
      if (matchAddress(watched, { the: COMMIT_LOG_TYPE, of: at, at })) {
        return true;
      }

      // Otherwise we consider individual in the commit transaction to figure
      // out if we have a match.
      for (const [of, attributes] of Object.entries(transaction.args.changes)) {
        for (const [the, changes] of Object.entries(attributes)) {
          for (const change of Object.values(changes)) {
            // If `change == true` we simply confirm that state has not changed
            // so we don't need to notify those subscribers.
            if (
              change !== true &&
              matchAddress(watched, { at: transaction.sub, the, of })
            ) {
              return true;
            }
          }
        }
      }
    }
  }

  return false;
};

const matchAddress = (
  watched: Set<string>,
  { at, the, of }: { the: string; of: string; at: MemorySpace },
) =>
  watched.has(formatAddress({ at, the, of })) ||
  watched.has(formatAddress({ at, the })) ||
  watched.has(formatAddress({ at, of })) ||
  watched.has(formatAddress({ at }));

export const ANY = "_";

export const channels = function* (
  space: MemorySpace,
  selector: Selector | SchemaSelector,
) {
  const all = [[ANY, {}]] as const;
  const entities = Object.entries(selector);
  for (const [of, attributes] of entities.length > 0 ? entities : all) {
    const selector = Object.entries(attributes);
    for (const [the] of selector.length > 0 ? selector : all) {
      yield formatAddress({ at: space, the, of });
    }
  }
};

export const fromSelector = function* (selector: Selector | SchemaSelector) {
  const all = [[ANY, {}]] as const;
  const entities = Object.entries(selector);
  for (const [of, attributes] of entities.length > 0 ? entities : all) {
    const selector = Object.entries(attributes);
    for (const [the, members] of selector.length > 0 ? selector : all) {
      // type checking is confused here, so we double test
      if (members == null) {
        continue;
      }

      const selector = Object.keys(members);
      for (
        const cause of selector.length > 0 ? selector : [ANY]
      ) {
        const selector: { of?: Entity; the?: The; cause?: Cause } = {};
        if (of !== ANY) {
          selector.of = of as Entity;
        }

        if (the !== ANY) {
          selector.the = the as The;
        }

        if (cause !== ANY) {
          selector.cause = cause as Cause;
        }
        yield selector;
      }
    }
  }
};

export const formatAddress = (
  { at = "_", of = "_", the = "_" }: {
    at?: string;
    the?: string;
    of?: string;
  },
) => `watch:///${at}/${of}/${the}`;
