import type { DataUnavailable as ApiDataUnavailable } from "@commonfabric/api";
import { isPlainObject } from "@commonfabric/utils/types";

import { BaseFabricCodec } from "@/codec-common/BaseFabricCodec.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import {
  CODEC,
  type FabricCodec,
  type ReconstructionContext,
} from "@/codec-common/interface.ts";
import { deepFreeze, isDeepFrozen } from "@/deep-freeze.ts";
import { DEEP_FREEZE, type FabricValue, IS_DEEP_FROZEN } from "@/interface.ts";
import { fabricFromNativeValue } from "@/native-conversion.ts";
import { cloneIfNecessary } from "@/value-clone.ts";
import { BaseFabricInstance } from "./BaseFabricInstance.ts";
import { FabricError } from "./FabricError.ts";
import { ProblematicValue } from "./ProblematicValue.ts";

/** Reasons why a value is not currently usable by a computation. */
export type DataUnavailableReason =
  | "pending"
  | "error"
  | "syncing"
  | "schema-mismatch";

/** Canonical encoded state for a {@link DataUnavailable} value. */
export type DataUnavailableState =
  | { readonly reason: "pending" }
  | { readonly reason: "error"; readonly error: FabricError }
  | { readonly reason: "syncing" }
  | { readonly reason: "schema-mismatch" };

/** A pending unavailable value. */
export type IsPending = DataUnavailable & {
  readonly reason: "pending";
  readonly pending: true;
};

/** An unavailable value carrying a producer error. */
export type HasError = DataUnavailable & {
  readonly reason: "error";
  readonly error: FabricError;
};

/** An unavailable value whose storage coverage is still synchronizing. */
export type IsSyncing = DataUnavailable & {
  readonly reason: "syncing";
  readonly syncing: true;
};

/** An unavailable value which failed its declared schema. */
export type HasSchemaMismatch = DataUnavailable & {
  readonly reason: "schema-mismatch";
  readonly schemaMismatch: true;
};

/** All concrete unavailable variants. */
export type DataUnavailableVariant =
  | IsPending
  | HasError
  | IsSyncing
  | HasSchemaMismatch;

/** Selects unavailable variants by reason. */
export type DataUnavailableFor<K extends DataUnavailableReason> = Extract<
  DataUnavailableVariant,
  { readonly reason: K }
>;

/**
 * SES can mint tamed errors whose constructor is not in the host realm's
 * native-type registry. Keep this check deliberately narrower than a generic
 * error-shaped object: these are the standard Error slots plus a constructor
 * needed to preserve the originating error type.
 */
function isErrorFromAnotherRealm(value: unknown): value is Error {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<Error> & { constructor?: unknown };
  return typeof candidate.constructor === "function" &&
    typeof candidate.name === "string" &&
    typeof candidate.message === "string" &&
    (candidate.stack === undefined || typeof candidate.stack === "string");
}

