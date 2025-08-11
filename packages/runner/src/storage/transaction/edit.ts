import { claimState, retract } from "@commontools/memory/fact";
import type {
  Assertion,
  Fact,
  IClaim,
  ITransaction,
  State,
} from "../interface.ts";

/**
 * Memory space atomic update builder.
 */
export class Edit implements ITransaction {
  #claims: IClaim[] = [];
  #facts: Fact[] = [];

  // TODO(@ubik2): avoid duplicates
  claim(state: State) {
    this.#claims.push(claimState(state));
  }
  retract(fact: Assertion) {
    this.#facts.push(retract(fact));
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
