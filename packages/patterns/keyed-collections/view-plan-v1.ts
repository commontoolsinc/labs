import { LATEST_BY_COUNT_DELTA_V1_KIND } from "./latest-by-count-delta-v1.ts";

export const VIEW_PLAN_V1_VERSION = "commonfabric.view-plan@1";

export type ViewPlanV1Version = typeof VIEW_PLAN_V1_VERSION;

export type ViewPlanSourceShape =
  | "array"
  | "keyed-record"
  | "ordered-keyed-record"
  | "latest-record"
  | "event-log";

export type ViewPlanStepKind =
  | "keyBy"
  | "orderBy"
  | "latestBy"
  | "groupBy"
  | "countBy"
  | "materialize";

export type ViewPlanConflictPolicy =
  | "reject"
  | "replace-by-key"
  | "toggle-when-same"
  | "commutative-delta";

export type ViewPlanExecutionTier =
  | "cell-fallback"
  | "runtime-maintained"
  | "sqlite-pushdown";

export type ViewPlanFallbackMode = "cell-helper" | "computed-snapshot";

export interface ViewPlanSourceV1 {
  name: string;
  shape: ViewPlanSourceShape;
  item: string;
  cells?: readonly string[];
}

export interface ViewPlanOrderingV1 {
  field: string;
  direction: "asc" | "desc";
}

export interface ViewPlanStepV1 {
  kind: ViewPlanStepKind;
  name?: string;
  fields?: readonly string[];
  field?: string;
  groupFields?: readonly string[];
  choiceField?: string;
  choices?: readonly string[];
  order?: readonly ViewPlanOrderingV1[];
  conflict?: ViewPlanConflictPolicy;
  removeWhenSame?: boolean;
  view?: string;
  outputs?: readonly string[];
  lowering?: string;
}

export interface ViewPlanFallbackV1 {
  mode: ViewPlanFallbackMode;
  helper: string;
}

export interface ViewPlanV1 {
  version: ViewPlanV1Version;
  name: string;
  source: ViewPlanSourceV1;
  steps: readonly ViewPlanStepV1[];
  fallback: ViewPlanFallbackV1;
  eligibleExecution: readonly ViewPlanExecutionTier[];
  notes: readonly string[];
}

export interface ViewPlanValidationV1 {
  ok: boolean;
  errors: readonly string[];
  warnings: readonly string[];
}

export interface ViewPlanOptionsV1 {
  name: string;
  source: ViewPlanSourceV1;
  steps: readonly ViewPlanStepV1[];
  fallback: ViewPlanFallbackV1;
  eligibleExecution?: readonly ViewPlanExecutionTier[];
  notes?: readonly string[];
}

export interface OrderedCollectionViewPlanOptionsV1 {
  name: string;
  source: string;
  item: string;
  key: string | readonly string[];
  cells: readonly string[];
  outputs: readonly string[];
  conflict?: ViewPlanConflictPolicy;
  notes?: readonly string[];
}

export interface LatestByCountViewPlanOptionsV1 {
  name: string;
  source: string;
  item: string;
  latestKey: string | readonly string[];
  groupBy: string | readonly string[];
  choice: string;
  choices: readonly string[];
  cells: readonly string[];
  outputs: readonly string[];
  removeWhenSame?: boolean;
  notes?: readonly string[];
}

export function viewPlanV1(options: ViewPlanOptionsV1): ViewPlanV1 {
  return {
    version: VIEW_PLAN_V1_VERSION,
    name: options.name,
    source: cloneSource(options.source),
    steps: options.steps.map(cloneStep),
    fallback: { ...options.fallback },
    eligibleExecution: options.eligibleExecution
      ? [...options.eligibleExecution]
      : ["cell-fallback"],
    notes: options.notes ? [...options.notes] : [],
  };
}

export function orderedCollectionViewPlanV1(
  options: OrderedCollectionViewPlanOptionsV1,
): ViewPlanV1 {
  const keyFields = normalizeFields(options.key);
  return viewPlanV1({
    name: options.name,
    source: {
      name: options.source,
      shape: "ordered-keyed-record",
      item: options.item,
      cells: [...options.cells],
    },
    steps: [
      {
        kind: "keyBy",
        name: "stable encoded storage key",
        fields: keyFields,
        conflict: options.conflict ?? "reject",
      },
      {
        kind: "orderBy",
        name: "stable insertion order",
        order: [
          { field: "$insertion", direction: "asc" },
          { field: "$key", direction: "asc" },
        ],
      },
      {
        kind: "materialize",
        view: "orderedValues",
        outputs: [...options.outputs],
      },
    ],
    fallback: {
      mode: "cell-helper",
      helper:
        "replaceOrderedFromArray/upsertOrdered/removeOrdered/orderedValues",
    },
    eligibleExecution: [
      "cell-fallback",
      "runtime-maintained",
      "sqlite-pushdown",
    ],
    notes: options.notes,
  });
}

