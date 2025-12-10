import { isRecord } from "@commontools/utils/types";
import { isCellHandle } from "./cell-handle.ts";

/**
 * Converts cell handles and objects that can be turned to cells to links.
 *
 * This is a CellHandle compatible form of `convertCellsToLinks`.
 * @param value - The value to convert.
 * @returns The converted value.
 */
export function serializeCellHandles(
  value: readonly any[] | Record<string, any> | any,
): any {
  if (isCellHandle(value)) {
    value = value.ref();
  } else if (isRecord(value)) {
    if (Array.isArray(value)) {
      value = value.map((value) => serializeCellHandles(value));
    } else {
      value = Object.fromEntries(
        Object.entries(value).map(([key, value]) => [
          key,
          serializeCellHandles(value),
        ]),
      );
    }
  } else if (
    !(typeof value === "string" || typeof value === "number" ||
      typeof value === "boolean" || value === undefined || value === null)
  ) {
    throw new Error(`Unknown type: ${value}`);
  }

  return value;
}
