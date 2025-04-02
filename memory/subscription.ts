import {
  Cause,
  Entity,
  MemorySpace,
  SchemaSelector,
  Selector,
  The,
  Transaction,
} from "./interface.ts";

export const match = (transaction: Transaction, watched: Set<string>) => {
  for (const [of, attributes] of Object.entries(transaction.args.changes)) {
    for (const [the, changes] of Object.entries(attributes)) {
      for (const change of Object.values(changes)) {
        // If `change == true` we simply confirm that state has not changed
        // so we don't need to notify those subscribers.
        if (change !== true) {
          const watches =
            watched.has(formatAddress(transaction.sub, { the, of })) ||
            watched.has(formatAddress(transaction.sub, { the })) ||
            watched.has(formatAddress(transaction.sub, { of })) ||
            watched.has(formatAddress(transaction.sub, {}));

          if (watches) {
            return true;
          }
        }
      }
    }
  }
  return false;
};

export const channels = function* (
  space: MemorySpace,
  selector: Selector | SchemaSelector,
) {
  const all = [["_", {}]] as const;
  const entities = Object.entries(selector);
  for (const [of, attributes] of entities.length > 0 ? entities : all) {
    const selector = Object.entries(attributes);
    for (const [the] of selector.length > 0 ? selector : all) {
      yield formatAddress(space, { the, of });
    }
  }
};

export const fromSelector = function* (selector: Selector | SchemaSelector) {
  const all = [[undefined, {}]] as const;
  const entities = Object.entries(selector);
  for (const [of, attributes] of entities.length > 0 ? entities : all) {
    const selector = Object.entries(attributes);
    for (const [the, members] of selector.length > 0 ? selector : all) { // type checking is confused here
      // type checking is confused here, so we double test
      if (members === undefined || members === null) {
        continue;
      }
      const causes = Object.keys(members).filter((c) => c !== "_");
      for (
        const cause of causes.length > 0 ? causes : [undefined]
      ) {
        const selector: { of?: Entity; the?: The; cause?: Cause } = {};
        if (of) {
          selector.of = of as Entity;
        }
        if (the) {
          selector.the = the as The;
        }
        if (cause) {
          selector.cause = cause as Cause;
        }
        yield selector;
      }
    }
  }
};

export const formatAddress = (
  space: MemorySpace,
  { of = "_", the = "_" }: { the?: string; of?: string },
) => `watch:///${space}/${of}/${the}`;