export function latestByCountViewPlanV1(
  options: LatestByCountViewPlanOptionsV1,
): ViewPlanV1 {
  const groupFields = normalizeFields(options.groupBy);
  return viewPlanV1({
    name: options.name,
    source: {
      name: options.source,
      shape: "latest-record",
      item: options.item,
      cells: [...options.cells],
    },
    steps: [
      {
        kind: "latestBy",
        name: "one latest item per key",
        fields: normalizeFields(options.latestKey),
        conflict: options.removeWhenSame === true
          ? "toggle-when-same"
          : "replace-by-key",
        removeWhenSame: options.removeWhenSame === true,
      },
      {
        kind: "groupBy",
        name: "aggregate group",
        fields: groupFields,
      },
      {
        kind: "countBy",
        name: "choice bucket count",
        groupFields,
        choiceField: options.choice,
        choices: [...options.choices],
        conflict: "commutative-delta",
      },
      {
        kind: "materialize",
        view: "latestRowsAndCountBuckets",
        outputs: [...options.outputs],
        lowering: LATEST_BY_COUNT_DELTA_V1_KIND,
      },
    ],
    fallback: {
      mode: "cell-helper",
      helper: "applyLatestByCount/removeLatestByCount/countSnapshot",
    },
    eligibleExecution: [
      "cell-fallback",
      "runtime-maintained",
      "sqlite-pushdown",
    ],
    notes: options.notes,
  });
}

const SOURCE_SHAPES: readonly ViewPlanSourceShape[] = [
  "array",
  "keyed-record",
  "ordered-keyed-record",
  "latest-record",
  "event-log",
];
const STEP_KINDS: readonly ViewPlanStepKind[] = [
  "keyBy",
  "orderBy",
  "latestBy",
  "groupBy",
  "countBy",
  "materialize",
];
const CONFLICT_POLICIES: readonly ViewPlanConflictPolicy[] = [
  "reject",
  "replace-by-key",
  "toggle-when-same",
  "commutative-delta",
];
const EXECUTION_TIERS: readonly ViewPlanExecutionTier[] = [
  "cell-fallback",
  "runtime-maintained",
  "sqlite-pushdown",
];
const FALLBACK_MODES: readonly ViewPlanFallbackMode[] = [
  "cell-helper",
  "computed-snapshot",
];

