import { cloneCfcLabelView } from "@commonfabric/runner/cfc/label-view-core";
import { CellRef } from "../protocol/mod.ts";

export function cellRefToKey(cell: CellRef): string {
  // Key on the FULL id including its URI scheme: the hash preimage is
  // kind-free, so `of:fid1:H` and `computed:fid1:H` can name two distinct
  // docs for the same cause — stripping the scheme would conflate their
  // subscriptions.
  const id = cell.id;
  // Scope is part of a cell's address: the same space/id/path can name
  // distinct space-, user-, and session-scoped documents. Encode the whole
  // key structurally so neither scope nor separator-like path segments can
  // collide.
  return JSON.stringify({
    space: cell.space,
    scope: cell.scope,
    id,
    path: cell.path,
    ...(cell.schema !== undefined && { schema: cell.schema }),
    ...(cell.cfcLabelView !== undefined && {
      cfcLabelView: cloneCfcLabelView(cell.cfcLabelView),
    }),
  });
}
