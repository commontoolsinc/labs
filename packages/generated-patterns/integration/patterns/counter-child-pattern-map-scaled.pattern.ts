import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

// SCALED child-pattern-map bench fixture (reactive-interpreter coalescing).
//
// Shape = "the real interactive-list" the campaign's INNER-DOC FRONTIER note
// names: a parent that maps over N configs, each instantiating a CHILD PATTERN
// (via `liftChildren`) that carries a PURE intra-child display chain (several
// lifts/`str`s that only feed the child's own result) PLUS one handler (the
// per-row interactive boundary). This is the map-of-child-patterns whose
// per-child intermediate doc tax the launched-child gate work targets — distinct
// from the pure-RENDER row the notes bench simplifies to.
//
// The child's pure chain length is deliberately RICH (6 pure outputs:
// identity/value/step/two derived labels/summary) so the per-child marginal
// footprint is measurable as N grows. The config count N is taken straight from
// the `configs` argument, so the bench scenario can drive N = 1, 4, 8 from the
// same module.

interface RowChildArgs {
  identity: Default<string, "row">;
  value: Default<number, 0>;
  step: Default<number, 1>;
  labelPrefix: Default<string, "Row">;
}

interface RowConfig {
  id: string;
  start: number;
  step: number;
  labelPrefix: string;
}

type RowConfigInput = Partial<RowConfig> & { id?: string };

interface ChildPatternMapArgs {
  configs: Default<RowConfigInput[], []>;
}

const toFiniteNumber = (input: unknown, fallback: number): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  return input;
};

const normalizeStep = (input: unknown): number => {
  const value = toFiniteNumber(input, 1);
  if (value === 0) return 1;
  return Math.abs(value);
};

const sanitizeLabelPrefix = (input: unknown, fallback: string): string => {
  if (typeof input !== "string") return fallback;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const sanitizeIdentity = (input: unknown, index: number): string => {
  if (typeof input === "string" && input.trim().length > 0) {
    return input.trim();
  }
  return `row-${index + 1}`;
};

const sanitizeRowConfig = (entry: unknown, index: number): RowConfig => {
  const value = typeof entry === "object" && entry !== null ? entry : {};
  const id = sanitizeIdentity((value as RowConfigInput).id, index);
  const start = Math.trunc(toFiniteNumber((value as RowConfigInput).start, 0));
  const step = normalizeStep((value as RowConfigInput).step);
  const labelPrefix = sanitizeLabelPrefix(
    (value as RowConfigInput).labelPrefix,
    "Row",
  );
  return { id, start, step, labelPrefix };
};

const sanitizeConfigEntries = (input: unknown): RowConfig[] => {
  if (!Array.isArray(input)) return [];
  return input.map((entry, index) => sanitizeRowConfig(entry, index));
};

const rowIncrement = handler(
  (
    event: { cycles?: number } | undefined,
    context: { value: Cell<number>; step: Cell<number> },
  ) => {
    const current = toFiniteNumber(context.value.get(), 0);
    const step = normalizeStep(context.step.get());
    const cycles = typeof event?.cycles === "number" ? event.cycles : 1;
    context.value.set(current + step * cycles);
  },
);

const liftSafeIdentity = lift((input: string | undefined) =>
  typeof input === "string" && input.trim().length > 0 ? input.trim() : "row"
);

const liftNormalizedStep = lift((input: number | undefined) =>
  normalizeStep(input)
);

const liftNormalizedValue = lift((input: number | undefined) =>
  toFiniteNumber(input, 0)
);

const liftSanitizedPrefix = lift((input: string | undefined) =>
  sanitizeLabelPrefix(input, "Row")
);

// The PER-CHILD pure display chain: 4 lifts + 2 `str`s, all feeding ONLY the
// child's own result. When the child interprets (gate lifted), this whole chain
// coalesces into segment node(s); the handler stays a boundary.
export const rowChildCounter = pattern<RowChildArgs>(
  ({ identity, value, step, labelPrefix }) => {
    const safeIdentity = liftSafeIdentity(identity);
    const normalizedStep = liftNormalizedStep(step);
    const normalizedValue = liftNormalizedValue(value);
    const sanitizedPrefix = liftSanitizedPrefix(labelPrefix);

    const label =
      str`${sanitizedPrefix} (${safeIdentity}) value ${normalizedValue}`;
    const summary = str`${safeIdentity} step ${normalizedStep}`;

    const increment = rowIncrement({ value, step: normalizedStep });

    return {
      identity: safeIdentity,
      value: normalizedValue,
      step: normalizedStep,
      label,
      summary,
      increment,
    };
  },
);

const liftSanitizedConfigs = lift((entries: RowConfigInput[] | undefined) =>
  sanitizeConfigEntries(entries)
);

const liftRows = lift((entries: RowConfig[]) =>
  entries.map((config) =>
    rowChildCounter({
      identity: config.id,
      value: config.start,
      step: config.step,
      labelPrefix: config.labelPrefix,
    })
  )
);

const reconfigure = handler(
  (
    event: { configs?: RowConfigInput[] } | undefined,
    context: {
      configs: Cell<RowConfigInput[]>;
      version: Cell<number>;
    },
  ) => {
    if (!event || !("configs" in event)) return;
    context.configs.set(sanitizeConfigEntries(event.configs));
    context.version.set(toFiniteNumber(context.version.get(), 0) + 1);
  },
);

export const counterChildPatternMapScaled = pattern<ChildPatternMapArgs>(
  ({ configs }) => {
    const version = cell(0);
    const sanitizedConfigs = liftSanitizedConfigs(configs);
    const rows = liftRows(sanitizedConfigs);
    const rowCount = sanitizedConfigs.length;

    return {
      configs,
      rows,
      rowCount,
      reconfigure: reconfigure({ configs, version }),
      reconfigurations: version,
    };
  },
);

export default counterChildPatternMapScaled;