export function validateViewPlanV1(plan: unknown): ViewPlanValidationV1 {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isRecord(plan)) {
    return {
      ok: false,
      errors: ["plan must be an object"],
      warnings,
    };
  }

  const source = plan.source;
  const fallback = plan.fallback;
  const steps = plan.steps;
  const eligibleExecution = plan.eligibleExecution;

  if (plan.version !== VIEW_PLAN_V1_VERSION) {
    errors.push(`unsupported version: ${stringFor(plan.version)}`);
  }

  if (!isNonBlankString(plan.name)) errors.push("plan.name is required");

  if (!isRecord(source)) {
    errors.push("plan.source must be an object");
  } else {
    if (!isNonBlankString(source.name)) {
      errors.push("plan.source.name is required");
    }
    if (!isAllowedString(source.shape, SOURCE_SHAPES)) {
      errors.push(`unsupported source.shape: ${stringFor(source.shape)}`);
    }
    if (!isNonBlankString(source.item)) {
      errors.push("plan.source.item is required");
    }
    validateOptionalStringArray(source.cells, "plan.source.cells", errors);
  }

  if (!Array.isArray(steps)) {
    errors.push("plan.steps must be an array");
  } else if (steps.length === 0) {
    errors.push("plan.steps must not be empty");
  } else {
    for (const step of steps) validateStep(step, errors, warnings);
  }

  if (!isRecord(fallback)) {
    errors.push("plan.fallback must be an object");
  } else {
    if (!isAllowedString(fallback.mode, FALLBACK_MODES)) {
      errors.push(`unsupported fallback.mode: ${stringFor(fallback.mode)}`);
    }
    if (!isNonBlankString(fallback.helper)) {
      errors.push("plan.fallback.helper is required");
    }
  }

  if (!Array.isArray(eligibleExecution)) {
    errors.push("plan.eligibleExecution must be an array");
  } else {
    for (const tier of eligibleExecution) {
      if (!isAllowedString(tier, EXECUTION_TIERS)) {
        errors.push(`unsupported eligibleExecution tier: ${stringFor(tier)}`);
      }
    }
  }

  validateOptionalStringArray(plan.notes, "plan.notes", errors);

  if (
    Array.isArray(eligibleExecution) &&
    !eligibleExecution.includes("cell-fallback")
  ) {
    warnings.push(
      "plan cannot fall back to today's cell helper implementation",
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function explainViewPlanV1(plan: ViewPlanV1): string[] {
  const validation = validateViewPlanV1(plan);
  const lines = [
    `${plan.name} (${plan.version})`,
    `source: ${plan.source.name} as ${plan.source.shape}<${plan.source.item}>`,
    `fallback: ${plan.fallback.mode} via ${plan.fallback.helper}`,
    `eligible: ${plan.eligibleExecution.join(", ")}`,
  ];
  for (const step of plan.steps) lines.push(explainStep(step));
  for (const warning of validation.warnings) lines.push(`warning: ${warning}`);
  for (const error of validation.errors) lines.push(`error: ${error}`);
  return lines;
}

function normalizeFields(
  fields: string | readonly string[],
): readonly string[] {
  const rawFields = typeof fields === "string" ? [fields] : [...fields];
  return rawFields.map((field) => field.trim()).filter((field) => field !== "");
}

function cloneSource(source: ViewPlanSourceV1): ViewPlanSourceV1 {
  return {
    ...source,
    cells: source.cells ? [...source.cells] : undefined,
  };
}

function cloneStep(step: ViewPlanStepV1): ViewPlanStepV1 {
  return {
    ...step,
    fields: step.fields ? [...step.fields] : undefined,
    groupFields: step.groupFields ? [...step.groupFields] : undefined,
    choices: step.choices ? [...step.choices] : undefined,
    order: step.order ? step.order.map((entry) => ({ ...entry })) : undefined,
    outputs: step.outputs ? [...step.outputs] : undefined,
    lowering: step.lowering,
  };
}

function validateStep(
  step: unknown,
  errors: string[],
  warnings: string[],
): void {
  if (!isRecord(step)) {
    errors.push("plan.steps entries must be objects");
    return;
  }
  if (!isAllowedString(step.kind, STEP_KINDS)) {
    errors.push(`unsupported step.kind: ${stringFor(step.kind)}`);
    return;
  }
  validateOptionalStringArray(step.fields, `${step.kind}.fields`, errors);
  validateOptionalStringArray(
    step.groupFields,
    `${step.kind}.groupFields`,
    errors,
  );
  validateOptionalStringArray(step.choices, `${step.kind}.choices`, errors);
  validateOptionalStringArray(step.outputs, `${step.kind}.outputs`, errors);
  if (
    step.conflict !== undefined &&
    !isAllowedString(step.conflict, CONFLICT_POLICIES)
  ) {
    errors.push(
      `unsupported ${step.kind}.conflict: ${stringFor(step.conflict)}`,
    );
  }

  if (step.kind === "keyBy" || step.kind === "latestBy") {
    requireFields(step, errors);
  }
  if (step.kind === "groupBy") requireFields(step, errors);
  if (
    step.kind === "orderBy" &&
    (!Array.isArray(step.order) || step.order.length === 0)
  ) {
    errors.push("orderBy step requires order entries");
  } else if (step.kind === "orderBy") {
    validateOrder(step.order, errors);
  }
  if (step.kind === "countBy") {
    if (!hasNonEmptyStringArray(step.groupFields)) {
      errors.push("countBy step requires groupFields");
    }
    if (step.choiceField !== undefined && !isNonBlankString(step.choiceField)) {
      errors.push("countBy choiceField must be nonblank when present");
    }
    if (step.choiceField === undefined) {
      warnings.push("countBy without choiceField behaves like a total count");
    }
  }
  if (step.kind === "materialize") {
    if (!isNonBlankString(step.view)) {
      errors.push("materialize step requires view");
    }
    if (!hasNonEmptyStringArray(step.outputs)) {
      errors.push("materialize step requires outputs");
    }
  }
}

function requireFields(step: Record<string, unknown>, errors: string[]): void {
  if (!hasNonEmptyStringArray(step.fields)) {
    errors.push(`${stringFor(step.kind)} step requires fields`);
  }
}

function validateOrder(order: unknown, errors: string[]): void {
  if (!Array.isArray(order)) {
    errors.push("orderBy order must be an array");
    return;
  }
  for (const entry of order) {
    if (!isRecord(entry)) {
      errors.push("orderBy order entries must be objects");
      continue;
    }
    if (!isNonBlankString(entry.field)) {
      errors.push("orderBy order.field is required");
    }
    if (entry.direction !== "asc" && entry.direction !== "desc") {
      errors.push(`unsupported order.direction: ${stringFor(entry.direction)}`);
    }
  }
}

function explainStep(step: ViewPlanStepV1): string {
  if (step.kind === "orderBy") {
    const order = step.order?.map((entry) =>
      `${entry.field} ${entry.direction}`
    )
      .join(", ") ?? "<none>";
    return `step: orderBy ${order}`;
  }
  if (step.kind === "countBy") {
    const groups = step.groupFields?.join("+") ?? "<none>";
    const choices = step.choices?.join("|") ?? "total";
    return `step: countBy group=${groups} choice=${
      step.choiceField ?? "total"
    } choices=${choices}`;
  }
  if (step.kind === "materialize") {
    return `step: materialize ${step.view ?? "<unnamed>"}`;
  }
  return `step: ${step.kind} ${(step.fields ?? []).join("+")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isAllowedString<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

function hasNonEmptyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every(isNonBlankString);
}

function validateOptionalStringArray(
  value: unknown,
  label: string,
  errors: string[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array when present`);
    return;
  }
  for (const entry of value) {
    if (!isNonBlankString(entry)) {
      errors.push(`${label} entries must be nonblank`);
    }
  }
}

function stringFor(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
