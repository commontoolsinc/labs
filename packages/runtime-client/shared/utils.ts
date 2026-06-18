import { cloneCfcLabelView } from "@commonfabric/runner/cfc/label-view-core";
import { CellRef } from "../protocol/mod.ts";

/**
 * Storage-identity key for a cell ref: space + scope + entity id + path, with
 * NO schema/cfcLabelView interpretation metadata. Two refs with this same key
 * target the same storage location and must serialize together (the commit
 * queue): schema/label differences between two writes to the same location must
 * NOT split them onto separate chains, or same-path writes could commit out of
 * order again.
 *
 * JSON-encoded so segments can't collide — a ":" or "." inside a space/id/path
 * segment would make a delimiter-joined string ambiguous (two different cells →
 * one key → cross-cell serialize/supersede, dropping a write). `scope` IS
 * included: different-scope refs are effectively different cells. (cf.
 * cfc/prepare.ts `targetKey`, per @ubik2.)
 */
export function cellRefToIdentityKey(cell: CellRef): string {
  const id = cell.id.startsWith("of:") ? cell.id.substring(3) : cell.id;
  return JSON.stringify([cell.space, cell.scope ?? null, id, cell.path]);
}

/**
 * Subscription key: storage location PLUS schema/cfcLabelView, since a
 * subscription with a different schema/label is a distinct query. Kept in its
 * established form (distinct from the commit-queue identity key above); its
 * own delimiter hardening is a separate, pre-existing concern.
 */
export function cellRefToKey(cell: CellRef): string {
  const id = cell.id.startsWith("of:") ? cell.id.substring(3) : cell.id;
  const schema = cell.schema ? `:${JSON.stringify(cell.schema)}` : "";
  const cfcLabelView = cell.cfcLabelView
    ? `:${JSON.stringify(cloneCfcLabelView(cell.cfcLabelView))}`
    : "";
  return `${cell.space}:${id}:${cell.path.join(".")}${schema}${cfcLabelView}`;
}