// Split production bundles can evaluate this module more than once in the
// same worker. Share the concrete-instance registry across those evaluations
// so guards remain nominal without relying on one module copy's constructor.
const DATA_UNAVAILABLE_INSTANCES = (() => {
  const key = Symbol.for("common.fabric.DataUnavailable.instances");
  const host = globalThis as unknown as Record<PropertyKey, unknown>;
  if (Object.hasOwn(host, key)) {
    const existing = host[key];
    if (!(existing instanceof WeakSet)) {
      throw new TypeError("Invalid global DataUnavailable instance registry");
    }
    return existing as WeakSet<object>;
  }
  const registry = new WeakSet<object>();
  Object.defineProperty(host, key, {
    value: registry,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return registry;
})();

/**
 * Fabric control value representing data which a computation cannot yet use.
 *
 * Construction is runtime-owned. Pattern authors observe instances through
 * the pure guard helpers rather than constructing structurally similar data.
 */
export class DataUnavailable extends BaseFabricInstance
  implements ApiDataUnavailable {
  readonly #state: DataUnavailableState;

  static readonly #pending = deepFreeze(
    new DataUnavailable({ reason: "pending" }),
  ) as IsPending;
  static readonly #syncing = deepFreeze(
    new DataUnavailable({ reason: "syncing" }),
  ) as IsSyncing;
  static readonly #schemaMismatch = deepFreeze(
    new DataUnavailable({ reason: "schema-mismatch" }),
  ) as HasSchemaMismatch;

  constructor(state: DataUnavailableState) {
    super();
    this.#state = state;
    DATA_UNAVAILABLE_INSTANCES.add(this);
  }

  /** Returns the interned pending marker. */
  static pending(): IsPending {
    return this.#pending;
  }

  /**
   * Returns a fresh error marker after converting the native error into a
   * deeply frozen {@link FabricError}.
   */
  static error(error: Error | FabricError): HasError {
    if (!(error instanceof FabricError) && !isErrorFromAnotherRealm(error)) {
      throw new TypeError("DataUnavailable.error() requires an Error");
    }
    const converted = error instanceof FabricError
      ? deepFreeze(error)
      : fabricFromNativeValue(FabricError.fromNativeError(error));
    if (!(converted instanceof FabricError)) {
      throw new TypeError("DataUnavailable.error() requires an Error");
    }
    return deepFreeze(
      new DataUnavailable({ reason: "error", error: converted }),
    ) as HasError;
  }

  /** Returns the interned syncing marker. */
  static syncing(): IsSyncing {
    return this.#syncing;
  }

  /** Returns the interned schema-mismatch marker. */
  static schemaMismatch(): HasSchemaMismatch {
    return this.#schemaMismatch;
  }

  /** The wire-level unavailable discriminator. */
  get reason(): DataUnavailableReason {
    return this.#state.reason;
  }

  /** Ergonomic projection for the pending variant. */
  get pending(): true | undefined {
    return this.#state.reason === "pending" ? true : undefined;
  }

  /** The producer error, present only for the error variant. */
  get error(): FabricError | undefined {
    return this.#state.reason === "error" ? this.#state.error : undefined;
  }

  /** Ergonomic projection for the syncing variant. */
  get syncing(): true | undefined {
    return this.#state.reason === "syncing" ? true : undefined;
  }

  /** Ergonomic projection for the schema-mismatch variant. */
  get schemaMismatch(): true | undefined {
    return this.#state.reason === "schema-mismatch" ? true : undefined;
  }

  /** @inheritDoc */
  [DEEP_FREEZE](
    subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    subFreeze(this.#state as FabricValue);
    return Object.freeze(this) as unknown as FabricValue;
  }

  /** @inheritDoc */
  [IS_DEEP_FROZEN](
    subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    return Object.isFrozen(this) &&
      subIsDeepFrozen(this.#state as FabricValue);
  }

  /** @inheritDoc */
  protected shallowUnfrozenClone(): DataUnavailable {
    return new DataUnavailable(this.#state);
  }

  /** @inheritDoc */
  override deepClone(frozen: boolean): DataUnavailable {
    if (frozen && isDeepFrozen(this)) return this;

    if (this.#state.reason !== "error") {
      if (frozen) {
        switch (this.#state.reason) {
          case "pending":
            return DataUnavailable.pending();
          case "syncing":
            return DataUnavailable.syncing();
          case "schema-mismatch":
            return DataUnavailable.schemaMismatch();
        }
      }
      const result = new DataUnavailable({ reason: this.#state.reason });
      return result;
    }

    const error = cloneIfNecessary(this.#state.error, { frozen });
    const result = new DataUnavailable({ reason: "error", error });
    return frozen ? deepFreeze(result) : result;
  }

  static #codec = Object.freeze(
    new (class DataUnavailableCodec extends BaseFabricCodec {
      constructor() {
        super(CODEC_TYPE_TAGS.DataUnavailable, DataUnavailable);
      }

      /** @inheritDoc */
      encode(value: DataUnavailable): FabricValue {
        return value.#state as FabricValue;
      }

      /** @inheritDoc */
      decode(
        typeTag: string,
        state: FabricValue,
        context: ReconstructionContext,
      ): FabricValue {
        const validated = validateState(state);
        if (validated instanceof ProblematicValue) {
          return new ProblematicValue(
            typeTag,
            state,
            validated.error,
          );
        }

        switch (validated.reason) {
          case "pending":
            return DataUnavailable.pending();
          case "syncing":
            return DataUnavailable.syncing();
          case "schema-mismatch":
            return DataUnavailable.schemaMismatch();
          case "error": {
            const result = new DataUnavailable(validated);
            return context.shouldDeepFreeze ? deepFreeze(result) : result;
          }
        }
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): FabricCodec {
    return this.#codec;
  }
}

function invalidState(state: FabricValue, message: string): ProblematicValue {
  return new ProblematicValue(
    CODEC_TYPE_TAGS.DataUnavailable,
    state,
    `DataUnavailable: ${message}`,
  );
}

function validateState(
  state: FabricValue,
): DataUnavailableState | ProblematicValue {
  if (!isPlainObject(state)) {
    return invalidState(state, "state must be a plain object");
  }

  const record = state as Record<string, FabricValue>;
  const keys = Object.keys(record);
  const reason = record.reason;
  if (typeof reason !== "string") {
    return invalidState(state, "reason is not recognized");
  }
  switch (reason) {
    case "pending":
    case "syncing":
    case "schema-mismatch":
      return keys.length === 1 && keys[0] === "reason"
        ? { reason }
        : invalidState(state, `${reason} state must contain only reason`);

    case "error":
      return keys.length === 2 && keys.includes("reason") &&
          keys.includes("error") && record.error instanceof FabricError
        ? { reason, error: record.error }
        : invalidState(
          state,
          "error state requires exactly reason and a FabricError",
        );

    default:
      return invalidState(state, "reason is not recognized");
  }
}

/** Returns whether `value` is a concrete runtime unavailable marker. */
export function isDataUnavailable(
  value: unknown,
): value is DataUnavailableVariant {
  return value !== null && typeof value === "object" &&
    DATA_UNAVAILABLE_INSTANCES.has(value);
}

/** Returns whether `value` is the concrete pending marker. */
export function isPending(value: unknown): value is IsPending {
  return isDataUnavailable(value) && value.reason === "pending";
}

/** Returns whether `value` is a concrete marker carrying an error. */
export function hasError(value: unknown): value is HasError {
  return isDataUnavailable(value) && value.reason === "error";
}

/** Returns whether `value` is the concrete syncing marker. */
export function isSyncing(value: unknown): value is IsSyncing {
  return isDataUnavailable(value) && value.reason === "syncing";
}

/** Returns whether `value` is the concrete schema-mismatch marker. */
export function hasSchemaMismatch(
  value: unknown,
): value is HasSchemaMismatch {
  return isDataUnavailable(value) &&
    value.reason === "schema-mismatch";
}
