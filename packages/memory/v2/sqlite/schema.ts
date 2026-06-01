// table() / cfLink() schema helpers + additive DDL generation
// (spec docs/specs/sqlite-builtin/01, and Phase 2 create-only migration).
//
// `table(columns)` builds a JSON Schema for one row. Each column carries a
// non-standard `sqlType` annotation used to generate `CREATE TABLE` DDL, and
// `_cf_link` columns carry `cfLink: true` to drive encode/decode (Section 02).
// These helpers compile to plain data; the transformer/runtime do not special-
// case them.

import { CF_LINK_SUFFIX, isCfLinkColumn } from "./columns.ts";

export interface ColumnSchema {
  type: string;
  /** Verbatim SQLite column type/constraints for DDL, e.g. "integer primary key". */
  sqlType: string;
  /** Marks a `_cf_link` column (stored TEXT, surfaced as a Cell). */
  cfLink?: true;
  [key: string]: unknown;
}

export interface TableSchema {
  type: "object";
  properties: Record<string, ColumnSchema>;
  required: string[];
  [key: string]: unknown;
}

/** Column spec: a shorthand SQL type string, or an explicit column schema. */
export type ColumnSpec = string | ColumnSchema;

/** A `_cf_link` column: TEXT in SQLite, a Cell<T> in TypeScript. */
export function cfLink<_T = unknown>(): ColumnSchema {
  return { type: "string", cfLink: true, sqlType: "text" };
}

// Map the leading SQL type word to a JSON Schema `type`.
function jsonTypeForSql(sqlType: string): string {
  const head = sqlType.trim().toLowerCase().split(/\s+/)[0] ?? "";
  switch (head) {
    case "integer":
    case "int":
      return "integer";
    case "real":
    case "float":
    case "double":
    case "numeric":
    case "decimal":
      return "number";
    case "text":
    case "blob":
    case "":
      return "string";
    default:
      return "string";
  }
}

function normalizeColumn(name: string, spec: ColumnSpec): ColumnSchema {
  const col: ColumnSchema = typeof spec === "string"
    ? { type: jsonTypeForSql(spec), sqlType: spec }
    : { ...spec, sqlType: spec.sqlType ?? "text" };

  // Validate identifiers and the verbatim sqlType so a hostile/buggy table
  // declaration can't smuggle DDL (e.g. `text); DROP TABLE x;--`) through
  // createTableSQL's interpolation. Column names are quoted at emit time; sqlType
  // is constrained to type keywords, constraints, numbers, parens and commas.
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    throw new TypeError(`invalid column name "${name}"`);
  }
  if (!/^[A-Za-z0-9_ (),'-]*$/.test(col.sqlType)) {
    throw new TypeError(
      `invalid sqlType for column "${name}": ${col.sqlType}`,
    );
  }

  const looksLink = col.cfLink === true;
  const namedLink = isCfLinkColumn(name);

  // A cfLink column must be named `*_cf_link`.
  if (looksLink && !namedLink) {
    throw new TypeError(
      `cfLink column "${name}" must end in "${CF_LINK_SUFFIX}"`,
    );
  }
  // A `*_cf_link` column must be a single string/TEXT field.
  if (namedLink) {
    const sqlHead = col.sqlType.trim().toLowerCase().split(/\s+/)[0];
    if (col.type !== "string" || (sqlHead !== "text" && sqlHead !== "")) {
      throw new TypeError(
        `_cf_link column "${name}" must be a string/TEXT field`,
      );
    }
    col.cfLink = true;
  }
  return col;
}

/** Build a one-row JSON Schema from a column map. */
export function table(columns: Record<string, ColumnSpec>): TableSchema {
  const properties: Record<string, ColumnSchema> = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(columns)) {
    properties[name] = normalizeColumn(name, spec);
    required.push(name);
  }
  return { type: "object", properties, required };
}

/** Names of the `_cf_link` columns in a table schema. */
export function linkColumnsOf(t: TableSchema): string[] {
  return Object.entries(t.properties)
    .filter(([name, col]) => col.cfLink === true || isCfLinkColumn(name))
    .map(([name]) => name);
}

const quoteIdent = (id: string) => `"${id.replace(/"/g, '""')}"`;

/** Additive DDL for a table (Phase 2: create-only). Column names are quoted and
 *  sqlType is validated by `table()` (see normalizeColumn). */
export function createTableSQL(name: string, t: TableSchema): string {
  const cols = Object.entries(t.properties).map(
    ([col, schema]) => `  ${quoteIdent(col)} ${schema.sqlType}`,
  );
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(name)} (\n${
    cols.join(",\n")
  }\n)`;
}
