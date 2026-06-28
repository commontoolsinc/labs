import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  pattern,
  str,
} from "commonfabric";

// SCALED child-pattern-map bench fixture — INTERMEDIATE-CHAIN variant.
//
// Companion to `counter-child-pattern-map-scaled`. Here the child's pure chain
// is mostly INTERMEDIATE: a deep lift chain (a → b → c → d) where only the FINAL
// `display` field is an addressable result output. The intermediates (a,b,c,d)
// are NOT exposed on the result, so they are exactly the "INLINABLE intermediate
// scalar-lift docs" the campaign INNER-DOC note names — the docs a partition
// could in principle collapse into a single segment without changing the
// addressable output surface.
//
// This isolates the question: does interpreting a launched child COALESCE its
// purely-intermediate scalar-lift docs (vs the addressable output fields, which
// are required identically in both arms)?

interface IntermChildArgs {
  identity: Default<string, "row">;
  value: Default<number, 0>;
}

interface IntermConfig {
  id: string;
  start: number;
}

type IntermConfigInput = Partial<IntermConfig> & { id?: string };

interface IntermChainMapArgs {
  configs: Default<IntermConfigInput[], []>;
}

const toFiniteNumber = (input: unknown, fallback: number): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  return input;
};

const sanitizeIdentity = (input: unknown, index: number): string => {
  if (typeof input === "string" && input.trim().length > 0) {
    return input.trim();
  }
  return `row-${index + 1}`;
};

const sanitizeConfigEntries = (input: unknown): IntermConfig[] => {
  if (!Array.isArray(input)) return [];
  return input.map((entry, index) => {
    const value = typeof entry === "object" && entry !== null ? entry : {};
    return {
      id: sanitizeIdentity((value as IntermConfigInput).id, index),
      start: Math.trunc(toFiniteNumber((value as IntermConfigInput).start, 0)),
    };
  });
};

const rowIncrement = handler(
  (
    event: { cycles?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const current = toFiniteNumber(context.value.get(), 0);
    const cycles = typeof event?.cycles === "number" ? event.cycles : 1;
    context.value.set(current + cycles);
  },
);

// A DEEP intermediate lift chain: each step only feeds the next; none is a
// result field except the final `display`.
const stepA = lift((v: number | undefined) => toFiniteNumber(v, 0) + 1);
const stepB = lift((v: number) => v * 2);
const stepC = lift((v: number) => v - 3);
const stepD = lift((v: number) => Math.abs(v));

export const intermChildCounter = pattern<IntermChildArgs>(
  ({ identity, value }) => {
    const a = stepA(value);
    const b = stepB(a);
    const c = stepC(b);
    const d = stepD(c);

    // Only `value`, `display`, `increment` are addressable result fields;
    // a/b/c/d are pure intermediates that feed ONLY `display`.
    const display = str`${identity}: ${d}`;
    const increment = rowIncrement({ value });

    return { value, display, increment };
  },
);

const liftSanitizedConfigs = lift((entries: IntermConfigInput[] | undefined) =>
  sanitizeConfigEntries(entries)
);

const liftRows = lift((entries: IntermConfig[]) =>
  entries.map((config) =>
    intermChildCounter({ identity: config.id, value: config.start })
  )
);

const reconfigure = handler(
  (
    event: { configs?: IntermConfigInput[] } | undefined,
    context: { configs: Cell<IntermConfigInput[]>; version: Cell<number> },
  ) => {
    if (!event || !("configs" in event)) return;
    context.configs.set(sanitizeConfigEntries(event.configs));
    context.version.set(toFiniteNumber(context.version.get(), 0) + 1);
  },
);

export const counterChildIntermediateChainScaled = pattern<IntermChainMapArgs>(
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

export default counterChildIntermediateChainScaled;
