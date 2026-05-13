import type { Cell } from "../cell.ts";
import { createCell } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { CellScope } from "../builder/types.ts";
import { resolveLink } from "../link-resolution.ts";
import { narrowestScope, scopeRank } from "../scope.ts";
import { parseLink } from "../link-utils.ts";

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

export function exposedResultCell<T>(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  cell: Cell<T>,
): Cell<T> {
  const raw = cell.withTx(tx).getRaw();
  const link = parseLink(raw, cell);
  if (
    link === undefined ||
    scopeRank(link.scope) <= scopeRank(cell.getAsNormalizedFullLink().scope)
  ) {
    return cell;
  }

  const exposed = scopedCell(runtime, tx, cell, link.scope);
  const sourceCell = cell.withTx(tx).getSourceCell();
  if (sourceCell !== undefined) {
    exposed.withTx(tx).setSourceCell(sourceCell);
  }
  const value = cell.withTx(tx).get();
  if (value !== undefined) {
    exposed.withTx(tx).set(value);
  }
  return exposed;
}
