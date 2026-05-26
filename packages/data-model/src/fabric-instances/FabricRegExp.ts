import {
  DECONSTRUCT,
  DEEP_FREEZE,
  type FabricValue,
  IS_DEEP_FROZEN,
  RECONSTRUCT,
  type ReconstructionContext,
} from "../interface.ts";
import { deepFreeze } from "../deep-freeze.ts";
import { TAGS } from "../fabric-type-tags.ts";
import { FabricNativeWrapper } from "./FabricNativeWrapper.ts";

/**
 * Wrapper for `RegExp` instances in the fabric type system. Bridges native
 * `RegExp` (JS wild west) into the strongly-typed `FabricValue` layer by
 * implementing `FabricInstance`. The essential state is
 * `{ source, flags, flavor }`.
 * See Section 1.4.1 of the formal spec.
 */
export class FabricRegExp extends FabricNativeWrapper<RegExp> {
  /** @inheritDoc */
  readonly typeTag = TAGS.RegExp;

  constructor(
    /** The wrapped native `RegExp`. */
    readonly regex: RegExp,
    /** Regex flavor/dialect identifier (e.g. `"es2025"`). */
    readonly flavor: string = "es2025",
  ) {
    super();
  }

  /**
   * Deconstructs into essential state for serialization. Returns
   * `{ source, flags, flavor }` -- the values needed to reconstruct the
   * `RegExp`. Extra enumerable properties on the `RegExp` cause rejection.
   */
  [DECONSTRUCT](): FabricValue {
    rejectExtraRegExpProperties(this.regex);
    return {
      source: this.regex.source,
      flags: this.regex.flags,
      flavor: this.flavor,
    } as FabricValue;
  }

  /**
   * Deep-freezes in place. The deep-frozen form of a `FabricRegExp` is one
   * whose wrapped `RegExp` is frozen (an immutable `.lastIndex`, so stateful
   * methods won't mutate it -- matching `toNativeFrozen()`'s semantics).
   * `Object.freeze` fully immutabilizes a `RegExp` in place (unlike `Map` /
   * `Set`, whose mutating methods bypass property descriptors), so this
   * freezes `this.regex` directly rather than requiring it pre-frozen --
   * which lets a freshly-`[RECONSTRUCT]`ed `FabricRegExp` flow through the
   * deserialize-boundary `deepFreeze()` wrap without a fix-up step. There
   * are no `FabricValue` children to recurse.
   */
  [DEEP_FREEZE](
    _subFreeze: (value: FabricValue) => FabricValue,
  ): FabricValue {
    Object.freeze(this.regex);
    return Object.freeze(this) as unknown as FabricValue;
  }

  /**
   * Side-effect-free check mirroring `[DEEP_FREEZE]`'s canonical form: this
   * wrapper and its wrapped `RegExp` are frozen. There are no `FabricValue`
   * children to recurse. An unfrozen wrapped `RegExp` answers `false` --
   * never throws.
   */
  [IS_DEEP_FROZEN](
    _subIsDeepFrozen: (value: FabricValue) => boolean,
  ): boolean {
    return Object.isFrozen(this) && Object.isFrozen(this.regex);
  }

  /** @inheritDoc */
  protected shallowUnfrozenClone(): FabricRegExp {
    return new FabricRegExp(this.regex, this.flavor);
  }

  /** @inheritDoc */
  protected get wrappedValue(): RegExp {
    return this.regex;
  }

  /**
   * Returns a frozen copy of the `RegExp`. A frozen `RegExp` has an immutable
   * `.lastIndex`, so stateful methods (`exec()`, `test()`) won't work
   * correctly -- but that matches the "death before confusion" principle.
   */
  protected toNativeFrozen(): RegExp {
    return Object.freeze(new RegExp(this.regex));
  }

  /** @inheritDoc */
  protected toNativeThawed(): RegExp {
    return new RegExp(this.regex);
  }

  /**
   * Reconstructs a `FabricRegExp` from its essential state
   * (`{ source, flags, flavor }`).
   */
  static [RECONSTRUCT](
    state: FabricValue,
    context: ReconstructionContext,
  ): FabricRegExp {
    const s = state as Record<string, FabricValue>;
    const source = (s.source as string) ?? "";
    const flags = (s.flags as string) ?? "";
    const flavor = (s.flavor as string) ?? "es2025";
    const result = new FabricRegExp(new RegExp(source, flags), flavor);
    // Honor `shouldDeepFreeze`: produce the type's correct deep-frozen form
    // via its `[DEEP_FREEZE]` member (recursing through `deepFreeze`).
    return context.shouldDeepFreeze ? deepFreeze(result) : result;
  }
}

/**
 * Helper for `FabricRegExp.[DECONSTRUCT]()`, which rejects `RegExp` instances
 * with extra enumerable properties. The built-in `.lastIndex` property is not
 * enumerable, so `Object.keys()` won't see it. Any enumerable own property
 * is therefore user-added and causes rejection.
 */
function rejectExtraRegExpProperties(regex: RegExp): void {
  if (Object.keys(regex).length > 0) {
    throw new Error(
      "Cannot store RegExp with extra enumerable properties",
    );
  }
}
