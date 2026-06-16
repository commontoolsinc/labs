// Pure reference executor for ViewPlan@1.
//
// This is deliberately small and unoptimized. It gives helper authors and future
// runtime/backend implementations an executable semantics check for the closed
// view-plan shapes used by this POC: ordered keyed collections and
// latest-by/count-by aggregates. Production lowerings may use cells, runtime
// indexes, or SQLite, but they should preserve these observable results.

import { encodeKey, type KeyedRecord } from "./keyed-collection-v1.ts";
import {
  applyLatestByCountDeltaToSnapshotV1,
  LATEST_BY_COUNT_DELTA_V1_KIND,
  latestByCountDeltaV1,
  type LatestByCountSnapshotV1,
} from "./latest-by-count-delta-v1.ts";
import {
  validateViewPlanV1,
  type ViewPlanConflictPolicy,
  type ViewPlanStepV1,
  type ViewPlanV1,
} from "./view-plan-v1.ts";

export type ViewPlanRowV1 = Record<string, unknown>;

export interface ViewPlanOrderedValuesV1<Row extends ViewPlanRowV1> {
  view: "orderedValues";
  rows: readonly Row[];
  byKey: KeyedRecord<Row>;
  order: readonly string[];
  count: number;
}

export interface ViewPlanLatestRowsAndCountBucketsV1<
  Row extends ViewPlanRowV1,
> {
  view: "latestRowsAndCountBuckets";
  latestRows: readonly Row[];
  latestByKey: KeyedRecord<Row>;
  countsByGroup: KeyedRecord<{
    total: number;
    choices: Record<string, number>;
  }>;
  count: number;
}

export type ViewPlanReferenceViewV1<Row extends ViewPlanRowV1> =
  | ViewPlanOrderedValuesV1<Row>
  | ViewPlanLatestRowsAndCountBucketsV1<Row>;

export type ViewPlanReferenceExecutionV1<Row extends ViewPlanRowV1> =
  | { ok: true; result: ViewPlanReferenceViewV1<Row> }
  | { ok: false; error: string };

export function executeViewPlanV1<Row extends ViewPlanRowV1>(
  plan: ViewPlanV1,
  rows: readonly Row[],
): ViewPlanReferenceExecutionV1<Row> {
  const validation = validateViewPlanV1(plan);
  if (!validation.ok) return fail(validation.errors.join("; "));

  const materialize = plan.steps.find((step) => step.kind === "materialize");
  if (!materialize?.view) return fail("plan must materialize a named view");

  if (materialize.view === "orderedValues") {
    return executeOrderedValues(plan, rows);
  }
  if (materialize.view === "latestRowsAndCountBuckets") {
    return executeLatestRowsAndCountBuckets(plan, rows, materialize);
  }
  return fail(`unsupported materialized view: ${materialize.view}`);
}

function executeOrderedValues<Row extends ViewPlanRowV1>(
  plan: ViewPlanV1,
  rows: readonly Row[],
): ViewPlanReferenceExecutionV1<Row> {
  const keyBy = findStep(plan, "keyBy");
  const orderBy = findStep(plan, "orderBy");
  const closedShape = requireStepPipeline(plan, [
    "keyBy",
    "orderBy",
    "materialize",
  ], "orderedValues");
  if (closedShape) return closedShape;
  if (!keyBy?.fields?.length) {
    return fail("orderedValues requires keyBy fields");
  }
  if (!isSupportedInsertionOrder(orderBy)) {
    return fail(
      "orderedValues supports only $insertion asc, $key asc ordering",
    );
  }
  const conflict = keyBy.conflict ?? "reject";
  if (conflict !== "reject" && conflict !== "replace-by-key") {
    return fail(`orderedValues does not support ${conflict} conflicts`);
  }

  const byKey: KeyedRecord<Row> = {};
  const order: string[] = [];
  for (const row of rows) {
    const key = keyForFields(row, keyBy.fields, "keyBy");
    if (typeof key !== "string") return key;
    if (Object.hasOwn(byKey, key)) {
      if (conflict === "reject") return fail(`duplicate key: ${key}`);
      byKey[key] = row;
      continue;
    }
    order.push(key);
    byKey[key] = row;
  }

  return {
    ok: true,
    result: {
      view: "orderedValues",
      rows: order.map((key) => byKey[key]).filter(isDefined),
      byKey,
      order,
      count: order.length,
    },
  };
}

