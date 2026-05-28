import type { FabricInstance } from "../interface.ts";
import { BaseFabricInstance } from "./BaseFabricInstance.ts";

/**
 * Abstract base class for `FabricInstance` wrappers that bridge native JS
 * objects into the `FabricValue` layer.
 * Provides a common `toNativeValue()` method used by both the shallow and
 * deep unwrap functions, replacing their `instanceof` cascades with a single
 * `instanceof FabricNativeWrapper` check.
 */
export abstract class FabricNativeWrapper<T extends object>
  extends BaseFabricInstance {
  /** The wire format tag for this wrapper's type (e.g. `TAGS.Error`). */
  abstract readonly typeTag: string;

  /** The wrapped native value, used by `toNativeValue` for freeze-state checks. */
  protected abstract get wrappedValue(): T;

  /** Converts the wrapped value to frozen form (only called on state mismatch). */
  protected abstract toNativeFrozen(): T;

  /** Converts the wrapped value to thawed form (only called on state mismatch). */
  protected abstract toNativeThawed(): T;

  /** Returns the underlying native value, optionally frozen. */
  toNativeValue(frozen: boolean): T {
    const value = this.wrappedValue;
    if (frozen === Object.isFrozen(value)) return value;
    return frozen ? this.toNativeFrozen() : this.toNativeThawed();
  }

  /** @inheritDoc */
  deepClone(_frozen: boolean): FabricInstance {
    throw new Error(
      `Cannot yet handle deep cloning of \`${this.constructor.name}\`.`,
    );
  }
}
