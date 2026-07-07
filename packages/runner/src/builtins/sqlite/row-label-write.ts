// CFC Phase 3 (3.a-write), pure half: the db.exec gate for rule-bearing
// tables. An attributable INSERT evaluates the rule over its bound values —
// the prospective row label — and verifies NO-LAUNDERING: every labeled input
// must be captured by that label (else confidential data would be stored
// under a weaker label and re-derived reads would under-protect it).
//
// The runner/server split (Phase 3.c): when the CONNECTED SERVER advertises
// commit-time re-derivation (`serverCommitEval` — the
// `sqliteCommitRowLabelEval` handshake capability), the shapes whose ONLY
// problem is that the runner cannot see the committed row — INSERT…SELECT,
// upsert, columnless INSERT, an UPDATE that writes a rule-input column — are
// admitted with UNLABELED inputs and evaluated server-side against the true
// post-image (memory/v2/sqlite/commit-eval.ts, same shared evaluator; a
// violation rolls back the whole commit). NO-LAUNDERING stays here regardless:
// the server sees stored values, never the CFC labels the writer's bound
// inputs carry, so a LABELED input bound to a shape the runner cannot evaluate
// still fails closed — there is no label to check capture against. Against an
// old server (capability absent) everything below fails closed exactly as
// before.
// Spec: docs/specs/sqlite-builtin/06-cfc.md ("Write — the runner gate").
//
// Zero cost when no table declares a rule.

import {
  evaluateRowLabel,
  type RowLabelSpec,
  ruleInputFields,
  validateRowLabelSpec,
} from "@commonfabric/memory/sqlite/row-label";
import { tableDeclaresRowLabel } from "@commonfabric/memory/v2";
import { cfcObservationFitsCeiling } from "../../cfc/observation.ts";
import {
  blankWriteSql,
  parseUpdateSetColumns,
  parseWriteParamColumns,
  parseWriteTable,
} from "@commonfabric/memory/sqlite/write-targets";

/** One written row's computed label — recorded as the write's CFC policy
 *  input (sink-request) before the commit. */
export interface RowLabelWritePolicy {
  table: string;
  label: { confidentiality: unknown[]; integrity: unknown[] };
}

export interface RowLabelWriteArgs {
  sql: string;
  params: ReadonlyArray<unknown> | Record<string, unknown> | undefined;
  /** Declared table schemas (`db.tables`, wire-supplied — re-validated). */
  tables: Record<string, unknown> | undefined;
  /** The db's owner (db ref), resolving the rule's `dbOwner()` term. */
  owner?: string;
  /** The confidentiality atoms carried by a bound value ([] if unlabeled). */
  confidentialityOf: (value: unknown) => readonly unknown[];
  /** True iff the connected server advertised commit-time re-derivation
   *  (Phase 3.c) — the gate then admits the non-attributable shapes with
   *  unlabeled inputs instead of failing closed. Default false. */
  serverCommitEval?: boolean;
}

export type RowLabelWriteResult =
  | { error: string }
  | { policies?: RowLabelWritePolicy[] };

/**
 * Gate a SQL mutation against the target table's per-row label rule.
 * Returns `{error}` (caller rejects the write), or the computed per-row
 * policies for an evaluable INSERT (`policies` undefined when the write
 * carries no rule-relevant rows — rule-less table, UPDATE of non-input
 * columns, DELETE).
 */
