import type { FabricValue } from "@/interface.ts";
import {
  DEEP_FREEZE,
  IS_DEEP_FROZEN,
  SHALLOW_UNFROZEN_CLONE,
} from "./BaseFabricInstance.ts";
import {
  CODEC,
  type FabricCodec,
  type ReconstructionContext,
} from "@/codec-common/interface.ts";
import { BaseFabricCodec } from "@/codec-common/BaseFabricCodec.ts";
import { CODEC_TYPE_TAGS } from "@/codec-common/codec-type-tags.ts";
import { FrozenMap } from "@/frozen-builtins.ts";
import { FabricNativeWrapper } from "./FabricNativeWrapper.ts";

/**
 * Wrapper for `Map` instances. Stub -- the static `[CODEC]` (the source of
 * truth) throws until `Map` support is fully implemented. Extra properties
 * beyond the wrapped collection are not supported on non-`Error` wrappers.
 */
export class FabricMap
  extends FabricNativeWrapper<Map<FabricValue, FabricValue>> {
  constructor(readonly map: Map<FabricValue, FabricValue>) {
    super();
  }

  /**
   * Stub -- throws until `Map` support is fully implemented. `FabricMap` is
   * not yet used and is being reworked separately; the protocol methods are
   * deliberately left as throwing stubs (per Dan's PR #3612 review).
   */
  [DEEP_FREEZE](
    _subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    throw new Error("FabricMap: not yet implemented");
  }

  /**
   * Stub -- throws until `Map` support is fully implemented. See
   * `[DEEP_FREEZE]` above.
   */
  [IS_DEEP_FROZEN](
    _subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    throw new Error("FabricMap: not yet implemented");
  }

  /** @inheritDoc */
  protected [SHALLOW_UNFROZEN_CLONE](): FabricMap {
    return new FabricMap(this.map);
  }

  /** @inheritDoc */
  protected get wrappedValue(): Map<FabricValue, FabricValue> {
    return this.map;
  }

  /** @inheritDoc */
  protected toNativeFrozen(): FrozenMap<FabricValue, FabricValue> {
    return new FrozenMap(this.map);
  }

  /** @inheritDoc */
  protected toNativeThawed(): Map<FabricValue, FabricValue> {
    return new Map(this.map);
  }

  static #codec = Object.freeze(
    new (class FabricMapCodec extends BaseFabricCodec {
      constructor() {
        super(CODEC_TYPE_TAGS.Map, FabricMap);
      }

      /**
       * @inheritDoc
       *
       * Stub -- throws until `Map` support is implemented.
       */
      encode(_value: FabricMap): FabricValue {
        throw new Error("FabricMap: not yet implemented");
      }

      /**
       * @inheritDoc
       *
       * Stub -- throws until `Map` support is implemented.
       */
      decode(
        _typeTag: string,
        _state: FabricValue,
        _context: ReconstructionContext,
      ): FabricValue {
        throw new Error("FabricMap: not yet implemented");
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): FabricCodec {
    return this.#codec;
  }
}
