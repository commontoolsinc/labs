// Engine-side SQLite execution: guarded query/write and additive DDL.
// Runs server-side (this package owns the @db/sqlite Database). Statement safety
// is enforced by the tokenizer-level guard; `_cf_link` encode/decode happens on
// the client (runner) before/after these calls.

import { type BindValue, Database } from "@db/sqlite";
import { assertReadOnly, assertWriteSafe } from "./guard.ts";
import { createTableSQL, type TableSchema } from "./schema.ts";

export type SqliteParams = readonly unknown[] | Record<string, unknown>;

export interface WriteResult {
  changes: number;
  lastInsertRowid: number;
}

// @db/sqlite binds positional values as a rest list and named values as a single
// record argument. Our values are already SQLite scalars (cf_link params are
// pre-encoded to strings by the client), so the cast to BindValue is safe.
function bindArgs(params?: SqliteParams): BindValue[] {
  if (params === undefined) return [];
  return (Array.isArray(params) ? [...params] : [params]) as BindValue[];
}

/** Run a single guarded read-only SELECT and return all rows. */
export function runQuery<Row = Record<string, unknown>>(
  db: Database,
  sql: string,
  params?: SqliteParams,
): Row[] {
  assertReadOnly(sql);
  return db.prepare(sql).all(...bindArgs(params)) as Row[];
}

/** Run a single guarded INSERT/UPDATE/DELETE. */
export function runWrite(
  db: Database,
  sql: string,
  params?: SqliteParams,
): WriteResult {
  assertWriteSafe(sql);
  const changes = db.prepare(sql).run(...bindArgs(params));
  return { changes, lastInsertRowid: db.lastInsertRowId };
}

/**
 * Additive table reconciliation (Phase 2 V1): create missing tables. Destructive
 * or ambiguous changes to existing tables are out of scope and intentionally not
 * applied here; a future migration step handles them (refuse-by-default + opt-in
 * callback — see spec 08-open-questions Q9).
 */
export function ensureTables(
  db: Database,
  tables: Record<string, TableSchema>,
): void {
  for (const [name, schema] of Object.entries(tables)) {
    db.exec(createTableSQL(name, schema));
  }
}
