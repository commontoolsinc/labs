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
import type { NormalizedFullLink } from "../link-types.ts";
import type { CellScope } from "../builder/types.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import { narrowestScope } from "../scope.ts";
import { computeInputHashFromValue } from "./fetch-utils.ts";
import { parseCfLinkToSigil } from "./sqlite/cf-link.ts";
import { uniqueCfcAtoms } from "../cfc/observation.ts";
import { deepEqual } from "@commonfabric/utils/deep-equal";

type SqliteDbRef = {
  id: string;
  tables?: Record<string, unknown>;
  // The author-declared scope of the SqliteDb cell (space/user/session). The
  // server folds this into the on-disk filename so user/session-scoped dbs get
  // a per-user / per-session file. Absent ⇒ "space" (the default, unqualified).
  scope?: CellScope;
};
type WireParams = readonly unknown[] | Record<string, unknown> | undefined;

const errMsg = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Allocate a result cell linked to the parent/pattern cells, at `scope` (the
 *  author-declared scope of the SqliteDb / its query result). The base entity
 *  id is scope-independent; `scope` only re-addresses which scoped instance the
 *  value lands in, matching how the server partitions the on-disk db. */
function makeResultCell<T>(
  runtime: Runtime,
  parentCell: Cell<any>,
  cause: unknown,
  label: string,
  tx: IExtendedStorageTransaction,
  scope: CellScope = "space",
): Cell<T> {
  const base = runtime.getCell<T>(
    parentCell.space,
    { [label]: { result: cause } },
    undefined,
    tx,
  );
  const link = base.getAsNormalizedFullLink();
  const cell = createCell<T>(
    runtime,
    link.scope === scope ? link : { ...link, scope },
    tx,
  );
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
    return { id: ref.id, tables: ref.tables, scope: ref.scope };
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

interface ResultColumn {
  output: string;
  table: string | null;
  column: string | null;
}

type LabelTables =
  | Record<string, { properties?: Record<string, { ifc?: unknown }> }>
  | undefined;

/**
 * Conservative `ifc` for a result column with NO single source (`null` origin —
 * an expression, literal, or aggregate like `COUNT(*)`/`upper(x)`). We can't
 * cheaply know which columns such a value derives from, so it inherits the JOIN
 * (union) of confidentiality and the MEET (intersection) of integrity across
 * EVERY declared labeled column in the db schema. This is a sound
 * over-approximation — it never under-labels confidentiality and never
 * over-trusts integrity — at the cost of possible over-restriction (we bound by
 * the whole schema rather than parsing the query's FROM tables). A column
 * without declared integrity is treated as top (it does not tighten the meet).
 * Returns undefined when the db declares no confidentiality/integrity at all.
 */
function deriveNullOriginIfc(
  tables: LabelTables,
): { confidentiality?: unknown[]; integrity?: unknown[] } | undefined {
  const conf: unknown[] = [];
  const integritySets: unknown[][] = [];
  for (const table of Object.values(tables ?? {})) {
    for (const col of Object.values(table?.properties ?? {})) {
      const ifc =
        (col as { ifc?: { confidentiality?: unknown; integrity?: unknown } })
          ?.ifc;
      if (!ifc || typeof ifc !== "object") continue;
      if (
        Array.isArray(ifc.confidentiality) && ifc.confidentiality.length > 0
      ) {
        conf.push(...ifc.confidentiality);
      }
      if (Array.isArray(ifc.integrity) && ifc.integrity.length > 0) {
        integritySets.push(ifc.integrity);
      }
    }
  }
  const confidentiality = uniqueCfcAtoms(conf);
  // Meet (intersection) over the columns that DECLARE integrity; an undeclared
  // column is top and does not tighten it. No integrity anywhere → empty.
  const integrity = integritySets.length > 0
    ? integritySets.reduce((acc, set) =>
      acc.filter((a) => set.some((b) => deepEqual(a, b)))
    )
    : [];
  const out: { confidentiality?: unknown[]; integrity?: unknown[] } = {};
  if (confidentiality.length > 0) out.confidentiality = confidentiality;
  if (integrity.length > 0) out.integrity = integrity;
  return out.confidentiality || out.integrity ? out : undefined;
}

/**
 * CFC read-labeling: from each result column's TRUE origin (table, column),
 * build a schema for the result-cell's `result` array whose per-field `ifc`
 * carries the origin column's declared confidentiality — so a consumer reading
 * `q.result[i].<col>` inherits it (re-establishing label propagation across the
 * opaque SQLite boundary).
 *
 * A `null`-origin column (expression/literal/aggregate) does NOT refuse the
 * query; it inherits the conservative join/meet of the db's labeled columns
 * (see `deriveNullOriginIfc`). The query IS refused (`{ error }`) only when two
 * columns project to the SAME output name, which would make the per-row label
 * ambiguous. Returns `{ schema }` (possibly undefined when nothing is labeled).
 */
export function labelResultSchema(
  columns: readonly ResultColumn[],
  tables: LabelTables,
): { schema?: Record<string, unknown>; error?: string } {
  const itemProps: Record<string, unknown> = {};
  const seen = new Set<string>();
  let anyLabeled = false;
  for (const c of columns) {
    // Duplicate output names make per-field labeling ambiguous: the row object
    // keeps only the last value for that key, but a label set on an earlier
    // iteration could track a DIFFERENT source column. Refuse rather than
    // mis-attribute.
    if (seen.has(c.output)) {
      return {
        error:
          `sqlite: a CFC-labeled query cannot project two columns to the same ` +
          `output name ("${c.output}") — the per-row label would be ambiguous; ` +
          `alias them to distinct names`,
      };
    }
    seen.add(c.output);

    if (c.table === null || c.column === null) {
      // No single source → conservative join/meet of the db's labeled columns.
      const derived = deriveNullOriginIfc(tables);
      if (derived) {
        itemProps[c.output] = { ifc: derived };
        anyLabeled = true;
      }
      continue;
    }
    const ifc = tables?.[c.table]?.properties?.[c.column]?.ifc;
    if (ifc && typeof ifc === "object" && Object.keys(ifc).length > 0) {
      // Deep-clone via JSON: the `ifc` read off `db.tables` is part of a
      // deep-frozen cell value exposed through a proxy. Embedding it by
      // reference makes the schema-policy walk proxy a non-extensible object
      // ("ownKeys … non-extensible"), and `structuredClone` can't clone the
      // proxy. `ifc` is plain JSON, so a round-trip yields a fully extensible
      // copy.
      itemProps[c.output] = { ifc: JSON.parse(JSON.stringify(ifc)) };
      anyLabeled = true;
    }
  }
  if (!anyLabeled) return {};
  // `additionalProperties: true` at BOTH object levels so the write preserves
  // every field it isn't labeling — the QueryState siblings (`pending`,
  // `requestHash`, `error`) and every unlabeled result column — while the
  // declared columns carry their `ifc`. A partial schema would otherwise shape
  // those away.
  return {
    schema: {
      type: "object",
      additionalProperties: true,
      properties: {
        result: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            properties: itemProps,
          },
        },
      },
    },
  };
}

