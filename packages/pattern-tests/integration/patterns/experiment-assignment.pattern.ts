/// <cts-enable />
import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  recipe,
  str,
} from "commontools";

interface VariantConfig {
  name?: string;
  weight?: number;
}

interface ExperimentAssignmentArgs {
  variants: Default<VariantConfig[], typeof defaultVariants>;
  assignments: Default<Record<string, string>, {}>;
}

interface AssignmentEvent {
  userId?: string;
}

interface NormalizedVariant {
  name: string;
  weight: number;
  index: number;
}

type AssignmentMap = Record<string, string>;

interface AllocationEntry {
  name: string;
  weight: number;
  targetShare: number;
  actualShare: number;
  assigned: number;
  difference: number;
}

interface BalanceSummary {
  maxDifference: number;
  balanced: boolean;
}

const defaultVariants: VariantConfig[] = [
  { name: "control", weight: 1 },
  { name: "experiment", weight: 1 },
];

const roundShare = (value: number): number => Math.round(value * 1000) / 1000;

const sanitizeUserId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const sanitizeVariantName = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const ensureUnique = (name: string, used: Set<string>): string => {
  if (!used.has(name)) return name;
  let suffix = 2;
  while (used.has(`${name}-${suffix}`)) {
    suffix += 1;
  }
  return `${name}-${suffix}`;
};

const normalizedDefaults = (): NormalizedVariant[] => {
  const used = new Set<string>();
  return defaultVariants.map((entry, index) => {
    const name = ensureUnique(
      sanitizeVariantName(entry?.name, `variant-${index + 1}`),
      used,
    );
    used.add(name);
    const weight = typeof entry?.weight === "number" && entry.weight > 0
      ? Math.round(entry.weight)
      : 1;
    return { name, weight, index };
  });
};

const toNormalizedVariants = (value: unknown): NormalizedVariant[] => {
  if (!Array.isArray(value)) {
    return normalizedDefaults();
  }
  const used = new Set<string>();
  const variants: NormalizedVariant[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index] as VariantConfig | undefined;
    const fallback = `variant-${index + 1}`;
    const name = ensureUnique(
      sanitizeVariantName(entry?.name, fallback),
      used,
    );
    used.add(name);
    const weightInput = entry?.weight;
    const weight = typeof weightInput === "number" && weightInput > 0
      ? Math.round(weightInput)
      : 1;
    variants.push({ name, weight, index });
  }
  return variants.length > 0 ? variants : normalizedDefaults();
};

const sanitizeAssignments = (
  value: unknown,
  variants: readonly NormalizedVariant[],
): AssignmentMap => {
  const result: AssignmentMap = {};
  if (!value || typeof value !== "object") return result;
  const variantNames = new Set(variants.map((entry) => entry.name));
  for (const key of Object.keys(value)) {
    const userId = sanitizeUserId(key);
    if (!userId) continue;
    const assigned = (value as Record<string, unknown>)[key];
    if (typeof assigned !== "string") continue;
    const variantName = assigned.trim();
    if (!variantNames.has(variantName) || result[userId]) continue;
    result[userId] = variantName;
  }
  return result;
};

const countAssignments = (
  variants: readonly NormalizedVariant[],
  assignments: AssignmentMap,
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const variant of variants) {
    counts[variant.name] = 0;
  }
  for (const variantName of Object.values(assignments)) {
    if (counts[variantName] !== undefined) {
      counts[variantName] += 1;
    }
  }
  return counts;
};

const computeAllocation = (
  variants: readonly NormalizedVariant[],
  counts: Record<string, number>,
): AllocationEntry[] => {
  const totalWeight = variants.reduce((sum, entry) => sum + entry.weight, 0);
  const totalAssignments = Object.values(counts).reduce(
    (sum, value) => sum + value,
    0,
  );
  return variants.map((variant) => {
    const assigned = counts[variant.name] ?? 0;
    const targetShare = totalWeight === 0 ? 0 : variant.weight / totalWeight;
    const actualShare = totalAssignments === 0
      ? 0
      : assigned / totalAssignments;
    const difference = totalAssignments === 0 ? 0 : actualShare - targetShare;
    return {
      name: variant.name,
      weight: variant.weight,
      targetShare: roundShare(targetShare),
      actualShare: roundShare(actualShare),
      assigned,
      difference: roundShare(difference),
    };
  });
};

