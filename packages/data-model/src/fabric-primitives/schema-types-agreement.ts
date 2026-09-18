/**
 * Compile-time agreement between the concrete primitive classes that
 * `codecClasses()` lists and `FabricPrimitiveSchemaType`: a class for every
 * name in the vocabulary, a name in the vocabulary for every class, and no
 * name reported by two classes. No module imports this one: it exists to be
 * type-checked, which `deno check` does for every module under the package
 * whether or not something imports it, and everything here erases at compile
 * time.
 *
 * The first two are one comparison of two unions, which cannot see a name
 * reported twice: two classes reporting one name add a single member to the
 * union between them. The third comparison is what catches that, and it is
 * what makes `fabricPrimitiveClassOfSchemaType()` a function of the name.
 */

import type { MustBeTrue, Same } from "@commonfabric/utils/types";

import type { FabricPrimitiveClass } from "./index.ts";
import type { FabricPrimitiveSchemaType } from "./interface.ts";

/** Whether `T` is a union of more than one member. */
type IsUnion<T, Whole = T> = T extends unknown
  ? ([Whole] extends [T] ? false : true)
  : never;

/** The members of `Classes` whose instances report `Name`. */
type ClassesReporting<Classes, Name> = Extract<
  Classes,
  { readonly prototype: { readonly schemaType: Name } }
>;

/**
 * Whether some name among `Names` is reported by more than one member of
 * `Classes`: `false` when none is, and `boolean` or `true` when one is.
 */
export type ReportsSharedName<Classes, Names extends string> = {
  [Name in Names]: IsUnion<ClassesReporting<Classes, Name>>;
}[Names];

/** Whether the names the classes report are exactly the vocabulary. */
export type SchemaTypesAgree = MustBeTrue<
  Same<
    FabricPrimitiveClass["prototype"]["schemaType"],
    FabricPrimitiveSchemaType
  >
>;

/** Whether each name in the vocabulary is reported by one class only. */
export type SchemaTypesDistinct = MustBeTrue<
  Same<
    ReportsSharedName<FabricPrimitiveClass, FabricPrimitiveSchemaType>,
    false
  >
>;
