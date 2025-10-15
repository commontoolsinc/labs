import {
  CauseString,
  MemorySpace,
  MIME,
  SchemaSelector,
  Selector,
  Transaction,
  URI,
} from "./interface.ts";
import { iterate } from "./selection.ts";
import { COMMIT_LOG_TYPE } from "./commit.ts";

export const match = (
  transaction: Transaction<MemorySpace>,
  watched: Set<string>,
) => {
  const space = transaction.sub;
  // If commit on this space are watched we have a match
  if (
    matchAddress(watched, { at: space, of: space, the: COMMIT_LOG_TYPE })
  ) {
    return true;
  }

  // Otherwise we consider individual in the commit transaction to figure
  // out if we have a match.
  for (const fact of iterate(transaction.args.changes)) {
    // If `fact.value == true` we simply confirm that state has not changed
    // so we don't need to notify those subscribers.
    if (
      fact.value !== true &&
      matchAddress(watched, { at: space, of: fact.of, the: fact.the })
    ) {
      return true;
    }
  }

  return false;
};

const matchAddress = (
  watched: Set<string>,
  { at, of, the }: { at: MemorySpace; of: string; the: string },
) =>
  watched.has(formatAddress({ at, of, the })) ||
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
        const selector: { of?: URI; the?: MIME; cause?: CauseString } = {};
        if (of !== ANY) {
          selector.of = of as URI;
        }

        if (the !== ANY) {
          selector.the = the as MIME;
        }

        if (cause !== ANY) {
          selector.cause = cause as CauseString;
        }
        yield selector;
      }
    }
  }
};

export function isTransactionReadOnly(
  transaction: Transaction<MemorySpace>,
): boolean {
  for (const fact of iterate(transaction.args.changes)) {
    if (fact.value !== true) {
      return false;
    }
  }
  return true;
}

export const formatAddress = (
  { at = "_", of = "_", the = "_" }: {
    at?: string;
    the?: string;
    of?: string;
  },
) => `watch:///${at}/${of}/${the}`;
