import type { FabricValuePlusLayer } from "@/interface.ts";

/**
 * Type predicate function used to determine if a presumed-valid value of type
 * `FabricValuePlus` or `FabricValuePlusLayer` of a given `PlusType` is in fact
 * considered to be the `PlusType`.
 */
export type PlusTypePredicate<PlusType> = (
  value: FabricValuePlusLayer<PlusType>,
) => value is PlusType;
