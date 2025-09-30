/// <cts-enable />
import {
  type Cell,
  cell,
  compute,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
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

const assignHandler = handler(
  (
    _event: unknown,
    context: {
      userIdInput: Cell<string>;
      variants: Cell<VariantConfig[]>;
      assignments: Cell<AssignmentMap>;
      history: Cell<string[]>;
    },
  ) => {
    const userIdText = context.userIdInput.get();
    const userId = sanitizeUserId(userIdText);
    if (!userId) return;

    const variants = toNormalizedVariants(context.variants.get());
    if (variants.length === 0) return;

    const currentAssignments = sanitizeAssignments(
      context.assignments.get(),
      variants,
    );
    if (currentAssignments[userId]) {
      context.userIdInput.set("");
      return;
    }

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

    context.userIdInput.set("");
  },
);

export const experimentAssignmentUx = recipe<ExperimentAssignmentArgs>(
  "Experiment Assignment",
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

    const userIdInput = cell<string>("");

    const assign = assignHandler({
      userIdInput,
      variants,
      assignments,
      history: assignmentHistory,
    });

    const name = str`Experiment Assignment`;

    const ui = (
      <div style="font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 24px; border-radius: 12px; margin-bottom: 24px;">
          <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 700;">
            Experiment Assignment
          </h1>
          <p style="margin: 0; opacity: 0.95; font-size: 16px;">
            Balanced A/B testing assignment system
          </p>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px;">
          <div style="background: white; border: 2px solid #e5e7eb; border-radius: 12px; padding: 20px;">
            <div style="font-size: 14px; color: #6b7280; font-weight: 600; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">
              Total Participants
            </div>
            <div
              style="font-size: 36px; font-weight: 700; color: #1f2937;"
              id="total-assignments"
            >
              {totalAssignments}
            </div>
          </div>

          <div
            style={lift((bal: BalanceSummary) => {
              const bgColor = bal.balanced ? "#ecfdf5" : "#fef3c7";
              const borderColor = bal.balanced ? "#10b981" : "#f59e0b";
              return (
                "background: " + bgColor + "; border: 2px solid " +
                borderColor + "; border-radius: 12px; padding: 20px;"
              );
            })(balance)}
          >
            <div style="font-size: 14px; color: #6b7280; font-weight: 600; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px;">
              Balance Status
            </div>
            <div
              style={lift((bal: BalanceSummary) => {
                const color = bal.balanced ? "#059669" : "#d97706";
                return (
                  "font-size: 20px; font-weight: 700; color: " + color + ";"
                );
              })(balance)}
              id="balance-status"
            >
              {lift((bal: BalanceSummary) =>
                bal.balanced ? "✓ Balanced" : "⚠ Imbalanced"
              )(balance)}
            </div>
            <div style="font-size: 14px; color: #6b7280; margin-top: 8px;">
              Max difference: {lift((bal: BalanceSummary) =>
                (bal.maxDifference * 100).toFixed(1) + "%"
              )(balance)}
            </div>
          </div>
        </div>

        <div style="background: white; border: 2px solid #e5e7eb; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
          <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 700; color: #1f2937;">
            Assign Participant
          </h2>
          <div style="display: flex; gap: 12px;">
            <ct-input
              $value={userIdInput}
              placeholder="Enter user ID..."
              style="flex: 1;"
              id="user-id-input"
            />
            <ct-button
              onClick={assign}
              style="padding: 0 24px;"
              id="assign-btn"
            >
              Assign
            </ct-button>
          </div>
        </div>

        <div style="background: white; border: 2px solid #e5e7eb; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
          <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 700; color: #1f2937;">
            Variant Allocation
          </h2>
          <div style="display: grid; gap: 12px;">
            {lift((alloc: AllocationEntry[]) => {
              const elements = [];
              for (const entry of alloc) {
                const diffPercent = (entry.difference * 100).toFixed(1);
                const diffColor = Math.abs(entry.difference) > 0.1
                  ? "#dc2626"
                  : "#059669";
                const targetPercent = (entry.targetShare * 100).toFixed(1);
                const actualPercent = (entry.actualShare * 100).toFixed(1);

                elements.push(
                  <div
                    style="border: 2px solid #e5e7eb; border-radius: 8px; padding: 16px;"
                    key={entry.name}
                  >
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                      <div>
                        <div style="font-size: 18px; font-weight: 700; color: #1f2937;">
                          {entry.name}
                        </div>
                        <div style="font-size: 14px; color: #6b7280; margin-top: 4px;">
                          Weight: {entry.weight}
                        </div>
                      </div>
                      <div style="text-align: right;">
                        <div style="font-size: 28px; font-weight: 700; color: #667eea;">
                          {entry.assigned}
                        </div>
                        <div style="font-size: 12px; color: #6b7280;">
                          assigned
                        </div>
                      </div>
                    </div>

                    <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-top: 12px; padding-top: 12px; border-top: 1px solid #e5e7eb;">
                      <div>
                        <div style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">
                          Target
                        </div>
                        <div style="font-size: 16px; font-weight: 600; color: #1f2937;">
                          {targetPercent}%
                        </div>
                      </div>
                      <div>
                        <div style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">
                          Actual
                        </div>
                        <div style="font-size: 16px; font-weight: 600; color: #1f2937;">
                          {actualPercent}%
                        </div>
                      </div>
                      <div>
                        <div style="font-size: 12px; color: #6b7280; margin-bottom: 4px;">
                          Difference
                        </div>
                        <div
                          style={"font-size: 16px; font-weight: 600; color: " +
                            diffColor + ";"}
                        >
                          {diffPercent}%
                        </div>
                      </div>
                    </div>
                  </div>,
                );
              }
              return elements;
            })(allocation)}
          </div>
        </div>

        <div style="background: white; border: 2px solid #e5e7eb; border-radius: 12px; padding: 24px;">
          <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 700; color: #1f2937;">
            Recent Assignments
          </h2>
          <div
            style="max-height: 240px; overflow-y: auto; font-family: 'Courier New', monospace; font-size: 14px;"
            id="assignment-history"
          >
            {lift((history: string[]) => {
              if (!Array.isArray(history) || history.length === 0) {
                return (
                  <div style="color: #9ca3af; text-align: center; padding: 40px;">
                    No assignments yet
                  </div>
                );
              }
              const reversed = history.slice().reverse();
              const elements = [];
              const limit = Math.min(reversed.length, 10);
              for (let i = 0; i < limit; i++) {
                const entry = reversed[i];
                const bgColor = i % 2 === 0 ? "#f9fafb" : "#ffffff";
                elements.push(
                  <div
                    style={"padding: 8px 12px; background: " + bgColor + ";"}
                    key={i}
                  >
                    {entry}
                  </div>,
                );
              }
              return elements;
            })(assignmentHistoryView)}
          </div>
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
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
