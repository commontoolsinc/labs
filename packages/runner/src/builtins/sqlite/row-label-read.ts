// CFC Phase 3 (3.a-read), pure half: per-row label computation for a query
// result, plus the declared output ceiling with onExceed fail|skip. The
// sqliteQuery flush (sqlite-builtins.ts) feeds this real results; everything
// here is side-effect free and fail-closed — any unresolvable input refuses
// the query rather than under-labeling.
// Spec: docs/specs/sqlite-builtin/06-cfc.md ("Read — re-derive per row,
// attach, ceiling"; "Fail-closed rules").

import {
  evaluateRowLabel,
  type RowLabelSpec,
  ruleCommonAlternatives,
  ruleInputFields,
  validateRowLabelSpec,
} from "@commonfabric/memory/sqlite/row-label";
import { tableDeclaresRowLabel } from "@commonfabric/memory/v2";
import { cfcObservationFitsCeiling } from "../../cfc/observation.ts";

interface ResultColumn {
  output: string;
  table: string | null;
  column: string | null;
}

/** A row's per-row label, shaped as a schema `ifc` for the row-doc write. */
export interface PerRowIfc {
  confidentiality?: unknown[];
  integrity?: unknown[];
}

export interface RowLabelReadArgs {
  /** Declared table schemas (`db.tables`, wire-supplied — re-validated). */
  tables: Record<string, unknown> | undefined;
  /** Per-result-column TRUE origins (`res.columns`); undefined when the
   *  server captured none. */
  columns: readonly ResultColumn[] | undefined;
  rows: readonly unknown[];
  /** The db's owner (db ref), resolving the rule's `dbOwner()` term. */
  owner?: string;
  /** Per-column (Phase 2) confidentiality atoms of the labeled projection —
   *  they ride every row, so they count against the ceiling too. */
  staticConfidentiality?: readonly unknown[];
  /** Declared output ceiling (placeholders already resolved). */
  ceiling?: readonly unknown[];
  /** What to do when a row's label exceeds the ceiling (default "fail"). */
  onExceed?: unknown;
}

export type RowLabelReadResult =
  | { error: string }
  | {
    /** Per kept-order row: the per-row label for its row entity doc, or
     *  undefined when the row carries no per-row label. */
    labels: (PerRowIfc | undefined)[];
    /** Row keep-mask under a declared ceiling (undefined: no ceiling). */
    keep: boolean[] | undefined;
  };

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const commonAltKey = (a: unknown): string =>
  typeof a === "string" ? `s:${a}` : `j:${JSON.stringify(a)}`;

// The atoms that are a common alternative of EVERY rule-bearing table — the
// intersection of each rule's `ruleCommonAlternatives`. A reader in this set is
// a guaranteed reader of every row of every such table, so it soundly reads an
// aggregate no matter which of them it ranged over (Epic E2).
function intersectCommonAlternatives(
  rules: readonly { spec: RowLabelSpec }[],
  owner: string | undefined,
): unknown[] {
  let acc: Map<string, unknown> | undefined;
  for (const r of rules) {
    const alts = new Map<string, unknown>();
    for (const a of ruleCommonAlternatives(r.spec, { dbOwner: owner })) {
      alts.set(commonAltKey(a), a);
    }
    acc = acc === undefined
      ? alts
      : new Map([...acc].filter(([k]) => alts.has(k)));
    if (acc.size === 0) return [];
  }
  return acc === undefined ? [] : [...acc.values()];
}

/**
 * Compute each result row's per-row label from the declared rules and the
 * projection's TRUE column origins, then apply the declared output ceiling.
 * Fail-closed refusals (spec "Fail-closed rules"): invalid wire spec; missing provenance;
 * any null-origin (aggregate/expression) column while a row rule is declared;
 * a rule input column missing from or ambiguous in the projection; an
 * evaluator error on any row; a ceiling miss under onExceed:"fail"; skip on a
 * projection with a null-origin column (a contribution can't be un-counted).
 */