export function checkSqliteRowLabelWrite(
  args: RowLabelWriteArgs,
): RowLabelWriteResult {
  const { sql, params, tables, owner, confidentialityOf, serverCommitEval } =
    args;

  // Zero cost for rule-less dbs.
  const hasRules = Object.values(tables ?? {}).some(tableDeclaresRowLabel);
  if (!hasRules) return {};

  const blanked = blankWriteSql(sql);
  const targetName = parseWriteTable(sql, blanked);
  if (targetName === undefined) {
    return {
      error: "sqlite: cannot attribute this write's target table, and the " +
        "db declares row-label rules — fail closed (use a plain " +
        "INSERT/UPDATE/DELETE with an unqualified table name)",
    };
  }

  // Resolve the declared table case-insensitively (SQLite identifiers fold
  // ASCII case; mirrors the Phase 2 ceiling resolution).
  const lcTarget = targetName.toLowerCase();
  const declaredKey = Object.keys(tables ?? {}).find(
    (k) => k.toLowerCase() === lcTarget,
  );
  if (declaredKey === undefined) {
    return {
      error: `sqlite: write targets undeclared table "${targetName}" in a ` +
        "db that declares row-label rules — fail closed (declare the table)",
    };
  }
  const declared = (tables as Record<string, unknown>)[declaredKey];
  if (!tableDeclaresRowLabel(declared)) return {}; // rule-less target table

  const spec = (declared as { rowLabel: RowLabelSpec }).rowLabel;
  const columnNames = Object.keys(
    (declared as { properties?: Record<string, unknown> }).properties ?? {},
  );
  const invalid = validateRowLabelSpec(spec, columnNames);
  if (invalid) {
    return {
      error: `sqlite: table "${declaredKey}" declares an invalid rowLabel ` +
        `rule — ${invalid}`,
    };
  }

  const kw = blanked.match(/^\s*(insert|replace|update|delete)\b/i)?.[1]
    ?.toUpperCase();
  if (kw === undefined) {
    return {
      error: "sqlite: unrecognized write shape on a rule-bearing table — " +
        "fail closed",
    };
  }
  if (kw === "DELETE") return {}; // no values stored

  // Named/object params can't be attributed to columns (Phase 2 precedent);
  // on a rule-bearing table that means the rule can't be evaluated.
  if (params !== undefined && !Array.isArray(params)) {
    return {
      error: `sqlite: named params cannot be attributed to columns of ` +
        `rule-bearing table "${declaredKey}" — use positional ? with an ` +
        "explicit column list",
    };
  }
  const values: readonly unknown[] = params ?? [];

  const inputFields = ruleInputFields(spec);
  const inputSet = new Set(inputFields.map((f) => f.toLowerCase()));

  if (kw === "UPDATE") {
    // Attribute the SET columns from the SQL itself, NOT from the bind
    // params: a literal assignment (`SET col = 'x'`, zero placeholders) must
    // not bypass the rule-input check. Anything the strict parser can't
    // attribute fails closed on a rule-bearing table.
    const setCols = parseUpdateSetColumns(sql, blanked);
    if (setCols === undefined) {
      // Diagnostic only: name a rule input that appears as an assignment LHS
      // so the refusal points at the dangerous column (the statement is
      // rejected either way — this scan never ADMITS anything).
      const touchedInput = [...blanked.matchAll(/([A-Za-z_][\w$]*)\s*=/g)]
        .map((m) => m[1])
        .find((c) => inputSet.has(c.toLowerCase()));
      return {
        error: `sqlite: this UPDATE of rule-bearing table "${declaredKey}" ` +
          "has an unattributable SET clause (literal/expression/subquery " +
          "assignment)" +
          (touchedInput !== undefined
            ? ` and may write rule input column "${touchedInput}"`
            : "") +
          " — fail closed; bind values with positional ? in simple " +
          "`col = ?` form",
      };
    }
    if (!serverCommitEval) {
      // 3.c lift: with commit-time re-derivation the server evaluates the
      // TRUE post-image, so writing a rule-input column is fine — the
      // labeled-value check below still owns no-laundering.
      for (const c of setCols) {
        if (inputSet.has(c.toLowerCase())) {
          return {
            error: `sqlite: UPDATE writes rule input column "${c}" of ` +
              `"${declaredKey}" — the post-image row label cannot be ` +
              "computed runner-side (other inputs unknown), and the server " +
              "did not advertise commit-time evaluation (3.c); fail closed",
          };
        }
      }
    }
    for (const v of values) {
      if (confidentialityOf(v).length > 0) {
        return {
          error: "sqlite: a labeled value bound to rule-bearing table " +
            `"${declaredKey}" outside an evaluable INSERT cannot be ` +
            "verified as captured by the row's label — fail closed",
        };
      }
    }
    return {}; // non-input UPDATE with unlabeled values: label unchanged
  }

  const cols = parseWriteParamColumns(sql, blanked);
  if (cols === undefined) {
    if (!serverCommitEval) {
      return {
        error: `sqlite: this write to rule-bearing table "${declaredKey}" ` +
          "is not attributable (INSERT…SELECT, upsert, columnless INSERT, " +
          "…) — the row label cannot be evaluated runner-side, and the " +
          "server did not advertise commit-time evaluation (3.c); fail closed",
      };
    }
    // 3.c lift: the server re-derives the label from the committed rows and
    // rolls back on violation. No-laundering stays HERE — the server never
    // sees input-value labels — so a labeled bound value still fails closed:
    // the runner cannot compute the row label this shape would store it
    // under, hence cannot verify capture.
    for (const v of values) {
      if (confidentialityOf(v).length > 0) {
        return {
          error: "sqlite: a labeled value bound to rule-bearing table " +
            `"${declaredKey}" outside an evaluable INSERT cannot be ` +
            "verified as captured by the row's label — fail closed",
        };
      }
    }
    return {}; // label derivation deferred to the server commit (3.c)
  }

  // INSERT / REPLACE: group the cycled param→column mapping back into rows.
  // SQLite forbids duplicate names in the column list, so the cycle length is
  // the index of the first repeat of the first column (or the full length).
  let listLen = cols.length;
  for (let i = 1; i < cols.length; i++) {
    if (cols[i] === cols[0]) {
      listLen = i;
      break;
    }
  }
  if (listLen === 0 || values.length % Math.max(listLen, 1) !== 0) {
    if (serverCommitEval && values.length === 0) {
      // Zero-param columnless INSERT (`… DEFAULT VALUES`): nothing is bound,
      // so there is nothing to launder — the server derives the label from
      // the committed default row (3.c).
      return {};
    }
    return {
      error: `sqlite: cannot group the INSERT's params into rows for ` +
        `rule-bearing table "${declaredKey}" — fail closed`,
    };
  }
  const rowCount = values.length / listLen;

  const policies: RowLabelWritePolicy[] = [];
  for (let r = 0; r < rowCount; r++) {
    const rowValues: Record<string, unknown> = {};
    for (const field of inputFields) rowValues[field] = null; // omitted ⟹ NULL
    const rowParams: unknown[] = [];
    for (let j = 0; j < listLen; j++) {
      const col = cols[r * listLen + j];
      const value = values[r * listLen + j];
      rowParams.push(value);
      if (col !== null && inputSet.has(col.toLowerCase())) {
        const field = inputFields.find(
          (f) => f.toLowerCase() === col.toLowerCase(),
        )!;
        rowValues[field] = value;
      }
    }
    const res = evaluateRowLabel(spec, rowValues, { dbOwner: owner });
    if ("error" in res) {
      return {
        error: `sqlite: rowLabel rule rejected the INSERT (row ${r}): ` +
          res.error,
      };
    }
    // No-laundering: every labeled bound value of this row must be captured
    // by the row's computed confidentiality. An EMPTY computed label captures
    // NOTHING — it must not act like an unrestricted ceiling (which is what
    // cfcObservationFitsCeiling's empty-ceiling convention would do): storing
    // a labeled value under a row that re-derives as label-free would launder
    // the label away.
    for (const v of rowParams) {
      const conf = confidentialityOf(v);
      if (conf.length === 0) continue;
      if (res.confidentiality.length === 0) {
        return {
          error: `sqlite: a labeled value is bound to rule-bearing table ` +
            `"${declaredKey}", but the row's computed label is empty — an ` +
            "empty label captures nothing (it is not an unrestricted " +
            "ceiling); storing the value would launder its label; fail closed",
        };
      }
      if (!cfcObservationFitsCeiling(conf, res.confidentiality)) {
        return {
          error: `sqlite: a value bound to rule-bearing table ` +
            `"${declaredKey}" carries confidentiality not captured by the ` +
            "row's computed label — storing it would launder the label; " +
            "fail closed",
        };
      }
    }
    policies.push({
      table: declaredKey,
      label: { confidentiality: res.confidentiality, integrity: res.integrity },
    });
  }
  return { policies };
}