function executeLatestRowsAndCountBuckets<Row extends ViewPlanRowV1>(
  plan: ViewPlanV1,
  rows: readonly Row[],
  materialize: ViewPlanStepV1,
): ViewPlanReferenceExecutionV1<Row> {
  const closedShape = requireStepPipeline(plan, [
    "latestBy",
    "groupBy",
    "countBy",
    "materialize",
  ], "latestRowsAndCountBuckets");
  if (closedShape) return closedShape;
  if (materialize.lowering !== LATEST_BY_COUNT_DELTA_V1_KIND) {
    return fail(
      `latestRowsAndCountBuckets requires ${LATEST_BY_COUNT_DELTA_V1_KIND}`,
    );
  }

  const latestBy = findStep(plan, "latestBy");
  const groupBy = findStep(plan, "groupBy");
  const countBy = findStep(plan, "countBy");
  if (!latestBy?.fields?.length) {
    return fail("latestRowsAndCountBuckets requires latestBy fields");
  }
  if (!groupBy?.fields?.length) {
    return fail("latestRowsAndCountBuckets requires groupBy fields");
  }
  if (!countBy?.choiceField) {
    return fail("latestRowsAndCountBuckets requires countBy.choiceField");
  }
  if (!countBy.choices?.length) {
    return fail("latestRowsAndCountBuckets requires countBy.choices");
  }
  if (!sameStrings(groupBy.fields, countBy.groupFields ?? [])) {
    return fail("countBy.groupFields must match groupBy.fields");
  }

  const choices = [...countBy.choices];
  const conflict = latestConflict(latestBy.conflict);
  if (typeof conflict !== "string") return conflict;

  let snapshot: LatestByCountSnapshotV1<Row, string> = {
    latestByKey: {},
    countsByGroup: {},
    count: 0,
  };
  const projections: KeyedRecord<{ group: string; choice: string }> = {};

  for (const row of rows) {
    const latestKey = keyForFields(row, latestBy.fields, "latestBy");
    if (typeof latestKey !== "string") return latestKey;
    const group = keyForFields(row, groupBy.fields, "groupBy");
    if (typeof group !== "string") return group;
    const choice = stringField(row, countBy.choiceField, "countBy.choiceField");
    if (typeof choice !== "string") return choice;
    if (!choices.includes(choice)) {
      return fail(`unsupported choice ${JSON.stringify(choice)}`);
    }

    const previousProjection = projections[latestKey];
    const previousRow = snapshot.latestByKey[latestKey];
    const delta = latestByCountDeltaV1<Row, string>({
      latestKey,
      previous: previousProjection && previousRow !== undefined
        ? {
          row: previousRow,
          group: previousProjection.group,
          choice: previousProjection.choice,
        }
        : undefined,
      next: { row, group, choice },
      choices,
      conflict,
    });
    const nextSnapshot = applyLatestByCountDeltaToSnapshotV1(snapshot, delta);
    snapshot = nextSnapshot;
    if (Object.hasOwn(snapshot.latestByKey, latestKey)) {
      projections[latestKey] = { group, choice };
    } else {
      delete projections[latestKey];
    }
  }

  return {
    ok: true,
    result: {
      view: "latestRowsAndCountBuckets",
      latestRows: Object.values(snapshot.latestByKey),
      latestByKey: snapshot.latestByKey,
      countsByGroup: snapshot.countsByGroup,
      count: snapshot.count,
    },
  };
}

function findStep(plan: ViewPlanV1, kind: ViewPlanStepV1["kind"]):
  | ViewPlanStepV1
  | undefined {
  return plan.steps.find((step) => step.kind === kind);
}

function requireStepPipeline(
  plan: ViewPlanV1,
  expected: readonly ViewPlanStepV1["kind"][],
  view: string,
): { ok: false; error: string } | undefined {
  const actual = plan.steps.map((step) => step.kind);
  if (!sameStrings(actual, expected)) {
    return fail(
      `${view} requires step pipeline ${expected.join(" -> ")}`,
    );
  }
  return undefined;
}

function isSupportedInsertionOrder(step: ViewPlanStepV1 | undefined): boolean {
  if (!step?.order) return false;
  return step.order.length === 2 &&
    step.order[0]?.field === "$insertion" &&
    step.order[0]?.direction === "asc" &&
    step.order[1]?.field === "$key" &&
    step.order[1]?.direction === "asc";
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function latestConflict(
  conflict: ViewPlanConflictPolicy | undefined,
): "replace-by-key" | "toggle-when-same" | { ok: false; error: string } {
  if (conflict === undefined || conflict === "replace-by-key") {
    return "replace-by-key";
  }
  if (conflict === "toggle-when-same") return "toggle-when-same";
  return fail(`latestBy does not support ${conflict} conflicts`);
}

function keyForFields(
  row: ViewPlanRowV1,
  fields: readonly string[],
  label: string,
): string | { ok: false; error: string } {
  const parts: string[] = [];
  for (const field of fields) {
    const value = stringField(row, field, `${label}.${field}`);
    if (typeof value !== "string") return value;
    parts.push(value);
  }
  return encodeKey(...parts);
}

function stringField(
  row: ViewPlanRowV1,
  field: string,
  label: string,
): string | { ok: false; error: string } {
  if (!Object.hasOwn(row, field)) return fail(`missing field: ${label}`);
  const value = row[field];
  if (typeof value !== "string" || value.trim() === "") {
    return fail(`field must be a nonblank string: ${label}`);
  }
  return value.trim();
}

function isDefined<Row>(row: Row | undefined): row is Row {
  return row !== undefined;
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}
