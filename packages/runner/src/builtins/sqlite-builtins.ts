// Runtime Actions for the SQLite builtins.
//
// Wire the builder factories (sqliteDatabase / sqliteQuery / sqliteExecute)
// through the module registry to the server-side SQLite verbs over the storage
// provider (which routes the v2 protocol to the engine, real or emulated).
//
// - sqliteDatabase yields an opaque handle cell whose value is the SqliteDbRef
//   ({ id, tables }); the id is the handle cell's own (causal, opaque) entity id.
// - sqliteQuery issues a server read after commit and writes { pending, result,
//   error } back; re-runs when its `reactOn`/inputs change (it is an effect).
// - sqliteExecute issues a server write after commit; cell params bound to a
//   `_cf_link` column are encoded to sigil links (Section 02).
//
// Known V1 gaps (tracked in IMPLEMENTATION_LOG): writes are a separate RPC, not
// folded into the cell commit (no cells+rows atomicity yet); no multi-tab mutex
// / cancel / narrowest-read-scope (cf. fetch-data.ts); `_cf_link` decode of
// result rows and the post-commit `reactOn` handle-dirtying are not wired yet.

import { type Cell, createCell, isCell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type RawBuiltinResult } from "../module.ts";
import { type Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import { computeInputHashFromValue } from "./fetch-utils.ts";
import { encodeCfLinkValue } from "./sqlite/cf-link.ts";
import { isCfLinkColumn } from "@commonfabric/memory/sqlite/columns";

type SqliteDbRef = { id: string; tables?: Record<string, unknown> };
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

/**
 * Encode bound params for the wire: a cell bound to a `_cf_link` parameter is
 * turned into a sigil-link string; a cell bound elsewhere throws (cells may only
 * be persisted via link columns). For positional params we use the SQL's named
 * columns when available; lacking column info, a cell param is treated as a link
 * (encoded) — refined once column mapping lands.
 */
function encodeParams(sql: string, params: WireParams): WireParams {
  if (params === undefined) return undefined;
  const encodeOne = (value: unknown, isLinkCol: boolean): unknown => {
    if (isCell(value)) {
      if (!isLinkCol) {
        throw new TypeError("cells may only be bound to _cf_link columns");
      }
      return encodeCfLinkValue(value);
    }
    return value;
  };
  if (Array.isArray(params)) {
    // Map positional params to the INSERT column list when present.
    const cols = parseInsertColumns(sql);
    return params.map((v, i) =>
      encodeOne(v, cols ? isCfLinkColumn(cols[i] ?? "") : isCell(v))
    );
  }
  const rec = params as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    out[k] = encodeOne(v, isCfLinkColumn(k));
  }
  return out;
}

/** Best-effort parse of the column list from `INSERT INTO t (a, b, c) ...`. */
function parseInsertColumns(sql: string): string[] | undefined {
  const m = sql.match(/insert\s+into\s+[^(]+\(([^)]*)\)/i);
  if (!m) return undefined;
  return m[1].split(",").map((c) => c.trim().replace(/^["'`\[]|["'`\]]$/g, ""));
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
    } | undefined;
    if (!inputs?.db || typeof inputs.sql !== "string") return;

    const db = readDbRef(inputs.db);
    let params: WireParams;
    try {
      params = encodeParams(inputs.sql, inputs.params);
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
          const res = await provider.sqliteQuery!(db, sql, params);
          await runtime.editWithRetry((wtx) => {
            result.withTx(wtx).set({
              pending: false,
              result: res.rows,
              requestHash: hash,
            });
          });
        } catch (error) {
          await runtime.editWithRetry((wtx) => {
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

type ExecuteState = {
  pending: boolean;
  result?: { lastInsertRowid?: number; changes: number };
  error?: unknown;
  requestHash?: string;
};

/** sqliteExecute: server-side write. */
export function sqliteExecute(
  inputsCell: Cell<any>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
): RawBuiltinResult {
  let initialized = false;
  let result: Cell<ExecuteState>;
  const space = parentCell.space;

  const action: Action = (tx: IExtendedStorageTransaction) => {
    if (!initialized) {
      result = makeResultCell<ExecuteState>(
        runtime,
        parentCell,
        cause,
        "sqliteExecute",
        tx,
      );
      sendResult(tx, result);
      initialized = true;
    }

    const inputs = inputsCell.withTx(tx).get() as {
      db?: unknown;
      sql?: string;
      params?: WireParams;
    } | undefined;
    if (!inputs?.db || typeof inputs.sql !== "string") return;

    const db = readDbRef(inputs.db);
    let encodedParams: WireParams;
    try {
      encodedParams = encodeParams(inputs.sql, inputs.params);
    } catch (error) {
      result.withTx(tx).set({ pending: false, error: errMsg(error) });
      return;
    }

    const hash = computeInputHashFromValue({
      db,
      sql: inputs.sql,
      params: encodedParams ?? null,
    });
    // Dedup against committed state (survives abort+retry; see sqliteQuery).
    if (result.withTx(tx).get()?.requestHash === hash) return;
    result.withTx(tx).set({ pending: true, requestHash: hash });

    const sql = inputs.sql;
    tx.enqueuePostCommitEffect({
      id: `sqliteExecute:${hash}`,
      idempotencyKey: `sqliteExecute:${hash}`,
      kind: "sqlite-execute",
      async flush() {
        const provider = runtime.storageManager.open(space);
        try {
          const res = await provider.sqliteExecute!(db, sql, encodedParams);
          await runtime.editWithRetry((wtx) => {
            result.withTx(wtx).set({
              pending: false,
              result: res,
              requestHash: hash,
            });
          });
        } catch (error) {
          await runtime.editWithRetry((wtx) => {
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
