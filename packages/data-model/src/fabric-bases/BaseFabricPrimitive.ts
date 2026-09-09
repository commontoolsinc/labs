/**
 * The implementation side of the primitive hierarchy: the base class that
 * concrete primitives extend, and the symbol seeding its plumbing members.
 *
 * `FabricPrimitive` is the contract external code is written against, and this
 * is where the shared implementation behind it lives. The split is held by
 * convention rather than by the type system -- nothing stops a subclass from
 * extending the contract directly -- so the invariant is enforced at runtime
 * instead of being assumed.
 */

import { FabricPrimitive } from "@/interface.ts";
import { toCompactDebugString } from "@/value-debug.ts";
import type { ValueTag } from "@/value-tags.ts";

/**
 * Well-known symbol used for the `FabricPrimitive` getter defined below.
 */
export const VALUE_TAG: unique symbol = Symbol("data-model.valueTag");

/**
 * Abstract base class for `FabricPrimitive` subclasses. Concrete
 * `FabricPrimitive` classes extend this, not `FabricPrimitive` directly:
 * `FabricPrimitive` is the pure abstract contract that external code is written
 * against, while `BaseFabricPrimitive` is the designated home for shared
 * implementation. Its counterpart `BaseFabricInstance` carries the
 * `shallowClone()` template method; this class carries the construction-time
 * freeze, the static invariant guard, and a placeholder seed member (see
 * `[EXAMPLE_METHOD]`).
 */
export abstract class BaseFabricPrimitive extends FabricPrimitive {
  /** Constructs an instance. */
  constructor() {
    super();

    // Freezing here rather than at the end of each concrete constructor is
    // sound because a primitive's state is entirely private: private fields
    // are not properties, so a subclass assigns its own after `super()`
    // returns regardless of this. A primitive is immutable from birth and has
    // no mutable phase, so a frozen report is simply true of it -- and the
    // freeze makes it non-extensible too, which is what turns a stray property
    // addition into a throw.
    Object.freeze(this);
  }

  //
  // Subclass contract
  //

  /**
   * The value tag associated with this instance, as returned from `tagFrom*()`
   * functions.
   */
  abstract get [VALUE_TAG](): ValueTag;

  //
  // Instance members
  //

  /**
   * Custom inspector, so that a `console.log()` or a debugger shows what this
   * value IS. The default rendering is `{}`: state lives in private fields,
   * which have no enumerable own properties for an inspector to find.
   *
   * Delegates to the canonical debug renderer rather than formatting here, so
   * that this surface improves whenever that one does.
   *
   * Duplicated on `BaseFabricInstance`, unavoidably. There is no shared base
   * class below `FabricSpecialObject`, and `FabricSpecialObject` itself is the
   * runtime-import-free abstract contract, so it cannot reach `value-debug`.
   */
  [Symbol.for("Deno.customInspect")](): string {
    return toCompactDebugString(this);
  }

  //
  // Static members
  //

  /**
   * Type guard for `BaseFabricPrimitive`, which also enforces the invariant
   * that every `FabricPrimitive` is in fact a `BaseFabricPrimitive`. Concrete
   * `FabricPrimitive` classes are required to extend `BaseFabricPrimitive`
   * (never `FabricPrimitive` directly), so a value that is a `FabricPrimitive`
   * but not a `BaseFabricPrimitive` indicates a broken subclass. Mirrors
   * `BaseFabricInstance.isInstance()`.
   *
   * Like its counterpart, this uses "death before confusion" on the mismatch:
   * it throws rather than quietly returning `false`, so a broken subclass is
   * surfaced at the point of use. The throw is intentional despite the
   * predicate-style name.
   *
   * @throws If `value` is a `FabricPrimitive` that is not a
   *   `BaseFabricPrimitive` -- the "shouldn't happen" invariant violation.
   */
  static isInstance(value: unknown): value is BaseFabricPrimitive {
    if (value instanceof BaseFabricPrimitive) {
      return true;
    } else if (value instanceof FabricPrimitive) {
      throw new Error(
        "Shouldn't happen: `FabricPrimitive` that is not a `BaseFabricPrimitive`.",
      );
    }

    return false;
  }
}