const computeBalance = (
  entries: readonly AllocationEntry[],
): BalanceSummary => {
  let maxDifference = 0;
  for (const entry of entries) {
    const delta = Math.abs(entry.difference);
    if (delta > maxDifference) maxDifference = delta;
  }
  return {
    maxDifference: roundShare(maxDifference),
    balanced: maxDifference <= 0.25,
  };
};

const buildSummaryText = (
  entries: readonly AllocationEntry[],
  total: number,
): string => {
  const parts = entries.map((entry) => `${entry.name}:${entry.assigned}`);
  return `Assignments ${total} [${parts.join(", ")}]`;
};

const assignParticipant = handler(
  (
    event: AssignmentEvent | undefined,
    context: {
      variants: Cell<VariantConfig[]>;
      assignments: Cell<AssignmentMap>;
      history: Cell<string[]>;
    },
  ) => {
    const userId = sanitizeUserId(event?.userId);
    if (!userId) return;

    const variants = toNormalizedVariants(context.variants.get());
    if (variants.length === 0) return;

    const currentAssignments = sanitizeAssignments(
      context.assignments.get(),
      variants,
    );
    if (currentAssignments[userId]) return;

    const counts = countAssignments(variants, currentAssignments);
    let selection = variants[0];
    let bestScore = Infinity;
    for (const variant of variants) {
      const count = counts[variant.name] ?? 0;
      const score = (count + 1) / variant.weight;
      if (
        score < bestScore ||
        (score === bestScore && variant.index < selection.index)
      ) {
        selection = variant;
        bestScore = score;
      }
    }

    currentAssignments[userId] = selection.name;
    context.assignments.set({ ...currentAssignments });

    const previousHistory = context.history.get();
    const history = Array.isArray(previousHistory) ? previousHistory : [];
    context.history.set([...history, `${userId}:${selection.name}`]);
  },
);

export const experimentAssignmentPattern = recipe<ExperimentAssignmentArgs>(
  "Experiment Assignment Pattern",
  ({ variants, assignments }) => {
    const assignmentHistory = cell<string[]>([]);

    const normalizedVariants = lift(toNormalizedVariants)(variants);

    const assignmentMap = lift(
      (input: {
        assignments: AssignmentMap | undefined;
        variants: NormalizedVariant[];
      }) => sanitizeAssignments(input.assignments, input.variants),
    )({ assignments, variants: normalizedVariants });

    const counts = lift(
      (input: {
        variants: NormalizedVariant[];
        assignments: AssignmentMap;
      }) => countAssignments(input.variants, input.assignments),
    )({ variants: normalizedVariants, assignments: assignmentMap });

    const totalAssignments = lift((record: Record<string, number>) =>
      Object.values(record).reduce((sum, value) => sum + value, 0)
    )(counts);

    const allocation = lift(
      (input: {
        variants: NormalizedVariant[];
        counts: Record<string, number>;
      }) => computeAllocation(input.variants, input.counts),
    )({ variants: normalizedVariants, counts });

    const balance = lift(computeBalance)(allocation);

    const variantManifest = lift(
      (entries: NormalizedVariant[]) =>
        entries.map((entry) => ({ name: entry.name, weight: entry.weight })),
    )(normalizedVariants);

    const assignmentHistoryView = lift((entries: string[] | undefined) =>
      Array.isArray(entries) ? entries : []
    )(assignmentHistory);

    const summaryText = lift(
      (input: { entries: AllocationEntry[]; total: number }) =>
        buildSummaryText(input.entries, input.total),
    )({ entries: allocation, total: totalAssignments });

    const label = str`${summaryText}`;

    return {
      variants: variantManifest,
      assignmentMap,
      counts,
      allocation,
      balance,
      totalAssignments,
      assignmentHistory: assignmentHistoryView,
      label,
      assignParticipant: assignParticipant({
        variants,
        assignments,
        history: assignmentHistory,
      }),
    };
  },
);
