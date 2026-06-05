// CFC write-ceiling check (Phase 2): a value bound to a labeled column must fit
// that column's `ifc.maxConfidentiality`. The label rides the bound value (a Cell
// or any carried-label value — read via `cfcLabelViewForCell` at the call site);
// this module is pure (the reader is injected) so it stays free of cell.ts.
//
// FAIL CLOSED: if a value carries confidentiality but its target column can't be
// determined (a write shape `parseWriteParamColumns` won't attribute), the write
// is rejected rather than let through unverified. Unlabeled values and columns
// without a ceiling are unaffected (zero behavior change until `ifc` is used).

import { cfcObservationFitsCeiling } from "../../cfc/observation.ts";
import { parseWriteParamColumns, parseWriteTable } from "./write-targets.ts";

interface ColumnIfc {
  maxConfidentiality?: readonly unknown[];
}
type Tables = Record<
  string,
  { properties?: Record<string, { ifc?: ColumnIfc }> } | undefined
>;

/** Returns a violation message, or undefined if the write is within ceiling. */
export function checkSqliteWriteCeiling(
  sql: string,
  params: ReadonlyArray<unknown> | Record<string, unknown> | undefined,
  tables: Tables | undefined,
  /** The confidentiality atoms carried by a bound value ([] if unlabeled). */
  confidentialityOf: (value: unknown) => readonly unknown[],
): string | undefined {
  if (!tables || params === undefined) return undefined;
  const table = parseWriteTable(sql);

  const UNRESOLVED =
    "sqlite: a labeled value is bound in a write whose target column cannot be " +
    "determined — use an explicit column list (INSERT INTO t (col) VALUES (?)) " +
    "or a simple UPDATE (SET col = ?) with positional ? params";

  // Resolve a target column name to its declared schema entry. CRITICAL: a
  // resolution MISS (unknown table, column not declared) is NOT the same as "no
  // ceiling" — treating the two alike is the fail-open this module exists to
  // prevent. So `found:false` makes a LABELED value fail closed at the call
  // site. Identifier match is case-insensitive (SQLite folds ASCII identifier
  // case; the declared property keys may differ in case from the SQL).
  const resolveCeiling = (
    col: string,
  ): { found: boolean; ceiling?: readonly unknown[] } => {
    if (table === undefined) return { found: false };
    const props = tables[table]?.properties;
    if (!props) return { found: false };
    const lc = col.toLowerCase();
    const key = Object.keys(props).find((k) => k.toLowerCase() === lc);
    if (key === undefined) return { found: false };
    return { found: true, ceiling: props[key]?.ifc?.maxConfidentiality };
  };

  // Check one labeled value against its (named) target column. Fails closed when
  // the column can't be positively resolved.
  const checkLabeled = (
    conf: readonly unknown[],
    col: string,
  ): string | undefined => {
    const r = resolveCeiling(col);
    if (!r.found) return UNRESOLVED;
    return cfcObservationFitsCeiling(conf, r.ceiling) ? undefined : (
      `sqlite: a value bound to column "${col}" is more confidential than the ` +
      `column allows (exceeds its maxConfidentiality)`
    );
  };

  if (Array.isArray(params)) {
    const cols = parseWriteParamColumns(sql);
    for (let i = 0; i < params.length; i++) {
      const conf = confidentialityOf(params[i]);
      if (conf.length === 0) continue; // unlabeled → nothing to check
      if (cols === undefined) return UNRESOLVED; // unattributable shape
      const col = cols[i];
      if (col === null) continue; // a filter param (WHERE), not stored
      const v = checkLabeled(conf, col);
      if (v) return v;
    }
    return undefined;
  }

  // Named/object params: the bind key is the placeholder name. Strip a leading
  // sigil (`:name` / `@name` / `$name`) and resolve it as a column. A labeled
  // value whose key doesn't resolve to a declared column fails closed (we won't
  // trust an unmappable key not to be storing above a ceiling).
  for (const [rawKey, value] of Object.entries(params)) {
    const conf = confidentialityOf(value);
    if (conf.length === 0) continue;
    const v = checkLabeled(conf, rawKey.replace(/^[:@$]/, ""));
    if (v) return v;
  }
  return undefined;
}
