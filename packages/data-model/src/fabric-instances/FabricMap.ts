import { DEEP_FREEZE, type FabricValue, IS_DEEP_FROZEN } from "@/interface.ts";
import {
  CODEC,
  DECONSTRUCT,
  type FabricCodec,
  RECONSTRUCT,
  type ReconstructionContext,
} from "@/wire-common/interface.ts";
import { BaseFabricCodec } from "@/wire-common/BaseFabricCodec.ts";
import { WIRE_TYPE_TAGS } from "@/wire-common/wire-type-tags.ts";
import { FrozenMap } from "@/frozen-builtins.ts";
import { FabricNativeWrapper } from "./FabricNativeWrapper.ts";

/**
 * Wrapper for `Map` instances. Stub -- `[DECONSTRUCT]` and `[RECONSTRUCT]`
 * throw until `Map` support is fully implemented. Extra properties beyond the
 * wrapped collection are not supported on non-`Error` wrappers.
 */
export class FabricMap
  extends FabricNativeWrapper<Map<FabricValue, FabricValue>> {
  constructor(readonly map: Map<FabricValue, FabricValue>) {
    super();
  }

  /** @inheritDoc */
  get wireTypeTag(): string {
    return WIRE_TYPE_TAGS.Map;
  }

  [DECONSTRUCT](): FabricValue {
    throw new Error("FabricMap: not yet implemented");
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
  protected shallowUnfrozenClone(): FabricMap {
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

  static [RECONSTRUCT](
    _state: FabricValue,
    _context: ReconstructionContext,
  ): FabricMap {
    throw new Error("FabricMap: not yet implemented");
  }

  static #codec = Object.freeze(
    new (class FabricMapCodec extends BaseFabricCodec {
      constructor() {
        super(WIRE_TYPE_TAGS.Map, FabricMap);
      }

      /** @inheritDoc */
      encode(value: FabricMap): FabricValue {
        return value[DECONSTRUCT]();
      }

      /** @inheritDoc */
      decode(
        _wireTypeTag: string,
        state: FabricValue,
        context: ReconstructionContext,
      ): FabricValue {
        return FabricMap[RECONSTRUCT](state, context);
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): FabricCodec {
    return this.#codec;
  }
}
