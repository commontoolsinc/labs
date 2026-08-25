import { cloneCfcLabelView } from "@commonfabric/runner/cfc/label-view-core";
import { CellRef } from "@/protocol/mod.ts";

/**
 * Renders a thrown value as text for a message that must be produced no matter
 * what was thrown.
 *
 * A thrown value can refuse even to be stringified -- a null-prototype object
 * has no `toString` to reach, and a hostile proxy can throw from any property
 * read -- so the derivation of a failure's description must not fail in turn.
 * `/undescribable` is the fixed token for that.
 */
export function describeFailure(error: unknown): string {
  try {
    return String(error);
  } catch {
    return "/undescribable";
  }
}

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
