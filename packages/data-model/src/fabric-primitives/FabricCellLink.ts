import { isPlainObject, isUnsafeObjectKey } from "@commonfabric/utils/types";

import type { FabricValue } from "@/interface.ts";
import { BaseFabricPrimitive } from "./BaseFabricPrimitive.ts";
import { cloneIfNecessary } from "@/value-clone.ts";
import { BaseFabricCodec } from "@/codec-common/BaseFabricCodec.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import {
  CODEC,
  type FabricCodec,
  type ReconstructionContext,
} from "@/codec-common/interface.ts";
import { ProblematicValue } from "@/fabric-instances/ProblematicValue.ts";

/**
 * The payload of a {@link FabricCellLink}: a map of string keys to values that
 * are each either a `string` or an array of `string`s.
 *
 * This is structurally identical to cell-rep's `WireLinkRefPayload` — the
 * provably-plain-JSON addressing fields of a cell link (`id`, `space`, `scope`,
 * `path`, `overwrite`). The two are kept as independent declarations rather than
 * one importing the other: `WireLinkRefPayload` names the subset that crosses a
 * *string* boundary, while this names the in-memory primitive's slot; they
 * coincide today but answer to different layers.
 */
export type FabricCellLinkPayload = {
  readonly [key: string]: string | readonly string[];
};

/**
 * Immutable cell-link value in the fabric type system: the modern,
 * primitive-shaped form of a `{ "/": { "link@1": … } }` link reference. It holds
 * the link's addressing payload — a flat map of string keys to `string` or
 * `string[]` values (see {@link FabricCellLinkPayload}).
 *
 * **No outgoing references.** Although the payload is map-shaped, its values are
 * leaf data (strings and arrays of strings), not nested `FabricValue`s with an
 * independent reference life. So a `FabricCellLink` is a leaf with respect to the
 * reference graph — which is why it is a `FabricPrimitive` (no `[DEEP_FREEZE]`
 * recursion to perform) rather than a `FabricInstance`.
 *
 * **Born deep-frozen.** Like every primitive, an instance is immutable from
 * construction. The constructor obtains a deep-frozen payload via
 * `cloneIfNecessary()`, which deep-clones-and-freezes a mutable input but
 * identity-passes one that is already deep-frozen (no needless copy), then
 * freezes `this`. The caller retains no mutable shared structure with the
 * instance.
 */
export class FabricCellLink extends BaseFabricPrimitive {
  /** The deeply-frozen addressing payload. */
  readonly #payload: FabricCellLinkPayload;

  /**
   * Constructs a `FabricCellLink` from an addressing payload. The payload must
   * be a plain object whose every value is a `string` or an array of `string`s,
   * with no prototype-pollution keys; otherwise the constructor throws (death
   * before confusion). The (validated) input is passed through
   * `cloneIfNecessary()` for a deep-frozen result, so the caller retains no
   * mutable shared structure with the instance.
   *
   * @param payload - The addressing payload (not mutated; copied only if not
   *   already deep-frozen).
   */
  constructor(payload: FabricCellLinkPayload) {
    super();
    assertValidPayload(payload);
    this.#payload = cloneIfNecessary(payload);
    Object.freeze(this);
  }

  //
  // Instance members
  //

  /**
   * The addressing payload, as a deeply-frozen plain object. Safe to read and
   * index directly; every value (and any array value) is frozen, so there is
   * nothing to defensively copy.
   */
  get payload(): FabricCellLinkPayload {
    return this.#payload;
  }

  //
  // Static members
  //

  static #codec = Object.freeze(
    new (class CellLinkCodec extends BaseFabricCodec {
      constructor() {
        super(CODEC_TYPE_TAGS.CellLink, FabricCellLink);
      }

      /** @inheritDoc */
      encode(value: FabricCellLink): FabricValue {
        // The payload is already a deeply-frozen plain object of `string` /
        // `string[]` values -- itself a valid `FabricValue` -- so it serializes
        // as-is.
        return value.#payload;
      }

      /** @inheritDoc */
      decode(
        typeTag: string,
        state: FabricValue,
        _context: ReconstructionContext,
      ): FabricValue {
        // The constructor validates the shape (plain object, no unsafe keys,
        // every value `string` / `string[]`) and throws on any violation, so
        // bad state simply falls into the `catch` below.
        try {
          return new FabricCellLink(state as FabricCellLinkPayload);
        } catch (e) {
          return new ProblematicValue(
            typeTag,
            state,
            `CellLink: ${e instanceof Error ? e.message : String(e)}`,
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
 * Validates that `payload` is a well-formed {@link FabricCellLinkPayload}: a
 * plain object with no prototype-pollution keys whose every value is a `string`
 * or an array of `string`s. Throws otherwise. This guards only the shape;
 * producing the deep-frozen slot is left to `cloneIfNecessary()`.
 */
function assertValidPayload(
  payload: FabricCellLinkPayload,
): asserts payload is FabricCellLinkPayload {
  if (!isPlainObject(payload)) {
    throw new Error("Cell-link payload must be a plain object.");
  }
  for (const [key, value] of Object.entries(payload)) {
    if (isUnsafeObjectKey(key)) {
      throw new Error(`Cell-link payload has a forbidden key: "${key}".`);
    }
    const ok = typeof value === "string" ||
      (Array.isArray(value) && value.every((e) => typeof e === "string"));
    if (!ok) {
      throw new Error(
        `Cell-link payload field "${key}" must be a \`string\` or ` +
          `\`string[]\`.`,
      );
    }
  }
}
