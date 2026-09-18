/**
 * Compile-time agreement between the concrete primitive classes that
 * `codecClasses()` lists and `FabricPrimitiveSchemaType`: a class for every
 * name in the vocabulary, and a name in the vocabulary for every class. No
 * module imports this one: it exists to be type-checked, which `deno check`
 * does for every module under the package whether or not something imports
 * it, and everything here erases at compile time.
 *
 * Mutual assignability of two unions bounds what this catches. Two classes
 * reporting the same name add one member to the union between them, and pass.
 */

import type { MustBeTrue, Same } from "@commonfabric/utils/types";

import type { FabricPrimitiveSchemaType } from "@/api.ts";

import type { FabricPrimitiveClass } from "./index.ts";

/** Whether the names the classes report are exactly the vocabulary. */
export type SchemaTypesAgree = MustBeTrue<
  Same<
    FabricPrimitiveClass["prototype"]["schemaType"],
    FabricPrimitiveSchemaType
  >
>;
