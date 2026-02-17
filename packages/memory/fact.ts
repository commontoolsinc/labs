import type { StorableDatum, URI } from "./interface.ts";
import {
  Assertion,
  Fact,
  FactSelection,
  Invariant,
  MIME,
  Reference,
  Retraction,
  Revision,
  State,
  Unclaimed,
} from "./interface.ts";
import * as Ref from "./reference.ts";
import { fromJSON, fromString, is as isReference, refer } from "./reference.ts";

/**
 * Creates an unclaimed fact.
 */
export const unclaimed = (
  { the, of }: { the: MIME; of: URI },
): Unclaimed => ({ the, of });

/**
 * Returns a cached merkle reference to an unclaimed fact.
 * Caching is handled by refer() for {the, of} patterns.
 */
export const unclaimedRef = (
  { the, of }: { the: MIME; of: URI },
): Ref.View<Unclaimed> => refer({ the, of });

export const assert = <
  Is extends StorableDatum,
  T extends MIME,
  Of extends URI,
>({
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
      ? unclaimedRef({ the, of })
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
  for (const [of, attributes] of Object.entries(selection)) {
    for (const [the, changes] of Object.entries(attributes)) {
      const [change] = Object.entries(changes);
      if (change) {
        const [cause, { is, since }] = change;
        yield {
          the: the as MIME,
          of: of as URI,
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
  T extends MIME,
  Of extends URI,
  Is extends StorableDatum,
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
  T extends MIME,
  Of extends URI,
  Is extends StorableDatum,
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
  T extends MIME,
  Of extends URI,
  Is extends StorableDatum,
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
    ? unclaimedRef({ the: arg.the, of: arg.of })
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