/** sqliteDatabase: yields an opaque handle cell whose value is the SqliteDbRef. */
export function sqliteDatabase(
  inputsCell: Cell<any>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
  outputBinding?: NormalizedFullLink,
): RawBuiltinResult {
  let initialized = false;
  let handle: Cell<SqliteDbRef>;
  const action: Action = (tx: IExtendedStorageTransaction) => {
    if (!initialized) {
      // The db's scope is the scope the author declared on the result cell
      // (`PerUser<SqliteDb>` / `.asScope("user")`), carried on the resolved
      // output binding. The server uses it to derive a per-user / per-session
      // on-disk filename; the handle cell itself must live at that scope so its
      // value is partitioned the same way.
      const scope = outputBinding?.scope ?? "space";
      handle = makeResultCell<SqliteDbRef>(
        runtime,
        parentCell,
        cause,
        "sqliteDatabase",
        tx,
        scope,
      );
      const options = inputsCell.withTx(tx).get() as
        | { tables?: Record<string, unknown> }
        | undefined;
      const id = handle.entityId?.["/"] ?? JSON.stringify(handle.getAsLink());
      handle.withTx(tx).set({ id, tables: options?.tables, scope });
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
  outputBinding?: NormalizedFullLink,
): RawBuiltinResult {
  let initialized = false;
  let result: Cell<QueryState>;
  let resultScope: CellScope | undefined;
  const space = parentCell.space;

  const action: Action = (tx: IExtendedStorageTransaction) => {
    const inputs = inputsCell.withTx(tx).get() as {
      db?: unknown;
      sql?: string;
      params?: WireParams;
      reactOn?: unknown;
      // Transformer-injected from `db.query<Row>` / `sqliteQuery<Row>`; absent
      // for untyped queries.
      rowSchema?: unknown;
    } | undefined;

    // The query result holds rows from a scope-partitioned db, so it must be at
    // least as narrow as the db's scope; also honor any scope declared on the
    // query result binding itself. The db's scope rides on its handle value.
    const dbScope = (inputs?.db && typeof inputs.db === "object" &&
        typeof (inputs.db as SqliteDbRef).id === "string")
      ? (inputs.db as SqliteDbRef).scope
      : undefined;
    const scope = narrowestScope([outputBinding?.scope, dbScope]);

    if (!initialized || resultScope !== scope) {
      result = makeResultCell<QueryState>(
        runtime,
        parentCell,
        cause,
        "sqliteQuery",
        tx,
        scope,
      );
      sendResult(tx, result);
      initialized = true;
      resultScope = scope;
    }

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
          // CFC read-labeling (per-column static `ifc`): when the db declares
          // `ifc`, the server returns each result column's TRUE origin; map it to
          // the column's confidentiality and write the rows under a schema that
          // carries it, so a consumer reading `q.result[i].<col>` inherits the
          // label (re-establishing propagation across the opaque SQLite boundary).
          // Fail closed (refuse) on an unattributable column. The labeled write
          // is CFC-relevant; `editWithRetry` runs `prepareTxForCommit` before the
          // commit, so the label persists.
          let labelSchema: Record<string, unknown> | undefined;
          if (res.columns) {
            const { schema, error } = labelResultSchema(
              res.columns,
              db.tables as Parameters<typeof labelResultSchema>[1],
            );
            if (error) {
              await runtime.editWithRetry((wtx) => {
                if (result.withTx(wtx).get()?.requestHash !== hash) return;
                result.withTx(wtx).set({
                  pending: false,
                  error,
                  requestHash: hash,
                });
              });
              return;
            }
            labelSchema = schema;
          }
          // On the labeled path, write the rows UNDER the label schema: the
          // schema-aware write is what attaches the per-path `ifc` to each row's
          // entity doc (recording the policy alone does not). The provider rows
          // are deep-frozen and reach this write through a proxy; the
          // schema-aware diff would trip "ownKeys … non-extensible", so write a
          // plain extensible JSON copy. `editWithRetry` runs
          // `prepareTxForCommit`, so the CFC-relevant labeled write commits and
          // the label persists.
          const resultRows = labelSchema
            ? JSON.parse(JSON.stringify(rows))
            : rows;
          const wrote = await runtime.editWithRetry((wtx) => {
            // Stale-writeback guard: a newer query (different inputs -> different
            // hash) may have superseded this one while the RPC was in flight.
            // Only write back if the result cell still records THIS request.
            if (result.withTx(wtx).get()?.requestHash !== hash) return;
            const target = labelSchema
              ? result.asSchema(labelSchema).withTx(wtx)
              : result.withTx(wtx);
            target.set({
              pending: false,
              result: resultRows,
              requestHash: hash,
            });
          });
          // Surface a write-back failure as `q.error` rather than leaving the
          // query stuck `pending` (editWithRetry returns the error, not throws).
          if (wrote.error) {
            await runtime.editWithRetry((wtx) => {
              if (result.withTx(wtx).get()?.requestHash !== hash) return;
              result.withTx(wtx).set({
                pending: false,
                error: wrote.error?.message ?? "sqlite: result write failed",
                requestHash: hash,
              });
            });
          }
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
