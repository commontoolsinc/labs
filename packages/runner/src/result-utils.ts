import type { Cell } from "./cell.ts";
import { isFabricValue } from "@commonfabric/data-model/fabric-value";

/**
 * @param resultCell The cell whose meta pattern will be set
 * @param patternCell The cell with a path that contains the the pattern link
 */
export function setPatternCell(
  resultCell: Cell<unknown>,
  patternCell: Cell<unknown>,
) {
  // this could be a link to the pattern cell, and i'd like to get the
  // contents of that link embedded as the meta pattern. However, timing
  // of the creation of the pattern means that this won't generally be
  // available, so for now, we stil link to a pattern cell.
  const parentPattern = patternCell.getRaw();
  // `getRaw()` is declared against the cell's `unknown` type parameter, so
  // narrow before handing the value to a `FabricValue` API.
  if (parentPattern !== undefined && isFabricValue(parentPattern)) {
    resultCell.setMetaRaw("pattern", parentPattern);
  }
}

export function setResultCell(cell: Cell<unknown>, resultCell: Cell<unknown>) {
  cell.setMetaRaw(
    "result",
    resultCell.getAsWriteRedirectLink({ includeSchema: true }),
  );
}
