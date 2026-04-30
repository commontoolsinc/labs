import { cloneCfcLabelView } from "@commonfabric/runner/cfc/label-view-core";
import { CellRef } from "../protocol/mod.ts";

export function cellRefToKey(cell: CellRef): string {
  const id = cell.id.startsWith("of:") ? cell.id.substring(3) : cell.id;
  const schema = cell.schema ? `:${JSON.stringify(cell.schema)}` : "";
  const cfcLabelView = cell.cfcLabelView
    ? `:${JSON.stringify(cloneCfcLabelView(cell.cfcLabelView))}`
    : "";
  return `${cell.space}:${id}:${cell.path.join(".")}${schema}${cfcLabelView}`;
}