export function computeRowLabelRead(
  args: RowLabelReadArgs,
): RowLabelReadResult {
  const { tables, columns, rows, owner, ceiling } = args;

  if (
    args.onExceed !== undefined && args.onExceed !== "fail" &&
    args.onExceed !== "skip"
  ) {
    return {
      error: `sqlite: invalid onExceed ${
        JSON.stringify(args.onExceed)
      } — expected "fail" or "skip"`,
    };
  }
  const onExceed = (args.onExceed ?? "fail") as "fail" | "skip";

  // Discover + re-validate rule-bearing tables (db.tables is wire-supplied;
  // "couldn't validate" is never "no label").
  const rules: { name: string; spec: RowLabelSpec }[] = [];
  for (const [name, t] of Object.entries(tables ?? {})) {
    if (!tableDeclaresRowLabel(t)) continue;
    const spec = (t as { rowLabel: RowLabelSpec }).rowLabel;
    const columnNames = Object.keys(
      (t as { properties?: Record<string, unknown> }).properties ?? {},
    );
    const reason = validateRowLabelSpec(spec, columnNames);
    if (reason) {
      return {
        error: `sqlite: table "${name}" declares an invalid rowLabel rule — ` +
          reason,
      };
    }
    rules.push({ name, spec });
  }

  const nullOrigin =
    columns?.some((c) => c.table === null || c.column === null) ?? false;

  let labels: (PerRowIfc | undefined)[] = rows.map(() => undefined);

  if (rules.length > 0) {
    if (columns === undefined) {
      return {
        error: "sqlite: a row-rule-bearing db needs column provenance for " +
          "the read, but the result carries none — refusing (fail closed)",
      };
    }
    if (nullOrigin) {
      // Epic E2 (common-alternative property, CFC spec §8.17.4): an
      // aggregate/expression column has no single source, so its per-row
      // contributors cannot be attributed. But a reader that is a COMMON
      // ALTERNATIVE of every rule-bearing table — a static, unconditional
      // reader of every row of every such table (e.g. an unconditional
      // `dbOwner()` alternative) — satisfies the join of all those rows, so it
      // soundly reads the aggregate with NO declassification. Intersect the
      // common alternatives across all rule-bearing tables; if non-empty,
      // label the aggregate rows by that set (an OR-clause) and let the
      // declared output ceiling decide. Otherwise there is no guaranteed
      // reader and we still refuse.
      const common = intersectCommonAlternatives(rules, owner);
      if (common.length === 0) {
        return {
          error: "sqlite: an aggregate/expression column has no single " +
            "source and the rule has no common reader — its per-row " +
            "contributors cannot be re-labeled on a row-rule-bearing db; " +
            "refusing (fail closed). Query the rows directly, add an " +
            "unconditional reader (e.g. dbOwner()) the aggregate can be read " +
            "by, or move the aggregate to a rule-less table",
        };
      }
      const clause = common.length === 1 ? common[0] : { anyOf: common };
      labels = rows.map(() => ({ confidentiality: [clause] }));
      // No per-row eval (no origins to attribute); fall through to the
      // shared ceiling check below.
    } else {
      const applicable = rules.filter((r) =>
        columns.some((c) => c.table === r.name)
      );
      if (applicable.length > 1) {
        return {
          error: "sqlite: a query may touch at most one rule-bearing table " +
            `(found ${
              applicable.map((r) => `"${r.name}"`).join(", ")
            }) — cross-rule joins are deferred; refusing (fail closed)`,
        };
      }
      if (applicable.length === 1) {
        const { name, spec } = applicable[0];
        // Locate every rule input by TRUE origin — never by output name.
        const inputOutputs = new Map<string, string>();
        for (const field of ruleInputFields(spec)) {
          const hits = columns.filter((c) =>
            c.table === name && c.column === field
          );
          if (hits.length === 0) {
            return {
              error: `sqlite: the rowLabel rule needs column "${field}" of ` +
                `table "${name}", but the projection does not include it (by ` +
                "true origin) — refusing (fail closed); add it to the SELECT",
            };
          }
          if (hits.length > 1) {
            return {
              error: `sqlite: rule input "${name}.${field}" is ambiguous — ` +
                `${hits.length} result columns share that origin; alias all ` +
                "but one away or drop the duplicates",
            };
          }
          inputOutputs.set(field, hits[0].output);
        }
        labels = [];
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          if (!isRecord(row)) {
            return { error: `sqlite: result row ${i} is not an object` };
          }
          const rowValues: Record<string, unknown> = {};
          for (const [field, output] of inputOutputs) {
            rowValues[field] = row[output];
          }
          const res = evaluateRowLabel(spec, rowValues, { dbOwner: owner });
          if ("error" in res) {
            return {
              error: `sqlite: rowLabel rule failed on row ${i}: ${res.error}`,
            };
          }
          const ifc: PerRowIfc = {};
          if (res.confidentiality.length > 0) {
            ifc.confidentiality = res.confidentiality;
          }
          if (res.integrity.length > 0) ifc.integrity = res.integrity;
          labels.push(
            ifc.confidentiality || ifc.integrity ? ifc : undefined,
          );
        }
      }
    }
  }

  // Declared output ceiling — the consumer's contract on what the result may
  // carry. Applies to per-row AND static per-column confidentiality; not
  // reader-clearance (none exists), a declared contract (06-cfc.md ceiling).
  let keep: boolean[] | undefined;
  if (ceiling !== undefined) {
    if (onExceed === "skip" && nullOrigin) {
      return {
        error: 'sqlite: onExceed:"skip" never applies to an aggregate/' +
          "expression projection — withheld rows already contributed " +
          'server-side and cannot be un-counted; use "fail"',
      };
    }
    const staticConf = args.staticConfidentiality ?? [];
    keep = [];
    for (let i = 0; i < rows.length; i++) {
      const effective = [
        ...(labels[i]?.confidentiality ?? []),
        ...staticConf,
      ];
      const fits = cfcObservationFitsCeiling(effective, ceiling);
      if (!fits && onExceed === "fail") {
        return {
          error: `sqlite: row ${i}'s label exceeds the declared output ` +
            "ceiling (maxConfidentiality) — refusing (fail closed); narrow " +
            'the query, widen the ceiling, or opt into onExceed:"skip"',
        };
      }
      keep.push(fits);
    }
  }

  return { labels, keep };
}

