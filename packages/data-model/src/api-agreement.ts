/**
 * Compile-time agreement between the abstract base classes in `interface.ts`
 * and their pattern-visible declarations in `api.ts`, which is what a pattern
 * compiles against. No module imports this one: it exists to be type-checked,
 * which `deno check` does for every module under the package whether or not
 * something imports it, and everything here erases at compile time. The
 * concrete classes under `fabric-primitives/` and `fabric-instances/` carry
 * the same kind of guard, each beside its own definition.
 *
 * Mutual assignability, not `satisfies`. A one-way check passes when the class
 * carries a member the declaration omits, since the extra member only makes
 * the class more assignable; that is the direction a pattern feels, because
 * the member it cannot reach is the one missing from the declaration. Both
 * directions have to be asserted for a member added on either side alone to
 * fail here. Each class is checked on its instance side and on its
 * constructor side, so a static member or a construct signature that one side
 * gains alone fails here as well.
 */

import type {
  FabricInstance as ApiFabricInstance,
  FabricPrimitive as ApiFabricPrimitive,
  FabricSpecialObject as ApiFabricSpecialObject,
} from "./api.ts";
import type {
  FabricInstance,
  FabricPrimitive,
  FabricSpecialObject,
} from "./interface.ts";

/** Whether `A` and `B` are mutually assignable. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Compiles only when its argument is `true`. */
type MustBeTrue<T extends true> = T;

/** Whether `FabricSpecialObject` agrees with its declaration. */
export type SpecialObjectAgrees = MustBeTrue<
  Same<FabricSpecialObject, ApiFabricSpecialObject>
>;

/** Whether `FabricInstance` agrees with its declaration. */
export type InstanceAgrees = MustBeTrue<
  Same<FabricInstance, ApiFabricInstance>
>;

/** Whether `FabricPrimitive` agrees with its declaration. */
export type PrimitiveAgrees = MustBeTrue<
  Same<FabricPrimitive, ApiFabricPrimitive>
>;

/** Whether the `FabricSpecialObject` constructor agrees with its declaration. */
export type SpecialObjectConstructorAgrees = MustBeTrue<
  Same<typeof FabricSpecialObject, typeof ApiFabricSpecialObject>
>;

/** Whether the `FabricInstance` constructor agrees with its declaration. */
export type InstanceConstructorAgrees = MustBeTrue<
  Same<typeof FabricInstance, typeof ApiFabricInstance>
>;

/** Whether the `FabricPrimitive` constructor agrees with its declaration. */
export type PrimitiveConstructorAgrees = MustBeTrue<
  Same<typeof FabricPrimitive, typeof ApiFabricPrimitive>
>;
