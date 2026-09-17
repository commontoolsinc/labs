/**
 * The marker for data that is not available, and the vocabulary of reasons it
 * can give: the reason set as a runtime table, the class, and one prefab
 * instance per reason that carries no message. The codecs decode a state
 * naming one of those reasons to the prefab rather than to a fresh instance,
 * so the three are the canonical instances of what they name, though nothing
 * turns on that: two instances with the same reason and message are equal by
 * content however they were made.
 */

import type {
  FabricUnavailable as ApiFabricUnavailable,
  FabricUnavailableConstructor as ApiFabricUnavailableConstructor,
  UnavailableReason,
} from "@/api.ts";
import { backtickQuote } from "@commonfabric/utils/markdown";
import type { MustBeTrue, Same } from "@commonfabric/utils/types";
import { isPlainObject } from "@commonfabric/utils/types";

import {
  BaseFabricPrimitive,
  VALUE_TAG,
} from "@/fabric-bases/BaseFabricPrimitive.ts";
import { ProblematicValue } from "@/codec-common/ProblematicValue.ts";
import { BaseNonterminalCodec } from "@/codec-interface/BaseNonterminalCodec.ts";
import { BaseTerminalCodec } from "@/codec-interface/BaseTerminalCodec.ts";
import { CODEC_TYPE_TAGS } from "@/codec-interface/codec-type-tags.ts";
import {
  JSON_CODEC,
  type LiveEnvironment,
  type NonterminalCodec,
  REALM_CODEC,
  type TerminalCodec,
} from "@/codec-interface/interface.ts";
import type { RealmCodecValue } from "@/codec-realm/interface.ts";
import type { FabricValue } from "@/interface.ts";
import {
  FABRIC_PRIMITIVE_VALUE_TAGS,
  type FabricPrimitiveValueTag,
} from "@/types";

/**
 * The reasons a `FabricUnavailable` can give, as a table keyed by itself, so
 * that a reason arriving as an untyped string can be checked against the set.
 * `UnavailableReason` in `api.ts` is the same set as a type; the agreement
 * guard beside this table stops compiling when the two part.
 */
export const UNAVAILABLE_REASONS = Object.freeze(
  {
    pending: "pending",
    syncing: "syncing",
    schemaMismatch: "schemaMismatch",
    error: "error",
  } as const,
);

/** Whether the table above and the declared type name the same reasons. */
export type ReasonsAgree = MustBeTrue<
  Same<
    typeof UNAVAILABLE_REASONS[keyof typeof UNAVAILABLE_REASONS],
    UnavailableReason
  >
>;

/**
 * The encoded state of a {@link FabricUnavailable}: the reason, and the
 * message when the reason is `error`. `errorMessage` is absent, rather than
 * `null`, for the other reasons, so that the state of a message-less reason
 * is exactly the reason.
 */
type FabricUnavailableState = {
  reason: UnavailableReason;
  errorMessage?: string;
};

/**
 * Whether `state` has the shape of a {@link FabricUnavailableState}: a plain
 * object whose `reason` is one of the reasons, and whose `errorMessage`, if
 * present at all, is a string. Presence is the test for the message rather
 * than a comparison against `undefined`, because the realm format carries
 * `undefined` faithfully, and a message sent that way is a malformation
 * rather than an absence. Whether the message belongs with the reason is the
 * constructor's to decide.
 */
function isUnavailableState(state: unknown): state is FabricUnavailableState {
  if (!isPlainObject(state)) {
    return false;
  }

  const { reason } = state as { reason?: unknown };

  if (
    (typeof reason !== "string") ||
    !Object.hasOwn(UNAVAILABLE_REASONS, reason)
  ) {
    return false;
  }

  return !Object.hasOwn(state, "errorMessage") ||
    (typeof (state as { errorMessage?: unknown }).errorMessage === "string");
}

/**
 * Returns the instance a decoded state stands for: the prefab for a
 * message-less reason, and a fresh instance otherwise. Throws as the
 * constructor does when the message does not belong with the reason.
 */
function instanceForState(state: FabricUnavailableState): FabricUnavailable {
  const { reason, errorMessage } = state;

  return (errorMessage === undefined)
    ? (PREFABS_BY_REASON[reason] ?? new FabricUnavailable(reason))
    : new FabricUnavailable(reason, errorMessage);
}

/**
 * A marker standing in for data that is not available, saying why. It holds
 * no data of its own: the reason, and for `error` the message, are the whole
 * of what it says, so it is a `FabricPrimitive` rather than a container.
 *
 * Only an instance with reason `error` carries a message, and one with that
 * reason always does: the constructor refuses the other pairings. See Section
 * 1.4.12 of the formal spec.
 */
