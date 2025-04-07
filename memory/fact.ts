import {
  Assertion,
  Entity,
  Fact,
  FactSelection,
  Invariant,
  JSONValue,
  Reference,
  Retraction,
  Revision,
  The,
  Unclaimed,
} from "./interface.ts";
import { fromString, is as isReference, refer } from "merkle-reference";

/**
 * Creates an unclaimed fact.
 */
export const unclaimed = (
  { the, of }: { the: The; of: Entity },
): Unclaimed => ({
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
}) =>
  ({
    the,
    of,
    is,
    cause: isReference(cause)
      ? cause
      : cause == null
      ? refer(unclaimed({ the, of }))
      : refer({
        the: cause.the,
        of: cause.of,
        cause: cause.cause,
        ...(cause.is ? { is: cause.is } : undefined),
      }),
  }) as Assertion<T, Of, Is>;

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

export const iterate = function* (
  selection: FactSelection,
): Iterable<Revision<Fact>> {
  for (const [entity, attributes] of Object.entries(selection)) {
    for (const [the, changes] of Object.entries(attributes)) {
      const [change] = Object.entries(changes);
      if (change) {
        const [cause, { is, since }] = change;
        yield {
          the,
          of: entity as Entity,
          cause: fromString(cause),
          since,
          ...(is ? { is } : undefined),
        };
      }
    }
  }
};
