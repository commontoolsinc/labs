import type { URI } from "./interface.ts";
import type { FabricValue } from "@commonfabric/api";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import {
  Assertion,
  Fact,
  Invariant,
  MIME,
  Retraction,
  State,
  Unclaimed,
} from "./interface.ts";
import { hashOf } from "@commonfabric/data-model/value-hash";

/**
 * Creates an unclaimed fact.
 */
export const unclaimed = (
  { the, of }: { the: MIME; of: URI },
): Unclaimed => ({ the, of });

/**
 * Cache of frozen `{ the, of }` objects keyed by `"${the}\0${of}"`. Reusing the
 * same frozen object identity lets the downstream hashing cache hit on every
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
): FabricHash => {
  const key = `${the}\0${of}`;
  let frozen = frozenUnclaimedCache.get(key);
  if (!frozen) {
    frozen = Object.freeze({ the, of });
    frozenUnclaimedCache.set(key, frozen);
  }
  return hashOf(frozen);
};

export const assert = <
  Is extends FabricValue,
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
  cause?: Fact | FabricHash | null | undefined;
}) =>
  ({
    the,
    of,
    is,
    cause: (cause instanceof FabricHash)
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

export const claimState = (state: State): Invariant => ({
  the: state.the,
  of: state.of,
  fact: hashOf(state.cause ? normalizeFact(state) : unclaimed(state)),
});

// Take an object that is loosely a fact (specifically, its cause might not
// conform), and convert it to a proper fact.

export function normalizeFact<
  T extends MIME,
  Of extends URI,
  Is extends FabricValue,
>(
  arg: {
    the: T;
    of: Of;
    is: Is;
    cause?:
      | FabricHash
      | Fact
      | { "/": string };
  },
): Assertion<T, Of, Is>;

export function normalizeFact<
  T extends MIME,
  Of extends URI,
  Is extends FabricValue,
>(
  arg: {
    the: T;
    of: Of;
    cause?:
      | FabricHash
      | Fact
      | { "/": string };
  },
): Retraction<T, Of, Is>;

export function normalizeFact<
  T extends MIME,
  Of extends URI,
  Is extends FabricValue,
>(
  arg: {
    the: T;
    of: Of;
    is?: Is;
    cause?:
      | FabricHash
      | Fact
      | { "/": string };
  },
): Assertion<T, Of, Is> | Retraction<T, Of, Is> {
  const newCause = (arg.cause instanceof FabricHash)
    ? arg.cause
    : arg.cause == null
    ? unclaimedRef({ the: arg.the, of: arg.of })
    : "/" in arg.cause
    ? FabricHash.fromString(arg.cause["/"])
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
