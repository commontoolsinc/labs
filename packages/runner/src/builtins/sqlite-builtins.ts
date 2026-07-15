// Runtime Actions for the SQLite builtins.
//
// Wire the builder factories (sqliteDatabase / sqliteQuery) through the module
// registry to the server-side SQLite verbs over the storage provider (which
// routes the v2 protocol to the engine, real or emulated).
//
// - sqliteDatabase yields a SqliteDb handle cell whose value is the SqliteDbRef
//   ({ id, tables }); the id is the handle cell's own (causal, opaque) entity id.
// - sqliteQuery issues a server read after commit and writes a direct
//   availability-aware value plus legacy state fields for old compiled graphs;
//   re-runs when its `reactOn`/inputs change (it is an effect).
//
// Writes are NOT here — they are the imperative `SqliteDb.exec` (cell.ts), which
// folds a `sqlite` op into the caller's commit (atomic with cell writes), and
// shares param encoding via `encodeSqliteParams` (cell.ts). See
// docs/specs/sqlite-builtin/01-api.md.
//
// `_cf_link` result columns ARE decoded here when the transformer injects a
// `rowSchema` (asCell columns -> sigil objects; see decodeRowLinkColumns). The
// multi-tab write mutex is the handle-cell `rev` bump in db.exec (cell.ts), not
// this read path.

import { type Cell, createCell, encodeSqliteParams } from "../cell.ts";
import { parseLink } from "../link-utils.ts";
import {
  computeRowLabelRead,
  resolveCeilingPlaceholders,
} from "./sqlite/row-label-read.ts";
import { type Action } from "../scheduler.ts";
import { type RawBuiltinResult } from "../module.ts";
import { type Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import type { CellScope } from "../builder/types.ts";
import { setPatternCell, setResultCell } from "../result-utils.ts";
import { isCellScope, narrowestScope } from "../scope.ts";
import { computeInputHashFromValue } from "./fetch-utils.ts";
import { parseCfLinkToSigil } from "./sqlite/cf-link.ts";
import { type IFCLabel, mergeLabel } from "../cfc/label-view-core.ts";
import { cloneIfNecessary } from "@commonfabric/data-model/value-clone";
import {
  fabricFromNativeValue,
  type FabricValue,
} from "@commonfabric/data-model/fabric-value";
import {
  DataUnavailable,
  type DataUnavailableVariant,
} from "@commonfabric/data-model/fabric-instances";
import {
  entityRefToString,
  isEntityRef,
} from "@commonfabric/data-model/cell-rep";
import { columnDeclaresIfc } from "@commonfabric/memory/v2";
import { validateRowLabelSpec } from "@commonfabric/memory/sqlite/row-label";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { selectUnavailableInput } from "../data-unavailability.ts";
import type { SqliteQueryResult } from "@commonfabric/api";
import {
  schemaWithOpenObjects,
  validateAgainstSchema,
} from "../cfc/schema-sanitization.ts";
import type { JSONSchema } from "../builder/types.ts";

type SqliteDbRef = {
  id: string;
  tables?: Record<string, unknown>;
  // The author-declared scope of the SqliteDb cell (space/user/session). The
  // server folds this into the on-disk filename so user/session-scoped dbs get
  // a per-user / per-session file. Absent ⇒ "space" (the default, unqualified).
  scope?: CellScope;
  // The db's owner — the principal that created the SqliteDb cell, captured
  // once at handle creation (CFC Phase 3: resolves the row rule's dbOwner()
  // and the ceiling's __ctDbOwner placeholder; never the acting reader).
  owner?: string;
  // db.exec's optimistic-concurrency revision (bumped per write, cell.ts). A
  // handle re-derivation must carry it forward: deleting it changes the handle
  // value, which every consumer hashing the handle (e.g. sqliteQuery's
  // reactOn) sees as "new inputs".
  rev?: number;
};
type WireParams = readonly unknown[] | Record<string, unknown> | undefined;

const errMsg = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const queryError = (error: unknown): DataUnavailableVariant =>
  DataUnavailable.error(
    error instanceof Error ? error : new Error(String(error)),
  );

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
    return {
      id: ref.id,
      // Materialize to plain JSON: sqliteDatabase stores the handle value
      // inline (self-contained), but a handle written before that fix (or a
      // proxy-carried read) can still hold doc LINKS where the rule's AST
      // nodes should be — the wire (server provenance gate) and every local
      // consumer need the resolved spec.
      tables: ref.tables
        ? cloneIfNecessary(
          ref.tables as Parameters<typeof cloneIfNecessary>[0],
          { frozen: false },
        ) as Record<string, unknown>
        : undefined,
      // Validate at the boundary: an invalid scope value must not flow into
      // query execution / on-disk filename derivation.
      scope: isCellScope(ref.scope) ? ref.scope : undefined,
      owner: typeof ref.owner === "string" ? ref.owner : undefined,
    };
  }
  throw new TypeError("sqlite: invalid database handle");
}