export class FabricUnavailable extends BaseFabricPrimitive
  implements ApiFabricUnavailable {
  /** Why the data is unavailable. */
  readonly #reason: UnavailableReason;

  /** The message, when the reason is `error`; `null` otherwise. */
  readonly #errorMessage: string | null;

  /**
   * Constructs an instance with the given reason and message. Throws when
   * `reason` is not one of the reasons, when `reason` is `error` and no
   * message is given, or when it is any other reason and one is.
   */
  constructor(reason: UnavailableReason, errorMessage: string | null = null) {
    super();

    if (!Object.hasOwn(UNAVAILABLE_REASONS, reason)) {
      throw new Error(
        `Not an \`UnavailableReason\`: ${backtickQuote(String(reason))}`,
      );
    }

    if (reason === UNAVAILABLE_REASONS.error) {
      if (typeof errorMessage !== "string") {
        throw new Error("Reason `error` requires an `errorMessage`.");
      }
    } else if (errorMessage !== null) {
      throw new Error(
        `Reason ${backtickQuote(reason)} does not take an \`errorMessage\`.`,
      );
    }

    this.#reason = reason;
    this.#errorMessage = errorMessage;
  }

  //
  // Instance members
  //

  /** @inheritDoc */
  get [VALUE_TAG](): FabricPrimitiveValueTag {
    return FABRIC_PRIMITIVE_VALUE_TAGS.FabricUnavailable;
  }

  /** Why the data is unavailable. */
  get reason(): UnavailableReason {
    return this.#reason;
  }

  /** The message, when the reason is `error`; `null` otherwise. */
  get errorMessage(): string | null {
    return this.#errorMessage;
  }

  /** Whether the reason is `pending`. */
  isPending(): boolean {
    return this.#reason === UNAVAILABLE_REASONS.pending;
  }

  /** Whether the reason is `syncing`. */
  isSyncing(): boolean {
    return this.#reason === UNAVAILABLE_REASONS.syncing;
  }

  /** Whether the reason is `schemaMismatch`. */
  isSchemaMismatch(): boolean {
    return this.#reason === UNAVAILABLE_REASONS.schemaMismatch;
  }

  /** Whether the reason is `error`. */
  isError(): boolean {
    return this.#reason === UNAVAILABLE_REASONS.error;
  }

  //
  // Static members
  //

  static #jsonCodec = Object.freeze(
    new (class UnavailableCodec
      extends BaseNonterminalCodec<never, FabricUnavailableState> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.Unavailable, FabricUnavailable);
      }

      /** @inheritDoc */
      encode(
        value: FabricUnavailable,
        _env: LiveEnvironment,
      ): FabricUnavailableState {
        return value.#state();
      }

      /** @inheritDoc */
      canDecode(state: FabricValue): state is FabricUnavailableState {
        return isUnavailableState(state);
      }

      /**
       * @inheritDoc
       *
       * A message paired with a reason that does not take one, or an `error`
       * reason without one, is a state this class never writes, and is
       * reported rather than refused by {@link #canDecode}: the constructor
       * is what decides the pairing, and it is asked once.
       */
      decode(
        typeTag: string,
        state: FabricUnavailableState,
        _env: LiveEnvironment,
      ): FabricValue {
        try {
          return instanceForState(state);
        } catch (e) {
          return new ProblematicValue(
            typeTag,
            state,
            `Unavailable: ${(e instanceof Error) ? e.message : String(e)}`,
          );
        }
      }
    })(),
  );

  static #realmCodec = Object.freeze(
    new (class UnavailableCodec extends BaseTerminalCodec<RealmCodecValue> {
      /** Constructs an instance. */
      constructor() {
        super(CODEC_TYPE_TAGS.Unavailable, FabricUnavailable);
      }

      /** @inheritDoc */
      encode(value: FabricUnavailable, _env: LiveEnvironment): RealmCodecValue {
        return value.#state();
      }

      /** @inheritDoc */
      canDecode(state: RealmCodecValue): state is FabricUnavailableState {
        return isUnavailableState(state);
      }

      /**
       * @inheritDoc
       *
       * As on the JSON side, a message that does not belong with its reason
       * is reported here rather than refused by {@link #canDecode}.
       */
      decode(
        typeTag: string,
        state: FabricUnavailableState,
        _env: LiveEnvironment,
      ): FabricValue {
        try {
          return instanceForState(state);
        } catch (e) {
          return new ProblematicValue(
            typeTag,
            state,
            (e instanceof Error) ? e.message : String(e),
          );
        }
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [JSON_CODEC](): NonterminalCodec {
    return this.#jsonCodec;
  }

  /**
   * The codec for instances of this class in the realm-crossing format.
   *
   * Terminal, where JSON's is nonterminal, and the state is the same record
   * either way. As with `FabricRegExp`, a record of strings sits in both
   * domains at once, and terminal is what this format has to gain by: the walk
   * hands the record to the transport rather than descending into fields
   * whose shape it already knows.
   */
  static get [REALM_CODEC](): TerminalCodec<RealmCodecValue> {
    return this.#realmCodec;
  }

  /**
   * The encoded state of `this`, which is what both codecs emit: the reason,
   * and the message only when there is one.
   */
  #state(): FabricUnavailableState {
    const reason = this.#reason;

    return (this.#errorMessage === null)
      ? { reason }
      : { reason, errorMessage: this.#errorMessage };
  }
}

/** The instance for reason `pending`. */
export const UNAVAILABLE_PENDING = new FabricUnavailable(
  UNAVAILABLE_REASONS.pending,
);

/** The instance for reason `syncing`. */
export const UNAVAILABLE_SYNCING = new FabricUnavailable(
  UNAVAILABLE_REASONS.syncing,
);

/** The instance for reason `schemaMismatch`. */
export const UNAVAILABLE_SCHEMA_MISMATCH = new FabricUnavailable(
  UNAVAILABLE_REASONS.schemaMismatch,
);

/**
 * The prefab instance for each reason that has one, keyed by reason, for the
 * codecs to decode to.
 */
const PREFABS_BY_REASON: Readonly<
  Partial<Record<UnavailableReason, FabricUnavailable>>
> = Object.freeze({
  pending: UNAVAILABLE_PENDING,
  syncing: UNAVAILABLE_SYNCING,
  schemaMismatch: UNAVAILABLE_SCHEMA_MISMATCH,
});

// Compile-time check that the exported `FabricUnavailable` constructor matches
// the `FabricUnavailableConstructor` declared in `@/api.ts`. This catches a
// declared member that is missing here or has the wrong type. It does NOT
// catch the other direction: `satisfies` is an assignability check, so a
// public member on this class that the declaration omits passes silently.
// Members added here need adding there by hand.
FabricUnavailable satisfies ApiFabricUnavailableConstructor;
