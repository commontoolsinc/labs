import { cloneCfcLabelView } from "@commonfabric/runner/cfc/label-view-core";
import { CellRef } from "../protocol/mod.ts";

export function cellRefToKey(cell: CellRef): string {
  // Strip the entity URI scheme (`of:` / `computed:`) so schemed and bare
  // forms of the same id map to one key. Collision-safe: the kind is salted
  // into the hash preimage, so bodies never coincide across schemes.
  const id = cell.id.replace(/^(of|computed):/, "");
  const schema = cell.schema ? `:${JSON.stringify(cell.schema)}` : "";
  const cfcLabelView = cell.cfcLabelView
    ? `:${JSON.stringify(cloneCfcLabelView(cell.cfcLabelView))}`
    : "";
  return `${cell.space}:${id}:${cell.path.join(".")}${schema}${cfcLabelView}`;
}
