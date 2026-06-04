import {
  DECONSTRUCT,
  DEEP_FREEZE,
  type FabricValue,
  IS_DEEP_FROZEN,
  RECONSTRUCT,
  type ReconstructionContext,
} from "../interface.ts";
import { TAGS } from "../fabric-type-tags.ts";
import { FrozenSet } from "../frozen-builtins.ts";
import { FabricNativeWrapper } from "./FabricNativeWrapper.ts";

/**
 * Wrapper for `Set` instances. Stub -- `[DECONSTRUCT]` and `[RECONSTRUCT]`
 * throw until `Set` support is fully implemented. Extra properties beyond the
 * wrapped collection are not supported on non-`Error` wrappers.
 */
export class FabricSet extends FabricNativeWrapper<Set<FabricValue>> {
  /** @inheritDoc */
  readonly typeTag = TAGS.Set;
  constructor(readonly set: Set<FabricValue>) {
    super();
  }

  /** @inheritDoc */
  get wireTypeTag(): string {
    return TAGS.Set;
  }

  [DECONSTRUCT](): FabricValue {
    throw new Error("FabricSet: not yet implemented");
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

  static [RECONSTRUCT](
    _state: FabricValue,
    _context: ReconstructionContext,
  ): FabricSet {
    throw new Error("FabricSet: not yet implemented");
  }
}
