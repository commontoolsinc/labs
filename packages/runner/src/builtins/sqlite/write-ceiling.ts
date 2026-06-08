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
import {
  blankWriteSql,
  parseWriteParamColumns,
  parseWriteTable,
} from "./write-targets.ts";

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
  // Blank string-literals/comments once; both parsers read the same SQL.
  const blanked = blankWriteSql(sql);
  const table = parseWriteTable(sql, blanked);

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
    const cols = parseWriteParamColumns(sql, blanked);
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

  // Named/object params: a placeholder name is NOT reliably the target column
  // (it's an arbitrary bind name, and without parsing we can't tell a stored
  // SET/INSERT value from a WHERE filter). So a LABELED value bound via named
  // params fails closed — checking the key as a column would either miss the
  // real ceiling (bypass) or reject a filter that isn't stored (false reject).
  // Use positional `?` with an explicit column list for a CFC-checked write.
  // Unlabeled named writes are unaffected.
  for (const value of Object.values(params)) {
    if (confidentialityOf(value).length > 0) {
      return "sqlite: a labeled value is bound via named/object params, whose " +
        "target column cannot be determined — use positional ? params with an " +
        "explicit column list (INSERT INTO t (col) VALUES (?)) or a simple " +
        "UPDATE (SET col = ?)";
    }
  }
  return undefined;
}
