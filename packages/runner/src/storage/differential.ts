import { unclaimed } from "@commontools/memory/fact";
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
const toAddress = (state: State) => ({
  id: state.of,
  type: state.the,
  path: [],
});

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
      const address = toAddress(fact);
      const after = memory.get(address)?.is;
      if (
        before !== after &&
        JSON.stringify(before) !== JSON.stringify(after)
      ) {
        changes.add({ address, before, after });
      }
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
      this.add({
        address: toAddress(fact),
        before: undefined,
        after: fact.is,
      });
    }
    return this;
  }

  /**
   * Captures changes between what is in the given memory and
   * provided facts.
   */
  update(memory: Memory, facts: Iterable<State>) {
    for (const fact of facts) {
      const address = toAddress(fact);
      const before = memory.get(address)?.is;
      const after = fact.is;
      if (
        before !== after &&
        JSON.stringify(before) !== JSON.stringify(after)
      ) {
        this.add({ address, before, after });
      }
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
