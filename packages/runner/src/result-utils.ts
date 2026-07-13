import type { Cell } from "./cell.ts";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { ignoreReadForScheduling } from "./storage/reactivity-log.ts";

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
    resultCell.setMetaRaw("pattern", parentPattern);
  }
}

export function setResultCell(cell: Cell<unknown>, resultCell: Cell<unknown>) {
  const link = resultCell.getAsWriteRedirectLink({ includeSchema: true });
  const current = cell.getMetaRaw("result", {
    meta: ignoreReadForScheduling,
  });
  if (!deepEqual(current, link)) cell.setMetaRaw("result", link);
}