/**
 * Whether a materialized `tables` value is fully RESOLVED in this runtime — no
 * table (or rule) read through a not-yet-loaded linked doc. A rowLabel rule's
 * term LIST (array of objects) splits into per-element entity docs wherever it
 * passes through a builder-frame write (e.g. pattern static data), and no
 * schema-driven sync loads those splits, so a runtime that merely LOADED the
 * pattern can deep-resolve them to `null` (the #3830 class). Materializing
 * that read would bake `allOf: [null]` into the handle — a different value
 * (and request hash) than the creator wrote. Validation is the resolution
 * probe: a resolved rule always validates; a null-riddled one never does.
 */
function dbTablesResolved(
  tables: Record<string, unknown> | undefined,
): boolean {
  if (tables === undefined) return true;
  for (const t of Object.values(tables)) {
    if (!t || typeof t !== "object") return false; // an unresolved table doc
    const spec = (t as { rowLabel?: unknown }).rowLabel;
    if (spec === undefined) continue;
    const columns = Object.keys(
      (t as { properties?: Record<string, unknown> }).properties ?? {},
    );
    if (validateRowLabelSpec(spec, columns) !== undefined) return false;
  }
  return true;
}

/** Union of the per-column (Phase 2) confidentiality atoms a labeled result
 *  schema attaches — they ride every row, so a declared output ceiling must
 *  admit them too. */
function staticConfidentialityOf(
  labelSchema: Record<string, unknown> | undefined,
): unknown[] {
  const props = (labelSchema as {
    properties?: {
      result?: { items?: { properties?: Record<string, unknown> } };
    };
  })?.properties?.result?.items?.properties;
  if (!props) return [];
  const out: unknown[] = [];
  for (const p of Object.values(props)) {
    const conf = (p as { ifc?: { confidentiality?: unknown[] } })?.ifc
      ?.confidentiality;
    if (Array.isArray(conf)) out.push(...conf);
  }
  return out;
}

/**
 * Result columns to decode from a sigil-link STRING to a sigil-link OBJECT: the
 * keys the transformer-injected `rowSchema` marks `asCell`. A consumer reading
 * `resultOf(q).rows[i].<col>` under its own `<Row>` schema (Cell<T> -> asCell) then
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

/**
 * The row schema describes the value a pattern observes after link
 * materialization, while SQLite stores an asCell column as an encoded link and
 * this builtin writes its decoded sigil object. Validate those transport
 * objects as objects rather than following the field's `$ref` and requiring
 * the linked value itself to be embedded in the row.
 *
 * SQLite rows are flat, so only direct row properties can name result columns.
 */
