import type {
  FabricLink as ApiFabricLink,
  FabricLinkConstructor as ApiFabricLinkConstructor,
} from "@commonfabric/api";
import { isPlainObject, isUnsafeObjectKey } from "@commonfabric/utils/types";

import {
  DEEP_FREEZE,
  type FabricPlainObject,
  type FabricValue,
  IS_DEEP_FROZEN,
} from "@/interface.ts";
import { BaseFabricInstance } from "./BaseFabricInstance.ts";
import { cloneIfNecessary } from "@/value-clone.ts";
import { deepFreeze, isDeepFrozen } from "@/deep-freeze.ts";
import { BaseFabricCodec } from "@/codec-common/BaseFabricCodec.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import {
  CODEC,
  type FabricCodec,
  type ReconstructionContext,
} from "@/codec-common/interface.ts";
import { ProblematicValue } from "./ProblematicValue.ts";

/**
 * A link value in the fabric type system: the modern, object-shaped form of a
 * `{ "/": { "link@1": … } }` link reference. It wraps the link's payload — a
 * {@link FabricPlainObject} of addressing fields (`id`, `space`, `scope`, `path`,
 * `overwrite`) plus an optional `schema` — as its sole nested value. The
 * data-model layer does not constrain the field set; that is a consumer concern
 * (e.g. runner's `CellLinkRefPayload`).
 *
 * It is a {@link FabricInstance} (not a `FabricPrimitive`) precisely because the
 * payload is an **outgoing reference**: a link may carry a `schema`, an arbitrary
 * `FabricValue` that is not leaf data, so a link is a small object graph rather
 * than an immutable scalar. Like every instance, a `FabricLink` is wholeheartedly
 * mutable until frozen and immutable thereafter; the payload it holds is its one
 * nested `FabricValue`, frozen and cloned recursively by the protocol members.
 */
export class FabricLink extends BaseFabricInstance implements ApiFabricLink {
  /** The wrapped addressing payload (this link's sole outgoing reference). */
  #payload: FabricPlainObject;

  /**
   * Constructs a `FabricLink` wrapping `payload`. The payload must be a plain
   * object with no prototype-pollution keys; otherwise the constructor throws
   * (death before confusion). The payload is held by reference — like every
   * `FabricInstance`, the instance is mutable until frozen, so the caller must
   * not retain and mutate the payload once it has handed ownership over.
   *
   * @param payload - The addressing payload to wrap.
   */
  constructor(payload: FabricPlainObject) {
    super();
    assertValidPayload(payload);
    this.#payload = payload;
  }

  //
  // Instance members
  //

  /** The wrapped addressing payload. */
  get payload(): FabricPlainObject {
    return this.#payload;
  }

  /**
   * Deep-freezes in place: recurses into the payload (this link's sole nested
   * `FabricValue`) via `subFreeze`, then freezes this instance. Freezing `this`
   * also seals `#payload` against reassignment.
   */
  [DEEP_FREEZE](
    subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    subFreeze(this.#payload);
    return Object.freeze(this);
  }

  /**
   * Side-effect-free check mirroring `[DEEP_FREEZE]`'s canonical form: this
   * instance is frozen and its payload is recursively deep-frozen. Never throws.
   */
  [IS_DEEP_FROZEN](
    subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    return Object.isFrozen(this) && subIsDeepFrozen(this.#payload);
  }

  /** @inheritDoc */
  protected shallowUnfrozenClone(): FabricLink {
    return new FabricLink(this.#payload);
  }

  /** @inheritDoc */
  override deepClone(frozen: boolean): FabricLink {
    if (frozen && isDeepFrozen(this)) return this;
    // Deep-clone the payload to the requested frozenness (no shared mutable
    // structure with the original; already-deep-frozen subtrees are shared).
    const payload = cloneIfNecessary(this.#payload, {
      frozen,
    }) as FabricPlainObject;
    const result = new FabricLink(payload);
    return frozen ? deepFreeze(result) as FabricLink : result;
  }

  //
  // Static members
  //

  static #codec = Object.freeze(
    new (class LinkCodec extends BaseFabricCodec {
      constructor() {
        super(CODEC_TYPE_TAGS.Link, FabricLink);
      }

      /** @inheritDoc */
      encode(value: FabricLink): FabricValue {
        // The payload IS the encoded state; its nested values are recursively
        // encoded by the encoding context.
        return value.#payload;
      }

      /** @inheritDoc */
      decode(
        typeTag: string,
        state: FabricValue,
        context: ReconstructionContext,
      ): FabricValue {
        // The constructor validates the shape and throws on any violation, so
        // bad state falls into the `catch`.
        try {
          const result = new FabricLink(state as FabricPlainObject);
          return context.shouldDeepFreeze ? deepFreeze(result) : result;
        } catch (e) {
          return new ProblematicValue(
            typeTag,
            state,
            `Link: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): FabricCodec {
    return this.#codec;
  }
}

/**
 * Validates that `payload` is a well-formed {@link FabricPlainObject}: a plain
 * object with no prototype-pollution keys. Throws otherwise. (Values are
 * arbitrary `FabricValue`s and are not constrained here.)
 */
function assertValidPayload(
  payload: FabricPlainObject,
): asserts payload is FabricPlainObject {
  if (!isPlainObject(payload)) {
    throw new Error("Link payload must be a plain object.");
  }
  for (const key of Object.keys(payload)) {
    if (isUnsafeObjectKey(key)) {
      throw new Error(`Link payload has a forbidden key: "${key}".`);
    }
  }
}

// Compile-time check that the exported `FabricLink` constructor matches the
// `FabricLinkConstructor` declared in `@commonfabric/api`. This catches drift
// between the public type contract and this implementation.
FabricLink satisfies ApiFabricLinkConstructor;
