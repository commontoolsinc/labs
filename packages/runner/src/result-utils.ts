import type { Cell } from "./cell.ts";

/**
 * @param resultCell The cell whose meta pattern will be set
 * @param patternCell The cell with a path that contains the the pattern link
 */
export function setPatternCell(
  resultCell: Pick<Cell<unknown>, "setMetaRaw">,
  patternCell: Pick<Cell<unknown>, "getRaw">,
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
  cell.setMetaRaw(
    "result",
    resultCell.getAsWriteRedirectLink({ includeSchema: true }),
  );
}
