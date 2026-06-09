import { DEEP_FREEZE, type FabricValue, IS_DEEP_FROZEN } from "@/interface.ts";
import {
  CODEC,
  type FabricCodec,
  type ReconstructionContext,
} from "@/wire-common/interface.ts";
import { BaseFabricCodec } from "@/wire-common/BaseFabricCodec.ts";
import { WIRE_TYPE_TAGS } from "@/wire-common/wire-type-tags.ts";
import { FrozenSet } from "@/frozen-builtins.ts";
import { FabricNativeWrapper } from "./FabricNativeWrapper.ts";

/**
 * Wrapper for `Set` instances. Stub -- the static `[CODEC]` (the source of
 * truth) throws until `Set` support is fully implemented. Extra properties
 * beyond the wrapped collection are not supported on non-`Error` wrappers.
 */
export class FabricSet extends FabricNativeWrapper<Set<FabricValue>> {
  constructor(readonly set: Set<FabricValue>) {
    super();
  }

  /** @inheritDoc */
  get wireTypeTag(): string {
    return WIRE_TYPE_TAGS.Set;
  }

  /**
   * Stub -- throws until `Set` support is fully implemented. `FabricSet` is
   * not yet used and is being reworked separately; the protocol methods are
   * deliberately left as throwing stubs (per Dan's PR #3612 review).
   */
  [DEEP_FREEZE](
    _subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    throw new Error("FabricSet: not yet implemented");
  }

  /**
   * Stub -- throws until `Set` support is fully implemented. See
   * `[DEEP_FREEZE]` above.
   */
  [IS_DEEP_FROZEN](
    _subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    throw new Error("FabricSet: not yet implemented");
  }

  /** @inheritDoc */
  protected shallowUnfrozenClone(): FabricSet {
    return new FabricSet(this.set);
  }

  /** @inheritDoc */
  protected get wrappedValue(): Set<FabricValue> {
    return this.set;
  }

  /** @inheritDoc */
  protected toNativeFrozen(): FrozenSet<FabricValue> {
    return new FrozenSet(this.set);
  }

  /** @inheritDoc */
  protected toNativeThawed(): Set<FabricValue> {
    return new Set(this.set);
  }

  static #codec = Object.freeze(
    new (class FabricSetCodec extends BaseFabricCodec {
      constructor() {
        super(WIRE_TYPE_TAGS.Set, FabricSet);
      }

      /**
       * @inheritDoc
       *
       * Stub -- throws until `Set` support is implemented.
       */
      encode(_value: FabricSet): FabricValue {
        throw new Error("FabricSet: not yet implemented");
      }

      /**
       * @inheritDoc
       *
       * Stub -- throws until `Set` support is implemented.
       */
      decode(
        _wireTypeTag: string,
        _state: FabricValue,
        _context: ReconstructionContext,
      ): FabricValue {
        throw new Error("FabricSet: not yet implemented");
      }
    })(),
  );

  /** The codec for instances of this class. */
  static get [CODEC](): FabricCodec {
    return this.#codec;
  }
}
