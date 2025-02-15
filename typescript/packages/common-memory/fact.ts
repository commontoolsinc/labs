import {
  The,
  Entity,
  JSONValue,
  Fact,
  Reference,
  Assertion,
  Retraction,
  Invariant,
  Unclaimed,
  FactSelection,
} from "./interface.ts";
import { refer, fromString } from "merkle-reference";

/**
 * Creates an unclaimed fact.

 */
export const unclaimed = ({ the, of }: { the: The; of: Entity }): Unclaimed => ({
  the,
  of,
});

export const assert = <Is extends JSONValue, T extends The, Of extends Entity>({
  the,
  of,
  is,
  cause,
}: {
  the: T;
  of: Of;
  is: Is;
  cause?: Fact | Reference<Fact> | null | undefined;
}): Assertion<T, Of, Is> => ({
  the,
  of,
  is,
  cause: cause ? refer(cause) : refer(unclaimed({ the, of })),
});

export const retract = (assertion: Assertion): Retraction => ({
  the: assertion.the,
  of: assertion.of,
  cause: refer(assertion),
});

export const claim = (fact: Fact): Invariant => ({
  the: fact.the,
  of: fact.of,
  fact: refer(fact),
});

export const iterate = function* (selection: FactSelection): Iterable<Fact> {
  for (const [of, attributes] of Object.entries(selection)) {
    for (const [the, changes] of Object.entries(attributes)) {
      const [change] = Object.entries(changes);
      if (change) {
        const [cause, { is }] = change;
        yield {
          the,
          of,
          cause: fromString(cause),
          ...(is ? { is } : undefined),
        };
      }
    }
  }
};