function rowSchemaForDecodedLinks(
  rowSchema: JSONSchema,
  linkColumns: readonly string[],
): JSONSchema {
  if (
    typeof rowSchema !== "object" || rowSchema === null ||
    linkColumns.length === 0 ||
    typeof rowSchema.properties !== "object" ||
    rowSchema.properties === null
  ) {
    return rowSchema;
  }
  const properties = { ...rowSchema.properties };
  for (const column of linkColumns) {
    properties[column] = { type: "object" };
  }
  return { ...rowSchema, properties };
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
 * cheaply know which columns such a value derives from, so it inherits the
 * combined label of EVERY declared labeled column in the db schema, merged with
 * the runtime's own `mergeLabel` (union of confidentiality AND integrity — the
 * same accumulation the runtime uses everywhere). A sound over-approximation:
 * never under-labels, at the cost of possible over-restriction (we bound by the
 * whole schema rather than parsing the query's FROM tables). `mergeLabel` reads
 * only the label-bearing keys, so a column's `maxConfidentiality` is ignored,
 * and it returns fresh arrays (no frozen-proxy aliasing). Returns undefined when
 * the db declares no confidentiality/integrity at all.
 */
function deriveNullOriginIfc(
  tables: LabelTables,
): (IFCLabel & { observes?: "value" }) | undefined {
  let merged: IFCLabel = {};
  for (const table of Object.values(tables ?? {})) {
    for (const col of Object.values(table?.properties ?? {})) {
      const ifc = (col as { ifc?: IFCLabel })?.ifc;
      if (ifc && typeof ifc === "object") merged = mergeLabel(merged, ifc);
    }
  }
  // Confidentiality unions across contributors (a sound over-approximation: the
  // aggregate could depend on any column). Integrity does NOT: an aggregate /
  // expression / literal is a new computed value and inherits no integrity
  // evidence. Unioning integrity would let it falsely claim an atom held by a
  // single column (§8.17.1: class-aware meet, never union; propagation classes
  // pending, so conservatively empty). [CT-1668]
  //
  // C5 (observation classes): the merge is declared `observes:"value"` — an
  // expression/aggregate computed FROM column values labels the result
  // column's CONTENT channel. Shape/enumerate consumers of the result rows
  // (length, membership — a COUNT consumer counting result rows) no longer
  // inherit the whole-schema content union; the declared entry the result
  // schema mints carries the class through (prepare.ts
  // `declaredObservesClass`). Row membership itself stays governed by the
  // per-row rule machinery (row-label-read.ts), not by column content
  // labels. Class-unaware readers treat the entry as covering — the exact
  // pre-C5 behavior.
  return merged.confidentiality?.length
    ? { confidentiality: merged.confidentiality, observes: "value" }
    : undefined;
}

type ColumnIfc = {
  confidentiality?: unknown[];
  integrity?: unknown[];
  maxConfidentiality?: unknown[];
};

const unionAtoms = (
  a: unknown[] | undefined,
  b: unknown[] | undefined,
): unknown[] | undefined => {
  const out: unknown[] = [...(a ?? [])];
  for (const atom of b ?? []) {
    if (!out.some((existing) => deepEqual(existing, atom))) out.push(atom);
  }
  return out.length > 0 ? out : undefined;
};

// A write ceiling (`maxConfidentiality`) tightens only: absent = unlimited, so a
// present ceiling beats absent, and two present ceilings meet at their
// intersection (the smaller allowed set). It can never widen or be removed.
// An EMPTY intersection stays `[]`, which the verifier reads as "public only"
// (the tightest ceiling) — collapsing it to undefined would forge "no ceiling".
const tightenCeiling = (
  prior: unknown[] | undefined,
  next: unknown[] | undefined,
): unknown[] | undefined => {
  if (prior === undefined) return next;
  if (next === undefined) return prior;
  return prior.filter((atom) => next.some((n) => deepEqual(n, atom)));
};

// Integrity atoms are trust/provenance claims, NOT a confidentiality grade: a
// row read from a column carries them to satisfy downstream `requiredIntegrity`
// gates. So a re-derivation may keep or NARROW a column's integrity but must
// never MINT trust the prior store didn't already carry — unioning would let a
// re-declared `integrity: ["b"]` forge a claim the column was never trusted for
// (mirrors schema-merge.ts, where integrity is subset-clamped like the ceiling).
// Identical to `tightenCeiling` EXCEPT the prior-absent case yields undefined
// (no prior trust to inherit) rather than adopting `next` wholesale.
const clampIntegrity = (
  prior: unknown[] | undefined,
  next: unknown[] | undefined,
): unknown[] | undefined => {
  if (prior === undefined) return undefined;
  if (next === undefined) return prior;
  const kept = prior.filter((atom) => next.some((n) => deepEqual(n, atom)));
  return kept.length > 0 ? kept : undefined;
};

const mergeColumnIfcGrowOnly = (
  prior: ColumnIfc,
  next: ColumnIfc | undefined,
): ColumnIfc => {
  const n = next ?? {};
  const merged: ColumnIfc = {};
  const confidentiality = unionAtoms(prior.confidentiality, n.confidentiality);
  const integrity = clampIntegrity(prior.integrity, n.integrity);
  const maxConfidentiality = tightenCeiling(
    prior.maxConfidentiality,
    n.maxConfidentiality,
  );
  if (confidentiality) merged.confidentiality = confidentiality;
  if (integrity) merged.integrity = integrity;
  if (maxConfidentiality) merged.maxConfidentiality = maxConfidentiality;
  return merged;
};

/**
 * Grow-only merge of a db handle's per-column `ifc` across re-derivations
 * (§8.12.1: a store's effective label is monotone — it may strengthen but never
 * weaken). `tables[].ifc` lives in mutable handle-cell value data, outside the
 * schema-envelope monotonicity the labelMap enforces, so a re-derivation reading
 * a weaker input could silently lower a column's read label or widen its write
 * ceiling (audit S8). Every column the PRIOR handle labeled keeps at least that
 * label: read confidentiality/integrity union (grow); the write ceiling tightens
 * only; a dropped table/column is restored. New tables/columns in `next` are
 * additive and pass through (a fresh column or a stricter re-declaration is
 * allowed — only weakening is clamped).
 */
export const growOnlyMergeDbTables = (
  prior: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (!prior) return next;
  if (!next) return prior;
  const result = cloneIfNecessary(
    next as Parameters<typeof cloneIfNecessary>[0],
    { frozen: false },
  ) as Record<string, unknown>;
  for (const [tableName, priorTableRaw] of Object.entries(prior)) {
    const priorProps =
      (priorTableRaw as { properties?: Record<string, unknown> } | undefined)
        ?.properties;
    if (!priorProps || typeof priorProps !== "object") continue;
    const resultTable = result[tableName] as
      | { properties?: Record<string, unknown> }
      | undefined;
    if (!resultTable || typeof resultTable !== "object") {
      // Prior declared a table that `next` dropped — restore it wholesale.
      result[tableName] = cloneIfNecessary(
        priorTableRaw as Parameters<typeof cloneIfNecessary>[0],
        { frozen: false },
      );
      continue;
    }
    const resultProps = (resultTable.properties ??= {}) as Record<
      string,
      { ifc?: ColumnIfc }
    >;
    for (const [colName, priorColRaw] of Object.entries(priorProps)) {
      const priorIfc = (priorColRaw as { ifc?: ColumnIfc } | undefined)?.ifc;
      if (!columnDeclaresIfc(priorIfc)) continue;
      const resultCol = resultProps[colName] as { ifc?: ColumnIfc } | undefined;
      if (!resultCol || typeof resultCol !== "object") {
        // Prior labeled a column that `next` dropped — restore it wholesale so
        // its non-ifc structure (e.g. `type`) survives alongside the label.
        resultProps[colName] = cloneIfNecessary(
          priorColRaw as Parameters<typeof cloneIfNecessary>[0],
          { frozen: false },
        ) as { ifc?: ColumnIfc };
        continue;
      }
      resultCol.ifc = mergeColumnIfcGrowOnly(
        priorIfc as ColumnIfc,
        resultCol.ifc,
      );
    }
  }
  return result;
};

/**
 * CFC read-labeling: from each result column's TRUE origin (table, column),
 * build a schema for the result-cell's `result` array whose per-field `ifc`
 * carries the origin column's declared confidentiality — so a consumer reading
 * `resultOf(q).rows[i].<col>` inherits it (re-establishing label propagation across the
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
    if (columnDeclaresIfc(ifc)) {
      // Deep-clone to a fully extensible copy: the `ifc` read off `db.tables` is
      // part of a deep-frozen cell value exposed through a proxy, so embedding it
      // by reference makes the schema-policy walk proxy a non-extensible object
      // ("ownKeys … non-extensible"). `cloneIfNecessary(_, { frozen: false })`
      // reads through the proxy and returns plain, mutable data.
      itemProps[c.output] = {
        ifc: cloneIfNecessary(ifc as Parameters<typeof cloneIfNecessary>[0], {
          frozen: false,
        }),
      };
      anyLabeled = true;
    }
  }
  if (!anyLabeled) return {};
  const rowsSchema = {
    type: "array",
    items: {
      type: "object",
      additionalProperties: true,
      properties: itemProps,
    },
  };
  // `additionalProperties: true` at BOTH object levels so the write preserves
  // every field it isn't labeling — the legacy state siblings (`pending`,
  // `requestHash`, `error`), the direct value channel, and every unlabeled
  // result column — while the
  // declared columns carry their `ifc`. A partial schema would otherwise shape
  // those away.
  return {
    schema: {
      type: "object",
      additionalProperties: true,
      properties: {
        // Legacy raw state reads this alias. New public queries read the same
        // labeled row documents through value.rows.
        result: rowsSchema,
        value: {
          type: "object",
          additionalProperties: true,
          properties: {
            rows: rowsSchema,
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
      const id = (isEntityRef(handle.entityId)
        ? entityRefToString(handle.entityId)
        : undefined) ?? JSON.stringify(handle.getAsLink());
      // Grow-only merge the per-column `ifc` against any prior committed handle
      // value at this (causally-stable) id: the store's effective label is
      // monotone, so a re-derivation reading a weaker `tables` input cannot lower
      // a column's read label or widen its write ceiling (audit S8). First
      // creation (no prior) passes the declared tables through unchanged.
      const prior = handle.withTx(tx).get() as SqliteDbRef | undefined;
      const merged = growOnlyMergeDbTables(prior?.tables, options?.tables);
      // The db's owner: the principal creating this handle (CFC Phase 3 —
      // resolves the row rule's dbOwner(); a FIXED property of the db, not
      // the acting reader). Minted ONLY when there is no prior committed
      // handle: this init re-runs in every runtime that opens the piece (the
      // `initialized` guard is per-runtime-instance), and re-minting would
      // rotate ownership to the last opener — dbOwner() row rules and
      // {__ctDbOwner} ceiling placeholders would then admit the wrong
      // principal. An ownerless prior handle stays ownerless (dbOwner()
      // fails closed) rather than adopting a later opener.
      const owner = prior !== undefined
        ? prior.owner
        : runtime.trustSnapshotProvider()?.actingPrincipal;
      // Materialize to plain JSON: the stored handle must be SELF-CONTAINED.
      // A raw `set` of the inputs proxy would capture `tables` as a LINK into
      // this pattern's doc graph — whose rule-term splits no schema-driven
      // sync loads — so a second runtime deep-resolves parts of it to null and
      // hashes a DIFFERENT request for the same shared query cell: each
      // runtime sees the other's hash as "new inputs" and re-issues forever.
      // Inline, every runtime that can read the handle doc has the full spec.
      const tables = merged !== undefined
        ? cloneIfNecessary(
          merged as Parameters<typeof cloneIfNecessary>[0],
          { frozen: false },
        ) as Record<string, unknown>
        : undefined;
      // Fail closed on an UNRESOLVED materialization (this runtime loaded the
      // pattern but not every linked doc under `tables`): writing it would
      // bake nulls over a good prior value. The prior handle stays; a runtime
      // that resolves fully (the creator, at least) writes the inline form.
      if (prior === undefined || dbTablesResolved(tables)) {
        // RAW write, not `.set()`: this first action run can execute inside
        // the pattern's builder frame, where `set` [ID]-anchors every object
        // in an array — splitting a rule's term list into per-element entity
        // docs (the very shape the materialization above exists to avoid).
        // The raw write stores the subtree verbatim; `onlyIfDifferent` keeps
        // an unchanged re-derivation write-free (no hash churn per runtime).
        handle.withTx(tx).setRawUntyped(
          fabricFromNativeValue({
            id,
            ...(tables !== undefined && { tables }),
            scope,
            ...(owner !== undefined && { owner }),
            // Carry db.exec's write revision forward — dropping it would make
            // this re-derivation look like "new inputs" to every handle hasher.
            ...(typeof prior?.rev === "number" && { rev: prior.rev }),
          }) as FabricValue,
          true,
        );
      }
      sendResult(tx, handle);
      initialized = true;
    }
  };
  return { action };
}

type QueryState = {
  pending: boolean;
  /** Direct availability-aware channel for newly compiled graphs. */
  value?: SqliteQueryResult<unknown> | DataUnavailableVariant;
  /** Legacy rows channel retained for persisted compiled graphs. */
  result?: unknown;
  error?: unknown;
  requestHash?: string;
  /** CFC Phase 3.b read-time clearance audit: how many rows the acting reader
   *  could not read were withheld (a declared existence release). Absent when
   *  no clearance was requested. */
  withheld?: number;
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
    const rawInputs = inputsCell.withTx(tx).getRaw();
    const unavailableInput = selectUnavailableInput(rawInputs, {
      runtime,
      tx,
      base: inputsCell,
    });
    const inputs =
      (unavailableInput === undefined
        ? inputsCell.withTx(tx).get()
        : undefined) as {
          db?: unknown;
          sql?: string;
          params?: WireParams;
          reactOn?: unknown;
          // Transformer-injected from `db.query<Row>` / `sqliteQuery<Row>`; absent
          // for untyped queries.
          rowSchema?: unknown;
          // CFC Phase 3: declared output ceiling + what to do when a row's label
          // exceeds it ("fail" default | "skip"). The typed alternative is
          // MaxConfidentiality<> on the Row schema (rowSchema.ifc).
          maxConfidentiality?: unknown[];
          onExceed?: unknown;
          // CFC Phase 3.b: opt into read-time clearance — filter rows to those the
          // acting reader may read (a declared existence release). Requires the
          // touched rule-bearing table to permit it (rowLabelReadClearance).
          readClearance?: unknown;
        } | undefined;

    // The query result holds rows from a scope-partitioned db, so it must be at
    // least as narrow as the db's scope; also honor any scope declared on the
    // query result binding itself. The db's scope rides on its handle value.
    const dbScope = (inputs?.db && typeof inputs.db === "object" &&
        typeof (inputs.db as SqliteDbRef).id === "string")
      ? (inputs.db as SqliteDbRef).scope
      : undefined;
    // CFC Phase 3.b: a read-time-clearance result is filtered to the ACTING
    // READER, so it must never be shared across readers. Force it to (at least)
    // per-`user` scope so each reader gets an isolated result cell — otherwise a
    // space-scoped result cell would let one reader observe another's filtered
    // rows (the shared cell + reader-independent request hash both leak).
    const clearanceScope: CellScope | undefined = inputs?.readClearance
      ? "user"
      : undefined;
    const scope = narrowestScope([
      outputBinding?.scope,
      dbScope,
      clearanceScope,
    ]);

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

    if (unavailableInput !== undefined) {
      result.withTx(tx).set({
        pending: unavailableInput.reason === "pending" ||
          unavailableInput.reason === "syncing",
        value: unavailableInput,
        ...(unavailableInput.reason === "error"
          ? { error: unavailableInput.error.message }
          : {}),
      });
      return;
    }

    if (!inputs?.db || typeof inputs.sql !== "string") {
      result.withTx(tx).set({
        pending: false,
        value: DataUnavailable.schemaMismatch(),
      });
      return;
    }

    let db: SqliteDbRef;
    try {
      db = readDbRef(inputs.db);
    } catch {
      result.withTx(tx).set({
        pending: false,
        value: DataUnavailable.schemaMismatch(),
      });
      return;
    }
    const linkCols = asCellColumnsFromRowSchema(inputs.rowSchema);
    let params: WireParams;
    try {
      params = encodeSqliteParams(inputs.sql, inputs.params);
    } catch (error) {
      result.withTx(tx).set({
        pending: false,
        value: queryError(error),
        error: errMsg(error),
      });
      return;
    }
    const hash = computeInputHashFromValue({
      db,
      sql: inputs.sql,
      params: params ?? null,
      reactOn: inputs.reactOn ?? null,
      // Phase 3 read-surface options join the request identity so changing
      // them re-issues the query (pre-existing queries re-hash once — benign).
      maxConfidentiality: inputs.maxConfidentiality ?? null,
      onExceed: inputs.onExceed ?? null,
      readClearance: inputs.readClearance ?? null,
      // Phase 3.b: a cleared result depends on WHO is asking, so the acting
      // reader is part of the query identity (belt-and-suspenders with the
      // per-user result scope above — a cleared result is never keyed only by
      // the boolean). Absent for non-clearance queries so they do not re-hash.
      clearanceReader: inputs.readClearance
        ? (runtime.trustSnapshotProvider()?.actingPrincipal ?? null)
        : null,
    });
    // Dedup against COMMITTED state: if the result cell already records this
    // request hash, the call was issued (and survives an abort+retry, unlike an
    // in-memory flag — see fetch.ts). Re-issue otherwise.
    if (result.withTx(tx).get()?.requestHash === hash) return;
    result.withTx(tx).set({
      pending: true,
      value: DataUnavailable.pending(),
      requestHash: hash,
    });

    const sql = inputs.sql;
    tx.enqueuePostCommitEffect({
      id: `sqliteQuery:${hash}`,
      idempotencyKey: `sqliteQuery:${hash}`,
      kind: "sqlite-query",
      async flush() {
        // Write an error result for THIS request, guarded against a newer query
        // (different inputs -> different hash) that superseded it mid-flight.
        const failQuery = (error: string) =>
          runtime.editWithRetry((wtx) => {
            if (result.withTx(wtx).get()?.requestHash !== hash) return;
            result.withTx(wtx).set({
              pending: false,
              value: queryError(error),
              error,
              requestHash: hash,
            });
          });
        const rejectSchemaMismatch = () =>
          runtime.editWithRetry((wtx) => {
            if (result.withTx(wtx).get()?.requestHash !== hash) return;
            result.withTx(wtx).set({
              pending: false,
              value: DataUnavailable.schemaMismatch(),
              requestHash: hash,
            });
          });
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
          if (
            inputs.rowSchema !== undefined &&
            (typeof inputs.rowSchema === "object" ||
              typeof inputs.rowSchema === "boolean")
          ) {
            const rowSchema = schemaWithOpenObjects(rowSchemaForDecodedLinks(
              inputs.rowSchema as JSONSchema,
              linkCols,
            ));
            const failure = rows.map((row) =>
              validateAgainstSchema(rowSchema, row)
            ).find((item) => item !== undefined);
            if (failure !== undefined) {
              await rejectSchemaMismatch();
              return;
            }
          }
          // CFC read-labeling (per-column static `ifc`): when the db declares
          // `ifc`, the server returns each result column's TRUE origin; map it to
          // the column's confidentiality and write the rows under a schema that
          // carries it, so a consumer reading `resultOf(q).rows[i].<col>` inherits the
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
              await failQuery(error);
              return;
            }
            labelSchema = schema;
          }
          // CFC Phase 3: per-row data-derived labels + the declared output
          // ceiling. The pure half (row-label-read.ts) re-validates the wire
          // spec, locates rule inputs by TRUE origin, evaluates the rule per
          // row, and decides fail/skip under the ceiling — every unresolvable
          // case refuses the query (fail closed), never under-labels.
          const rowSchemaCeiling = (inputs.rowSchema as {
            ifc?: { maxConfidentiality?: unknown[] };
          } | undefined)?.ifc?.maxConfidentiality;
          if (
            inputs.maxConfidentiality !== undefined &&
            rowSchemaCeiling !== undefined
          ) {
            await failQuery(
              "sqlite: declare the output ceiling once — either the Row " +
                "schema's MaxConfidentiality or the query's maxConfidentiality " +
                "option, not both",
            );
            return;
          }
          let ceiling = inputs.maxConfidentiality ?? rowSchemaCeiling;
          if (ceiling !== undefined) {
            const resolved = resolveCeilingPlaceholders(ceiling, {
              actingPrincipal: runtime.trustSnapshotProvider()
                ?.actingPrincipal,
              owner: db.owner,
            });
            if ("error" in resolved) {
              await failQuery(resolved.error);
              return;
            }
            ceiling = resolved.atoms;
          }
          const rowLabels = computeRowLabelRead({
            tables: db.tables,
            columns: res.columns,
            rows,
            owner: db.owner,
            staticConfidentiality: staticConfidentialityOf(labelSchema),
            ceiling,
            onExceed: inputs.onExceed,
            // Phase 3.b read-time clearance: the reader is the acting principal
            // (same identity the ceiling placeholders resolve against).
            readClearance: inputs.readClearance
              ? { reader: runtime.trustSnapshotProvider()?.actingPrincipal }
              : undefined,
          });
          if ("error" in rowLabels) {
            await failQuery(rowLabels.error);
            return;
          }
          const withheld = rowLabels.withheld;
          // onExceed:"skip" — drop rows the declared ceiling does not admit
          // (a declared, observable existence release; 06-cfc.md ceiling).
          const keep = rowLabels.keep;
          const keptRows = keep ? rows.filter((_, i) => keep[i]) : rows;
          const perRow = keep
            ? rowLabels.labels.filter((_, i) => keep[i])
            : rowLabels.labels;
          const anyPerRow = perRow.some((l) => l !== undefined);
          // On the labeled path, write the rows UNDER the label schema: the
          // schema-aware write is what attaches the per-path `ifc` to each row's
          // entity doc (recording the policy alone does not). The provider rows
          // are deep-frozen and reach this write through a proxy; the
          // schema-aware diff would trip "ownKeys … non-extensible", so write a
          // plain extensible JSON copy. `editWithRetry` runs
          // `prepareTxForCommit`, so the CFC-relevant labeled write commits and
          // the label persists.
          const resultRows = ((labelSchema || anyPerRow)
            ? cloneIfNecessary(
              keptRows as Parameters<typeof cloneIfNecessary>[0],
              { frozen: false },
            )
            : keptRows) as unknown[];
          const value: SqliteQueryResult<unknown> = {
            rows: resultRows,
            ...(withheld !== undefined ? { withheld } : {}),
          };
          const legacyRowsLink = result.key("value").key("rows").getAsLink({
            base: result,
            includeSchema: true,
          });
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
              value,
              // Persist one row collection. The legacy channel resolves this
              // relative link, while the new public channel reads value.rows.
              result: legacyRowsLink,
              requestHash: hash,
              ...(withheld !== undefined ? { withheld } : {}),
            });
            // Per-row label attachment (CFC Phase 3): each row split into its
            // own entity doc above; write each labeled row doc DIRECTLY (its
            // own id, root path) under a root-`ifc` schema. Keyed by the row
            // doc's id, so there is no collision with the array write's items
            // schema, and the per-row root label coexists with the per-column
            // field labels on the same doc (06-cfc.md "Read — re-derive per
            // row, attach, ceiling").
            if (anyPerRow) {
              const base = result.getAsNormalizedFullLink();
              for (let i = 0; i < resultRows.length; i++) {
                const ifc = perRow[i];
                if (!ifc) continue;
                const raw = result.key("value").key("rows").key(i).withTx(wtx)
                  .getRaw();
                const link = parseLink(raw);
                if (!link?.id) {
                  // Fail closed: a labeled row MUST carry its label; aborting
                  // the tx surfaces as wrote.error -> the query error below.
                  throw new Error(
                    `sqlite: result row ${i} did not split into its own ` +
                      "entity doc — cannot attach its per-row label",
                  );
                }
                createCell(
                  runtime,
                  {
                    ...link,
                    space: link.space ?? base.space,
                    scope: link.scope ?? base.scope,
                    path: [],
                  },
                  wtx,
                ).asSchema(
                  {
                    type: "object",
                    additionalProperties: true,
                    ifc,
                  } as Parameters<Cell<unknown>["asSchema"]>[0],
                ).withTx(wtx).set(resultRows[i]);
              }
            }
          });
          // Surface a write-back failure as query `error` rather than leaving the
          // query stuck `pending` (editWithRetry returns the error, not throws).
          if (wrote.error) {
            await failQuery(
              wrote.error.message ?? "sqlite: result write failed",
            );
          }
        } catch (error) {
          await failQuery(errMsg(error));
        }
      },
    });
  };
  return { action };
}

/** Direct structured-result module used by newly compiled graphs. */
export function sqliteQueryResult(
  inputsCell: Cell<any>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: Cell<any>[],
  parentCell: Cell<any>,
  runtime: Runtime,
  outputBinding?: NormalizedFullLink,
): RawBuiltinResult {
  return sqliteQuery(
    inputsCell,
    (tx, state: Cell<QueryState>) => sendResult(tx, state.key("value")),
    addCancel,
    cause,
    parentCell,
    runtime,
    outputBinding,
  );
}
