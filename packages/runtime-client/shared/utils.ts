import { cloneCfcLabelView } from "@commonfabric/runner/cfc/label-view-core";
import { CellRef } from "../protocol/mod.ts";

export function cellRefToKey(cell: CellRef): string {
  // Key on the FULL id including its URI scheme: the hash preimage is
  // kind-free, so `of:fid1:H` and `computed:fid1:H` can name two distinct
  // docs for the same cause — stripping the scheme would conflate their
  // subscriptions.
  const id = cell.id;
  const schema = cell.schema ? `:${JSON.stringify(cell.schema)}` : "";
  const cfcLabelView = cell.cfcLabelView
    ? `:${JSON.stringify(cloneCfcLabelView(cell.cfcLabelView))}`
    : "";
  return `${cell.space}:${id}:${cell.path.join(".")}${schema}${cfcLabelView}`;
}
