import type { FabricValuePlus } from "@/interface.ts";

/**
 * Type predicate function used to determine if a presumed-valid value is
 * considered to be a `PlusType`, in the context of the `FabricValuePlus` family
 * of types.
 */
export type PlusTypePredicate<PlusType> =
  (value: FabricValuePlus<PlusType>) => value is PlusType;