/**
 * Resolve placeholder principals in a declared ceiling: the acting user
 * (`{__ctCurrentPrincipal:true}`, prepare-time identity) and the db owner
 * (`{__ctDbOwner:true}`, from the db ref). Unresolvable placeholders fail
 * closed — a ceiling that can't be pinned must not silently widen.
 */
export function resolveCeilingPlaceholders(
  ceiling: readonly unknown[],
  ctx: { actingPrincipal?: string; owner?: string },
): { atoms: unknown[] } | { error: string } {
  const atoms: unknown[] = [];
  for (const atom of ceiling) {
    if (isRecord(atom) && atom.__ctCurrentPrincipal === true) {
      if (ctx.actingPrincipal === undefined) {
        return {
          error: "sqlite: ceiling references the acting user but no acting " +
            "principal is available — refusing (fail closed)",
        };
      }
      atoms.push(ctx.actingPrincipal);
      continue;
    }
    if (isRecord(atom) && atom.__ctDbOwner === true) {
      if (ctx.owner === undefined) {
        return {
          error: "sqlite: ceiling references the db owner but the db ref " +
            "carries no owner — refusing (fail closed)",
        };
      }
      atoms.push(ctx.owner);
      continue;
    }
    atoms.push(atom);
  }
  return { atoms };
}
