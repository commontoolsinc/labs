import { JSONValue } from "@commontools/runner";
import {
  Assertion,
  Entity,
  Fact,
  FactSelection,
  Invariant,
  Reference,
  Retraction,
  Revision,
  State,
  The,
  Unclaimed,
} from "./interface.ts";
import {
  fromJSON,
  fromString,
  is as isReference,
  refer,
} from "merkle-reference";

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
  cause: refer(normalizeFact(assertion)),
});

export const claim = (fact: Fact): Invariant => ({
  the: fact.the,
  of: fact.of,
  fact: refer(normalizeFact(fact)),
});

export const claimState = (state: State): Invariant => ({
  the: state.the,
  of: state.of,
  fact: refer(state.cause ? normalizeFact(state) : unclaimed(state)),
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

// Take an object that is loosely a fact (specifically, its cause might not
// conform), and convert it to a proper fact.

export function normalizeFact<
  T extends The,
  Of extends Entity,
  Is extends JSONValue,
>(
  arg: {
    the: T;
    of: Of;
    is: Is;
    cause?:
      | Reference<Assertion<T, Of, Is>>
      | Reference<Retraction<T, Of, Is>>
      | Reference<Unclaimed<T, Of>>
      | Fact
      | { "/": string };
  },
): Assertion<T, Of, Is>;

export function normalizeFact<
  T extends The,
  Of extends Entity,
  Is extends JSONValue,
>(
  arg: {
    the: T;
    of: Of;
    cause?:
      | Reference<Assertion<T, Of, Is>>
      | Reference<Retraction<T, Of, Is>>
      | Reference<Unclaimed<T, Of>>
      | Fact
      | { "/": string };
  },
): Retraction<T, Of, Is>;

export function normalizeFact<
  T extends The,
  Of extends Entity,
  Is extends JSONValue,
>(
  arg: {
    the: T;
    of: Of;
    is?: Is;
    cause?:
      | Reference<Assertion<T, Of, Is>>
      | Reference<Retraction<T, Of, Is>>
      | Reference<Unclaimed<T, Of>>
      | Fact
      | { "/": string };
  },
): Assertion<T, Of, Is> | Retraction<T, Of, Is> {
  const newCause = isReference(arg.cause)
    ? arg.cause
    : arg.cause == null
    ? refer(unclaimed({ the: arg.the, of: arg.of }))
    : "/" in arg.cause
    ? fromJSON(arg.cause as unknown as { "/": string })
    : refer({
      the: arg.cause.the,
      of: arg.cause.of,
      cause: arg.cause.cause,
      ...(arg.cause.is ? { is: arg.cause.is } : undefined),
    });
  if (arg.is !== undefined) {
    return ({
      the: arg.the,
      of: arg.of,
      is: arg.is,
      cause: newCause,
    }) as Assertion<T, Of, Is>;
  } else {
    return ({
      the: arg.the,
      of: arg.of,
      cause: newCause,
    }) as Retraction<T, Of, Is>;
  }
}

export const factReference = (fact: Fact): Reference<Fact> => {
  return refer(normalizeFact(fact));
};
