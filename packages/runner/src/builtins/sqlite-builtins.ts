// Runtime Actions for the SQLite builtins.
//
// Wire the builder factories (sqliteDatabase / sqliteQuery) through the module
// registry to the server-side SQLite verbs over the storage provider (which
// routes the v2 protocol to the engine, real or emulated).
//
// - sqliteDatabase yields a SqliteDb handle cell whose value is the SqliteDbRef
//   ({ id, tables }); the id is the handle cell's own (causal, opaque) entity id.
// - sqliteQuery issues a server read after commit and writes { pending, result,
//   error } back; re-runs when its `reactOn`/inputs change (it is an effect).
//
// Writes are NOT here — they are the imperative `SqliteDb.exec` (cell.ts), which
// folds a `sqlite` op into the caller's commit (atomic with cell writes), and
// shares param encoding via `encodeSqliteParams` (cell.ts). See
// docs/specs/sqlite-builtin/plans/sqlitedb-cell-type-exploration.md.
//
// `_cf_link` result columns ARE decoded here when the transformer injects a
// `rowSchema` (asCell columns -> sigil objects; see decodeRowLinkColumns). The
// multi-tab write mutex is the handle-cell `rev` bump in db.exec (cell.ts), not
// this read path.

import { type Cell, createCell, encodeSqliteParams } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type RawBuiltinResult } from "../module.ts";
import { type Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import { computeInputHashFromValue } from "./fetch-utils.ts";
import { parseCfLinkToSigil } from "./sqlite/cf-link.ts";

type SqliteDbRef = {
  id: string;
  tables?: Record<string, unknown>;
};
type WireParams = readonly unknown[] | Record<string, unknown> | undefined;

const errMsg = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Allocate a result cell linked to the parent/pattern cells. */
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

function readDbRef(value: unknown): SqliteDbRef {
  if (
    value && typeof value === "object" &&
    typeof (value as SqliteDbRef).id === "string"
  ) {
    const ref = value as SqliteDbRef;
    return { id: ref.id, tables: ref.tables };
  }
  throw new TypeError("sqlite: invalid database handle");
}

/**
 * Result columns to decode from a sigil-link STRING to a sigil-link OBJECT: the
 * keys the transformer-injected `rowSchema` marks `asCell`. A consumer reading
 * `q.result[i].<col>` under its own `<Row>` schema (Cell<T> -> asCell) then
 * rehydrates the object to a live Cell (link-resolution only recognizes link
 * OBJECTS, not JSON strings). Untyped queries inject no rowSchema -> no decode
 * (the column reads back as the raw sigil string; see sqlite-cf-link-decode.test).
 */
function asCellColumnsFromRowSchema(rowSchema: unknown): string[] {
  if (!rowSchema || typeof rowSchema !== "object") return [];
  const props = (rowSchema as { properties?: Record<string, unknown> })
    .properties;
  if (!props || typeof props !== "object") return [];
  return Object.entries(props)
    .filter(([, v]) =>
      !!v && typeof v === "object" &&
      Array.isArray((v as { asCell?: unknown }).asCell)
    )
    .map(([k]) => k);
}

/** Replace each asCell column's stored sigil-link STRING with the parsed sigil
 *  OBJECT. A value that is not a decodable link is left as-is (the asCell read
 *  then yields undefined rather than crashing the whole query). */
function decodeRowLinkColumns(
  rows: readonly unknown[],
  cols: readonly string[],
): unknown[] {
  if (cols.length === 0) return rows as unknown[];
  return rows.map((row) => {
    if (!row || typeof row !== "object") return row;
    const r = row as Record<string, unknown>;
    // Copy lazily: only allocate a new row object once a link column actually
    // decodes to a different value. Rows with no link columns (or only
    // null/non-link values) are returned as-is — no per-row spread on the
    // reactive read path.
    let out: Record<string, unknown> | undefined;
    for (const c of cols) {
      if (!(c in r)) continue;
      let decoded: unknown;
      try {
        decoded = parseCfLinkToSigil(r[c]);
      } catch {
        continue; // Leave a non-link value untouched.
      }
      if (decoded === r[c]) continue; // e.g. null -> null: nothing to change.
      out ??= { ...r };
      out[c] = decoded;
    }
    return out ?? row;
  });
}

/** sqliteDatabase: yields an opaque handle cell whose value is the SqliteDbRef. */
export function sqliteDatabase(
  inputsCell: Cell<any>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): RawBuiltinResult {
  let initialized = false;
  let handle: Cell<SqliteDbRef>;
  const action: Action = (tx: IExtendedStorageTransaction) => {
    if (!initialized) {
      handle = makeResultCell<SqliteDbRef>(
        runtime,
        parentCell,
        cause,
        "sqliteDatabase",
        tx,
      );
      const options = inputsCell.withTx(tx).get() as
        | { tables?: Record<string, unknown> }
        | undefined;
      const id = handle.entityId?.["/"] ?? JSON.stringify(handle.getAsLink());
      handle.withTx(tx).set({ id, tables: options?.tables });
      sendResult(tx, handle);
      initialized = true;
    }
  };
  return { action };
}

type QueryState = {
  pending: boolean;
  result?: unknown[];
  error?: unknown;
  requestHash?: string;
};

/** sqliteQuery: reactive server-side read. */
export function sqliteQuery(
  inputsCell: Cell<any>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): RawBuiltinResult {
  let initialized = false;
  let result: Cell<QueryState>;
  const space = parentCell.space;

  const action: Action = (tx: IExtendedStorageTransaction) => {
    if (!initialized) {
      result = makeResultCell<QueryState>(
        runtime,
        parentCell,
        cause,
        "sqliteQuery",
        tx,
      );
      sendResult(tx, result);
      initialized = true;
    }

    const inputs = inputsCell.withTx(tx).get() as {
      db?: unknown;
      sql?: string;
      params?: WireParams;
      reactOn?: unknown;
      // Transformer-injected from `db.query<Row>` / `sqliteQuery<Row>`; absent
      // for untyped queries.
      rowSchema?: unknown;
    } | undefined;
    if (!inputs?.db || typeof inputs.sql !== "string") return;

    const db = readDbRef(inputs.db);
    const linkCols = asCellColumnsFromRowSchema(inputs.rowSchema);
    let params: WireParams;
    try {
      params = encodeSqliteParams(inputs.sql, inputs.params);
    } catch (error) {
      result.withTx(tx).set({ pending: false, error: errMsg(error) });
      return;
    }
    const hash = computeInputHashFromValue({
      db,
      sql: inputs.sql,
      params: params ?? null,
      reactOn: inputs.reactOn ?? null,
    });
    // Dedup against COMMITTED state: if the result cell already records this
    // request hash, the call was issued (and survives an abort+retry, unlike an
    // in-memory flag — see fetch-data.ts). Re-issue otherwise.
    if (result.withTx(tx).get()?.requestHash === hash) return;
    result.withTx(tx).set({ pending: true, requestHash: hash });

    const sql = inputs.sql;
    tx.enqueuePostCommitEffect({
      id: `sqliteQuery:${hash}`,
      idempotencyKey: `sqliteQuery:${hash}`,
      kind: "sqlite-query",
      async flush() {
        const provider = runtime.storageManager.open(space);
        try {
          if (!provider.sqliteQuery) {
            throw new Error(
              "sqlite: storage provider does not support queries " +
                "(sqliteQuery unavailable)",
            );
          }
          const res = await provider.sqliteQuery(db, sql, params);
          // Decode asCell-marked `_cf_link` columns from sigil STRINGS to sigil
          // OBJECTS so a typed consumer's asCell schema rehydrates them to live
          // Cells (Piece A). Untyped queries (no rowSchema) keep raw strings.
          const rows = decodeRowLinkColumns(res.rows, linkCols);
          await runtime.editWithRetry((wtx) => {
            // Stale-writeback guard: a newer query (different inputs -> different
            // hash) may have superseded this one while the RPC was in flight.
            // Only write back if the result cell still records THIS request.
            if (result.withTx(wtx).get()?.requestHash !== hash) return;
            result.withTx(wtx).set({
              pending: false,
              result: rows,
              requestHash: hash,
            });
          });
        } catch (error) {
          await runtime.editWithRetry((wtx) => {
            if (result.withTx(wtx).get()?.requestHash !== hash) return;
            result.withTx(wtx).set({
              pending: false,
              error: errMsg(error),
              requestHash: hash,
            });
          });
        }
      },
    });
  };
  return { action };
}
