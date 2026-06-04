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

  const ceilingFor = (col: string | null): readonly unknown[] | undefined => {
    if (col === null || table === undefined) return undefined;
    return tables[table]?.properties?.[col]?.ifc?.maxConfidentiality;
  };
  const exceeds = (
    conf: readonly unknown[],
    col: string,
  ): string | undefined =>
    cfcObservationFitsCeiling(conf, ceilingFor(col)) ? undefined : (
      `sqlite: a value bound to column "${col}" is more confidential than the ` +
      `column allows (exceeds its maxConfidentiality)`
    );

  if (Array.isArray(params)) {
    const cols = parseWriteParamColumns(sql);
    for (let i = 0; i < params.length; i++) {
      const conf = confidentialityOf(params[i]);
      if (conf.length === 0) continue; // unlabeled → nothing to check
      if (cols === undefined) {
        return (
          "sqlite: a labeled value is bound in a write whose target column " +
          "cannot be determined — use an explicit column list " +
          "(INSERT INTO t (col) VALUES (?)) or a simple UPDATE (SET col = ?)"
        );
      }
      const col = cols[i];
      if (col === null) continue; // a filter param (WHERE), not stored
      const v = exceeds(conf, col);
      if (v) return v;
    }
    return undefined;
  }

  // Named params: the key is the column name.
  for (const [col, value] of Object.entries(params)) {
    const conf = confidentialityOf(value);
    if (conf.length === 0) continue;
    const v = exceeds(conf, col);
    if (v) return v;
  }
  return undefined;
}
