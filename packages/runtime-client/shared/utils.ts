import { cloneCfcLabelView } from "@commonfabric/runner/cfc/label-view-core";
import { CellRef } from "../protocol/mod.ts";

/**
 * Storage-identity key for a cell ref: space + entity id + path, WITHOUT the
 * schema/cfcLabelView interpretation metadata. Two refs with this same key
 * target the same storage location. Use this to serialize writes to a cell
 * (the commit queue): schema/label differences between two writes to the same
 * location must NOT split them onto separate chains, or same-path writes could
 * commit out of order again.
 */
export function cellRefToIdentityKey(cell: CellRef): string {
  const id = cell.id.startsWith("of:") ? cell.id.substring(3) : cell.id;
  return `${cell.space}:${id}:${cell.path.join(".")}`;
}

/**
 * Full subscription key: storage identity PLUS schema/cfcLabelView, since a
 * subscription with a different schema/label is a distinct query.
 */
export function cellRefToKey(cell: CellRef): string {
  const schema = cell.schema ? `:${JSON.stringify(cell.schema)}` : "";
  const cfcLabelView = cell.cfcLabelView
    ? `:${JSON.stringify(cloneCfcLabelView(cell.cfcLabelView))}`
    : "";
  return `${cellRefToIdentityKey(cell)}${schema}${cfcLabelView}`;
}
