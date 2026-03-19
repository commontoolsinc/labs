import type { URI } from "./interface.ts";
import type { FabricDatum } from "@commontools/data-model/fabric-value";
import {
  Assertion,
  Fact,
  FactSelection,
  Invariant,
  MIME,
  Retraction,
  Revision,
  State,
  Unclaimed,
} from "./interface.ts";
import {
  ContentId,
  contentIdFromJSON,
  fromString,
  hashOf,
  isContentId,
} from "@commontools/data-model/value-hash";

/**
 * Creates an unclaimed fact.
 */
export const unclaimed = (
  { the, of }: { the: MIME; of: URI },
): Unclaimed => ({ the, of });

/**
 * Cache of frozen `{ the, of }` objects keyed by `"${the}\0${of}"`. Reusing
 * the same frozen object identity lets downstream caches (WeakMap in
 * `canonicalHash()`, merkle-reference's internal WeakMap) hit on every
 * repeat instead of re-hashing a fresh object each time.
 */
const frozenUnclaimedCache = new Map<
  string,
  Readonly<{ the: MIME; of: URI }>
>();

/**
 * Returns a content identifier for an unclaimed fact. Caches and reuses a
 * frozen `{ the, of }` object per distinct pair so that identity-based hash
 * caches downstream benefit from repeated calls.
 */
export const unclaimedRef = (
  { the, of }: { the: MIME; of: URI },
): ContentId<Unclaimed> => {
  const key = `${the}\0${of}`;
  let frozen = frozenUnclaimedCache.get(key);
  if (!frozen) {
    frozen = Object.freeze({ the, of });
    frozenUnclaimedCache.set(key, frozen);
  }
  return hashOf(frozen);
};

export const assert = <
  Is extends FabricDatum,
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
  cause?: Fact | ContentId<Fact> | null | undefined;
}) =>
  ({
    the,
    of,
    is,
    cause: isContentId(cause)
      ? cause
      : cause == null
      ? unclaimedRef({ the, of })
      : hashOf({
        the: cause.the,
        of: cause.of,
        cause: cause.cause,
        ...(cause.is ? { is: cause.is } : undefined),
      }),
  }) as Assertion<T, Of, Is>;

export const retract = (assertion: Assertion): Retraction => ({
  the: assertion.the,
  of: assertion.of,
  cause: hashOf(normalizeFact(assertion)),
});

export const claim = (fact: Fact): Invariant => ({
  the: fact.the,
  of: fact.of,
  fact: hashOf(normalizeFact(fact)),
});

export const claimState = (state: State): Invariant => ({
  the: state.the,
  of: state.of,
  fact: hashOf(state.cause ? normalizeFact(state) : unclaimed(state)),
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
  Is extends FabricDatum,
>(
  arg: {
    the: T;
    of: Of;
    is: Is;
    cause?:
      | ContentId<Assertion<T, Of, Is>>
      | ContentId<Retraction<T, Of, Is>>
      | ContentId<Unclaimed<T, Of>>
      | Fact
      | { "/": string };
  },
): Assertion<T, Of, Is>;

export function normalizeFact<
  T extends MIME,
  Of extends URI,
  Is extends FabricDatum,
>(
  arg: {
    the: T;
    of: Of;
    cause?:
      | ContentId<Assertion<T, Of, Is>>
      | ContentId<Retraction<T, Of, Is>>
      | ContentId<Unclaimed<T, Of>>
      | Fact
      | { "/": string };
  },
): Retraction<T, Of, Is>;

export function normalizeFact<
  T extends MIME,
  Of extends URI,
  Is extends FabricDatum,
>(
  arg: {
    the: T;
    of: Of;
    is?: Is;
    cause?:
      | ContentId<Assertion<T, Of, Is>>
      | ContentId<Retraction<T, Of, Is>>
      | ContentId<Unclaimed<T, Of>>
      | Fact
      | { "/": string };
  },
): Assertion<T, Of, Is> | Retraction<T, Of, Is> {
  const newCause = isContentId(arg.cause)
    ? arg.cause
    : arg.cause == null
    ? unclaimedRef({ the: arg.the, of: arg.of })
    : "/" in arg.cause
    ? contentIdFromJSON(arg.cause as unknown as { "/": string })
    : hashOf({
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

export const factReference = (fact: Fact): ContentId<Fact> => {
  return hashOf(normalizeFact(fact));
};
