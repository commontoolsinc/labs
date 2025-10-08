/// <cts-enable />
import {
  type Cell,
  cell,
  Default,
  handler,
  lift,
  recipe,
  str,
  toSchema,
} from "commontools";

interface SubtotalGroupSeed {
  label?: string;
  values?: number[];
}

interface NestedComputedTotalsArgs {
  groups: Default<SubtotalGroupSeed[], []>;
}

interface SubtotalGroupArgs {
  label: Default<string, "">;
  values: Default<number[], []>;
  index: Default<number, 0>;
}

interface AppendGroupValueEvent {
  index?: number;
  label?: string;
  value?: number;
}

type AppendValueEvent = { value?: number } | number | undefined;

type ReplaceValuesEvent = { values?: number[] } | undefined;

const sanitizeNumber = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 100) / 100;
};

const sanitizeValues = (value: unknown): number[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const sanitized: number[] = [];
  for (const entry of value) {
    sanitized.push(sanitizeNumber(entry));
  }
  return sanitized;
};

const sanitizeIndex = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return -1;
  }
  const normalized = Math.trunc(value);
  return normalized < 0 ? -1 : normalized;
};

const resolveLabel = (raw: unknown, index: number): string => {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return `Group ${index + 1}`;
};

const appendValueToList = handler(
  (event: AppendValueEvent, context: { values: Cell<number[]> }) => {
    const rawValue = typeof event === "number" ? event : event?.value;
    if (rawValue === undefined) {
      return;
    }
    const amount = sanitizeNumber(rawValue);
    const current = sanitizeValues(context.values.get());
    context.values.set([...current, amount]);
  },
);

const replaceValuesList = handler(
  (event: ReplaceValuesEvent, context: { values: Cell<number[]> }) => {
    if (!event || !Array.isArray(event.values)) {
      return;
    }
    context.values.set(sanitizeValues(event.values));
  },
);

const subtotalGroup = recipe<SubtotalGroupArgs>(
  "Nested Totals Subgroup",
  ({ label, values, index }) => {
    const normalizedIndex = lift((value: number | undefined) => {
      const candidate = sanitizeIndex(value);
      return candidate >= 0 ? candidate : 0;
    })(index);

    const items = lift(sanitizeValues)(values);

    const subtotal = lift((entries: number[]) => {
      return entries.reduce((sum, value) => sum + value, 0);
    })(items);

    const itemCount = lift((entries: number[]) => entries.length)(items);

    const resolvedLabel = lift(
      (
        state: { raw: string | undefined; idx: number },
      ): string => {
        return resolveLabel(state.raw, state.idx);
      },
    )({
      raw: label,
      idx: normalizedIndex,
    });

    const subtotalLabel = str`${resolvedLabel} subtotal ${subtotal}`;

    return {
      index: normalizedIndex,
      label: resolvedLabel,
      items,
      itemCount,
      subtotal,
      subtotalLabel,
      append: appendValueToList({ values }),
      replace: replaceValuesList({ values }),
    };
  },
);

const instantiateGroups = lift(
  toSchema<{ groups: Cell<SubtotalGroupSeed[]> }>(),
  toSchema<unknown>(),
  ({ groups }) => {
    const raw = groups.get();
    const list = Array.isArray(raw) ? raw : [];
    const children: ReturnType<typeof subtotalGroup>[] = [];
    for (let index = 0; index < list.length; index++) {
      const groupCell = groups.key(index) as Cell<SubtotalGroupSeed>;
      const labelCell = groupCell.key("label") as Cell<string>;
      const valuesCell = groupCell.key("values") as Cell<number[]>;
      const child = subtotalGroup({
        label: labelCell as unknown as Default<string, "">,
        values: valuesCell as unknown as Default<number[], []>,
        index: cell(index) as unknown as Default<number, 0>,
      });
      children.push(child);
    }
    return children;
  },
);

const appendToGroup = handler(
  (
    event: AppendGroupValueEvent | undefined,
    context: { groups: Cell<SubtotalGroupSeed[]> },
  ) => {
    if (!event || event.value === undefined) {
      return;
    }

    const raw = context.groups.get();
    const list = Array.isArray(raw) ? raw : [];
    if (list.length === 0) {
      return;
    }

    let index = sanitizeIndex(event.index);

    if (index < 0 && typeof event.label === "string") {
      const trimmed = event.label.trim();
      if (trimmed.length > 0) {
        index = list.findIndex((entry, idx) => {
          return resolveLabel(entry?.label, idx) === trimmed;
        });
      }
    }

    if (index < 0 || index >= list.length) {
      return;
    }

    const groupCell = context.groups.key(index) as Cell<SubtotalGroupSeed>;
    const valuesCell = groupCell.key("values") as Cell<number[]>;
    const current = sanitizeValues(valuesCell.get());
    const amount = sanitizeNumber(event.value);
    valuesCell.set([...current, amount]);
  },
);

export const counterWithNestedComputedTotals = recipe<
  NestedComputedTotalsArgs
>(
  "Counter With Nested Computed Totals",
  ({ groups: groupSeeds }) => {
    const groups = instantiateGroups({ groups: groupSeeds });

    const groupTotals = lift((entries: unknown) => {
      if (!Array.isArray(entries)) {
        return [];
      }
      return entries.map((entry) => {
        const subtotal = (entry as { subtotal?: unknown }).subtotal;
        return typeof subtotal === "number"
          ? subtotal
          : sanitizeNumber(subtotal);
      });
    })(groups);

    const grandTotal = lift((totals: number[]) => {
      return totals.reduce((sum, value) => sum + value, 0);
    })(groupTotals);

    const groupLabels = lift((entries: unknown) => {
      if (!Array.isArray(entries)) {
        return [];
      }
      return entries.map((entry, index) => {
        const label = (entry as { label?: unknown }).label;
        return typeof label === "string" ? label : resolveLabel(label, index);
      });
    })(groups);

    const groupSummaries = lift(
      (
        state: { labels: string[]; totals: number[] },
      ): string[] => {
        const limit = Math.min(state.labels.length, state.totals.length);
        if (limit === 0) {
          return ["none"];
        }
        const summaries: string[] = [];
        for (let index = 0; index < limit; index++) {
          const label = state.labels[index];
          const value = state.totals[index];
          summaries.push(`${label}: ${value}`);
        }
        return summaries;
      },
    )({ labels: groupLabels, totals: groupTotals });

    const summary = lift((state: { parts: string[]; total: number }) => {
      const visible = state.parts.length > 0 ? state.parts.join(" | ") : "none";
      return `${visible} => total ${state.total}`;
    })({ parts: groupSummaries, total: grandTotal });

    const groupCount = lift((entries: unknown) => {
      return Array.isArray(entries) ? entries.length : 0;
    })(groups);

    const totalItems = lift((entries: unknown) => {
      if (!Array.isArray(entries)) {
        return 0;
      }
      return entries.reduce((sum, entry) => {
        const count = (entry as { itemCount?: unknown }).itemCount;
        return typeof count === "number" ? sum + count : sum;
      }, 0);
    })(groups);

    return {
      seeds: groupSeeds,
      groups,
      groupTotals,
      groupLabels,
      groupSummaries,
      groupCount,
      totalItems,
      grandTotal,
      summary,
      appendToGroup: appendToGroup({ groups: groupSeeds }),
    };
  },
);
