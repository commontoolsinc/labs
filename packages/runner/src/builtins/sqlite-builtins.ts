// Runtime Actions for the SQLite builtins (Phase 0 wiring).
//
// These wire the builder factories (sqliteDatabase / sqliteQuery / sqliteExecute)
// through the module registry to result cells, so the public API exists and is
// smoke-testable end to end in-process.
//
// NOTE: the actual server-side execution (the `sqlite.query` protocol verb and
// the commit-folded `sqlite` write op) is the next build increment and requires
// the memory v2 protocol + a live toolshed integration harness. Until that lands,
// sqliteQuery/sqliteExecute resolve to a structured `not-implemented` error
// rather than fabricating results. sqliteDatabase yields an (empty) opaque handle
// cell now — its entity id is the database identity (server registration of
// tables/source is deferred with the protocol).

import { type Cell, createCell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type RawBuiltinResult } from "../module.ts";
import { type Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";

const NOT_IMPLEMENTED =
  "sqlite: server-side execution not implemented yet (protocol pending)";

/** Allocate a space-scoped result cell linked to the parent/pattern cells. */
function makeResultCell<T>(
  runtime: Runtime,
  parentCell: Cell<any>,
  cause: unknown,
  label: string,
  tx: IExtendedStorageTransaction,
): Cell<T> {
  const base = runtime.getCell<T>(
    parentCell.space,
    { [label]: { result: cause } },
    undefined,
    tx,
  );
  const cell = createCell(runtime, base.getAsNormalizedFullLink(), tx);
  setResultCell(cell, parentCell);
  setPatternCell(cell, parentCell.key("pattern"));
  cell.sync();
  return cell as Cell<T>;
}

/** sqliteDatabase: yields an opaque handle cell (empty value; id = db identity). */
export function sqliteDatabase(
  _inputsCell: Cell<any>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): RawBuiltinResult {
  let initialized = false;
  let handle: Cell<Record<string, never>>;
  const action: Action = (tx: IExtendedStorageTransaction) => {
    if (!initialized) {
      handle = makeResultCell<Record<string, never>>(
        runtime,
        parentCell,
        cause,
        "sqliteDatabase",
        tx,
      );
      // Empty readable value: the handle is opaque; the source descriptor is
      // server-side state keyed by this cell's id (deferred with the protocol).
      handle.withTx(tx).set({});
      sendResult(tx, handle);
      initialized = true;
    }
  };
  return { action };
}

type QueryState = { pending: boolean; result?: unknown[]; error?: unknown };

/** sqliteQuery: reactive read (server execution pending). */
export function sqliteQuery(
  _inputsCell: Cell<any>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): RawBuiltinResult {
  let initialized = false;
  let result: Cell<QueryState>;
  const action: Action = (tx: IExtendedStorageTransaction) => {
    if (!initialized) {
      result = makeResultCell<QueryState>(
        runtime,
        parentCell,
        cause,
        "sqliteQuery",
        tx,
      );
      result.withTx(tx).set({ pending: false, error: NOT_IMPLEMENTED });
      sendResult(tx, result);
      initialized = true;
    }
  };
  return { action };
}

type ExecuteState = {
  pending: boolean;
  result?: { lastInsertRowid?: number; changes: number };
  error?: unknown;
};

/** sqliteExecute: write (commit-folded execution pending). */
export function sqliteExecute(
  _inputsCell: Cell<any>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): RawBuiltinResult {
  let initialized = false;
  let result: Cell<ExecuteState>;
  const action: Action = (tx: IExtendedStorageTransaction) => {
    if (!initialized) {
      result = makeResultCell<ExecuteState>(
        runtime,
        parentCell,
        cause,
        "sqliteExecute",
        tx,
      );
      result.withTx(tx).set({ pending: false, error: NOT_IMPLEMENTED });
      sendResult(tx, result);
      initialized = true;
    }
  };
  return { action };
}
