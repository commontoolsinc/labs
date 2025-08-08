import type {
  Assertion,
  Fact,
  IClaim,
  ITransaction,
  State,
} from "../interface.ts";
import { normalizeFact, retract } from "@commontools/memory/fact";
import { refer } from "merkle-reference";

/**
 * Memory space atomic update builder.
 */
export class Edit implements ITransaction {
  #claims: IClaim[] = [];
  #facts: Fact[] = [];

  claim(state: State) {
    this.#claims.push({
      the: state.the,
      of: state.of,
      fact: refer(normalizeFact(state)),
    });
  }
  retract(fact: Assertion) {
    this.#facts.push(retract(normalizeFact(fact)));
  }

  assert(fact: Assertion) {
    this.#facts.push(fact);
  }

  get claims() {
    return this.#claims;
  }
  get facts() {
    return this.#facts;
  }

  build(): ITransaction {
    return this;
  }
}

export const create = () => new Edit();
