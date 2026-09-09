import type { FabricValue } from "@commonfabric/api";

import type { Cell } from "./cell.ts";
import { rawMetaWriteAuthorization } from "./meta-seam.ts";

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
  if (parentPattern !== undefined) {
    // A `Cell`'s type parameter is always `FabricValue`-compatible, so
    // `getRaw()` yields a `FabricValue`. `Cell<unknown>` just cannot say so;
    // constraining `Cell<T extends FabricValue>` is what would remove this.
    resultCell.setMetaRaw(
      "pattern",
      parentPattern as FabricValue,
      rawMetaWriteAuthorization,
    );
  }
}

export function setResultCell(cell: Cell<unknown>, resultCell: Cell<unknown>) {
  cell.setMetaRaw(
    "result",
    resultCell.getAsWriteRedirectLink({ includeSchema: true }),
    rawMetaWriteAuthorization,
  );
}
