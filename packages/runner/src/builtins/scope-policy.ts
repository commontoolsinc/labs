import type { Cell } from "../cell.ts";
import { createCell } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { CellScope } from "../builder/types.ts";
import { resolveLink } from "../link-resolution.ts";
import { narrowestScope, scopeRank } from "../scope.ts";
import {
  createSigilLinkFromParsedLink,
  getMetaLink,
  parseLink,
} from "../link-utils.ts";

export function resolvedCellScope(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  cell: Cell<any>,
): CellScope {
  return resolveLink(runtime, tx, cell.getAsNormalizedFullLink()).scope;
}

export function scopedCell<T>(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  cell: Cell<T>,
  scope: CellScope,
): Cell<T> {
  const link = cell.getAsNormalizedFullLink();
  if (link.scope === scope) {
    return cell;
  }
  return createCell<T>(runtime, { ...link, scope }, tx);
}

export function cellIdentityKey(cell: Cell<any>): {
  dedupKey: string;
  linkKey: readonly unknown[];
} {
  const { space, id, path, scope } = cell.getAsNormalizedFullLink();
  const linkKey = [space, id, scope, path] as const;
  return {
    dedupKey: JSON.stringify(linkKey),
    linkKey,
  };
}

export function narrowestCellScope(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  cells: Iterable<Cell<any> | undefined>,
): CellScope {
  return narrowestScope(
    Array.from(
      cells,
      (cell) =>
        cell === undefined ? undefined : resolvedCellScope(runtime, tx, cell),
    ),
  );
}

/**
 * If the cell contains a top level link, and its scope is narrower than the
 * cell's scope, create a copy of the cell.
 *
 * Copy over the value and the "result" meta link.
 */
export function exposedResultCell<T>(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  cell: Cell<T>,
): Cell<T> {
  // Ideally, we'd just call getRaw on the cell, but since that may be a link,
  // we need to know the base to use to parse that link.
  const target = resolveLink(
    runtime,
    tx,
    cell.getAsNormalizedFullLink(),
    "writeRedirect",
  );
  const initialCell = cell.withTx(tx);
  const raw = initialCell.getRaw({ lastNode: "writeRedirect" });
  // If the last writeRedirect target is a link, use that, but otherwise use
  // the last writeRedirect target.
  const link = parseLink(raw, target) ?? target;
  if (
    link === undefined ||
    scopeRank(link.scope) <= scopeRank(cell.getAsNormalizedFullLink().scope)
  ) {
    return cell;
  }

  const exposed = scopedCell(runtime, tx, cell, link.scope);
  // Copy the value and result linkage into the new exposed cell
  const resultLink = getMetaLink(initialCell, "result");
  if (resultLink !== undefined) {
    exposed.setMetaRaw(
      "result",
      createSigilLinkFromParsedLink(resultLink, {
        base: exposed,
        includeSchema: true,
      }),
    );
  }
  const value = initialCell.get();
  if (value !== undefined) {
    exposed.withTx(tx).set(value);
  }
  return exposed;
}
