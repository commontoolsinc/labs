/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  derive,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface GroupedSummaryArgs {
  entries: Default<GroupEntryInput[], []>;
  defaultAmount: Default<number, 1>;
}

interface GroupEntryInput {
  id?: string;
  group?: string;
  value?: number;
}

interface GroupEntry {
  id: string;
  group: string;
  value: number;
}

interface GroupSummary {
  group: string;
  total: number;
  count: number;
}

interface RecordGroupEvent {
  id?: string;
  group?: string;
  delta?: number;
  value?: number;
}

const sanitizeNumber = (input: unknown, fallback = 0): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.round(input * 100) / 100;
};

const sanitizeIdentifier = (input: unknown, fallback: string): string => {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeGroup = (input: unknown, fallback = "general"): string => {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeEntries = (value: unknown): GroupEntry[] => {
  if (!Array.isArray(value)) return [];
  const sanitized: GroupEntry[] = [];
  for (let index = 0; index < value.length; index++) {
    const raw = value[index] as GroupEntryInput | undefined;
    const fallbackId = `entry-${index + 1}`;
    const id = sanitizeIdentifier(raw?.id, fallbackId);
    const group = sanitizeGroup(raw?.group);
    const entryValue = sanitizeNumber(raw?.value, 0);
    sanitized.push({ id, group, value: entryValue });
  }
  return sanitized;
};

const uniqueGeneratedId = (entries: readonly GroupEntry[]): string => {
  const used = new Set(entries.map((entry) => entry.id));
  let index = entries.length + 1;
  let candidate = `entry-${index}`;
  while (used.has(candidate)) {
    index += 1;
    candidate = `entry-${index}`;
  }
  return candidate;
};

const computeSummaries = (entries: readonly GroupEntry[]): GroupSummary[] => {
  const grouped = new Map<string, { total: number; count: number }>();
  for (const entry of entries) {
    const group = sanitizeGroup(entry.group);
    const snapshot = grouped.get(group) ?? { total: 0, count: 0 };
    snapshot.total += entry.value;
    snapshot.count += 1;
    grouped.set(group, snapshot);
  }
  const summaries = Array.from(grouped.entries()).map(([group, stats]) => ({
    group,
    total: Math.round(stats.total * 100) / 100,
    count: stats.count,
  }));
  summaries.sort((left, right) => left.group.localeCompare(right.group));
  return summaries;
};

const totalsRecord = (
  summaries: readonly GroupSummary[],
): Record<string, number> => {
  const output: Record<string, number> = {};
  for (const summary of summaries) {
    output[summary.group] = summary.total;
  }
  return output;
};

const dominantSummary = (summaries: readonly GroupSummary[]): GroupSummary => {
  if (summaries.length === 0) {
    return { group: "none", total: 0, count: 0 };
  }
  let best = { ...summaries[0] };
  for (let index = 1; index < summaries.length; index++) {
    const current = summaries[index];
    if (current.total > best.total) {
      best = { ...current };
      continue;
    }
    if (current.total === best.total) {
      if (current.group.localeCompare(best.group) < 0) {
        best = { ...current };
      }
    }
  }
  return best;
};

const formatTotal = (value: number): string => {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
};

const summaryLabelText = (summaries: readonly GroupSummary[]): string => {
  if (summaries.length === 0) return "none";
  return summaries.map((item) => {
    const total = formatTotal(item.total);
    return `${item.group}: ${total} (${item.count})`;
  }).join(" • ");
};

const recordGroupMeasurement = handler(
  (
    event: RecordGroupEvent | undefined,
    context: {
      entries: Cell<GroupEntryInput[]>;
      defaultAmount: Cell<number>;
    },
  ) => {
    const list = sanitizeEntries(context.entries.get());
    const fallbackAmount = (() => {
      const value = context.defaultAmount.get();
      return sanitizeNumber(value, 1) || 1;
    })();

    const requestedId = sanitizeIdentifier(
      event?.id,
      uniqueGeneratedId(list),
    );
    const index = list.findIndex((entry) => entry.id === requestedId);

    const delta = sanitizeNumber(event?.delta, fallbackAmount);
    const override = event?.value;
    const hasOverride = typeof override === "number" &&
      Number.isFinite(override);
    const absolute = hasOverride
      ? sanitizeNumber(override, fallbackAmount)
      : undefined;

    if (index >= 0) {
      const existing = list[index];
      const group = sanitizeGroup(event?.group, existing.group);
      const nextValue = absolute ?? existing.value + delta;
      list[index] = { id: existing.id, group, value: nextValue };
    } else {
      const group = sanitizeGroup(event?.group);
      const value = absolute ?? delta;
      list.push({ id: requestedId, group, value });
    }

    context.entries.set(list);
  },
);

export const counterWithGroupedSummary = recipe<GroupedSummaryArgs>(
  "Counter With Grouped Summary",
  ({ entries, defaultAmount }) => {
    const defaultAmountValue = lift((value: number | undefined) => {
      const sanitized = sanitizeNumber(value, 1);
      return sanitized === 0 ? 1 : sanitized;
    })(defaultAmount);

    const entryList = lift((value: GroupEntryInput[] | undefined) =>
      sanitizeEntries(value)
    )(entries);
    const summaries = derive(entryList, computeSummaries);
    const totals = derive(summaries, totalsRecord);
    const dominant = derive(summaries, dominantSummary);
    const overallTotal = derive(
      summaries,
      (items) => items.reduce((sum, entry) => sum + entry.total, 0),
    );
    const groupCount = derive(summaries, (items) => items.length);
    const labelPieces = lift(summaryLabelText)(summaries);
    const summaryLabel = str`Group totals ${labelPieces}`;

    // UI cells
    const entryIdInput = cell("");
    const groupInput = cell("");
    const deltaInput = cell("");
    const valueInput = cell("");

    // Handlers for UI
    const addWithDelta = handler((context: {
      entries: Cell<GroupEntryInput[]>;
      defaultAmount: Cell<number>;
      entryIdInput: Cell<string>;
      groupInput: Cell<string>;
      deltaInput: Cell<string>;
    }) => {
      const id = context.entryIdInput.get().trim();
      const group = context.groupInput.get().trim();
      const deltaStr = context.deltaInput.get().trim();
      const delta = deltaStr ? parseFloat(deltaStr) : undefined;

      const list = sanitizeEntries(context.entries.get());
      const fallbackAmount = (() => {
        const value = context.defaultAmount.get();
        return sanitizeNumber(value, 1) || 1;
      })();

      const requestedId = sanitizeIdentifier(
        id || undefined,
        uniqueGeneratedId(list),
      );
      const index = list.findIndex((entry) => entry.id === requestedId);

      const deltaValue = sanitizeNumber(delta, fallbackAmount);

      if (index >= 0) {
        const existing = list[index];
        const targetGroup = group ? sanitizeGroup(group) : existing.group;
        const nextValue = existing.value + deltaValue;
        list[index] = { id: existing.id, group: targetGroup, value: nextValue };
      } else {
        const targetGroup = sanitizeGroup(group || undefined);
        list.push({ id: requestedId, group: targetGroup, value: deltaValue });
      }

      context.entries.set(list);
      context.entryIdInput.set("");
      context.groupInput.set("");
      context.deltaInput.set("");
    })({
      entries,
      defaultAmount: defaultAmountValue,
      entryIdInput,
      groupInput,
      deltaInput,
    });

    const setAbsolute = handler((context: {
      entries: Cell<GroupEntryInput[]>;
      defaultAmount: Cell<number>;
      entryIdInput: Cell<string>;
      groupInput: Cell<string>;
      valueInput: Cell<string>;
    }) => {
      const id = context.entryIdInput.get().trim();
      const group = context.groupInput.get().trim();
      const valueStr = context.valueInput.get().trim();
      const value = valueStr ? parseFloat(valueStr) : undefined;

      const list = sanitizeEntries(context.entries.get());
      const fallbackAmount = (() => {
        const val = context.defaultAmount.get();
        return sanitizeNumber(val, 1) || 1;
      })();

      const requestedId = sanitizeIdentifier(
        id || undefined,
        uniqueGeneratedId(list),
      );
      const index = list.findIndex((entry) => entry.id === requestedId);

      const absoluteValue = sanitizeNumber(value, fallbackAmount);

      if (index >= 0) {
        const existing = list[index];
        const targetGroup = group ? sanitizeGroup(group) : existing.group;
        list[index] = {
          id: existing.id,
          group: targetGroup,
          value: absoluteValue,
        };
      } else {
        const targetGroup = sanitizeGroup(group || undefined);
        list.push({
          id: requestedId,
          group: targetGroup,
          value: absoluteValue,
        });
      }

      context.entries.set(list);
      context.entryIdInput.set("");
      context.groupInput.set("");
      context.valueInput.set("");
    })({
      entries,
      defaultAmount: defaultAmountValue,
      entryIdInput,
      groupInput,
      valueInput,
    });

    // Lifted derived values for UI
    const name = lift((count: number) =>
      count === 0 ? "Grouped Summary (Empty)" : "Grouped Summary"
    )(groupCount);

    const entriesDisplay = lift((list: GroupEntry[]) => {
      if (list.length === 0) {
        return (
          <ct-card style="padding: 20px; text-align: center; color: #666;">
            No entries yet. Add entries using the controls above.
          </ct-card>
        );
      }

      const entryElements = list.map((entry) => {
        const valueStr = formatTotal(entry.value);
        return (
          <div
            key={entry.id}
            style="padding: 12px; border: 1px solid #ddd; border-radius: 4px; background: white;"
          >
            <div style="font-weight: 600; color: #333; margin-bottom: 4px;">
              {entry.id}
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <span style="color: #666; font-size: 14px;">
                Group: {entry.group}
              </span>
              <span style="font-weight: 600; color: #0066cc; font-size: 16px;">
                {valueStr}
              </span>
            </div>
          </div>
        );
      });

      return (
        <div style="display: flex; flex-direction: column; gap: 8px;">
          {entryElements}
        </div>
      );
    })(entryList);

    const summariesDisplay = lift((summaryList: GroupSummary[]) => {
      if (summaryList.length === 0) {
        return (
          <ct-card style="padding: 20px; text-align: center; color: #666;">
            No groups yet
          </ct-card>
        );
      }

      const summaryElements = summaryList.map((summary) => {
        const totalStr = formatTotal(summary.total);
        const avg = summary.count > 0
          ? formatTotal(summary.total / summary.count)
          : "0";

        return (
          <ct-card
            key={summary.group}
            style="padding: 16px; border-left: 4px solid #0066cc;"
          >
            <div style="font-weight: 600; color: #0066cc; font-size: 18px; margin-bottom: 8px;">
              {summary.group}
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-top: 8px;">
              <div>
                <div style="color: #666; font-size: 12px; margin-bottom: 4px;">
                  Total
                </div>
                <div style="font-weight: 600; font-size: 20px; color: #333;">
                  {totalStr}
                </div>
              </div>
              <div>
                <div style="color: #666; font-size: 12px; margin-bottom: 4px;">
                  Count
                </div>
                <div style="font-weight: 600; font-size: 20px; color: #333;">
                  {String(summary.count)}
                </div>
              </div>
              <div>
                <div style="color: #666; font-size: 12px; margin-bottom: 4px;">
                  Average
                </div>
                <div style="font-weight: 600; font-size: 20px; color: #333;">
                  {avg}
                </div>
              </div>
            </div>
          </ct-card>
        );
      });

      return (
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px;">
          {summaryElements}
        </div>
      );
    })(summaries);

    const dominantDisplay = lift((dom: GroupSummary) => {
      if (dom.group === "none") {
        return "—";
      }
      const totalStr = formatTotal(dom.total);
      return dom.group + " (" + totalStr + ")";
    })(dominant);

    const overallTotalDisplay = lift((total: number) => formatTotal(total))(
      overallTotal,
    );

    const ui = (
      <div style="padding: 24px; max-width: 1200px; margin: 0 auto;">
        <div style="margin-bottom: 24px;">
          <h1 style="margin: 0 0 8px 0; color: #333; font-size: 28px;">
            Grouped Summary Counter
          </h1>
          <p style="margin: 0; color: #666; font-size: 14px;">
            Track entries by group and view aggregated summaries
          </p>
        </div>

        <ct-card style="padding: 20px; margin-bottom: 24px;">
          <h2 style="margin: 0 0 16px 0; font-size: 18px; color: #333;">
            Add or Update Entry
          </h2>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
            <div>
              <label style="display: block; margin-bottom: 4px; color: #666; font-size: 14px;">
                Entry ID (optional)
              </label>
              <ct-input
                $value={entryIdInput}
                placeholder="e.g., entry-1"
                style="width: 100%;"
              />
            </div>
            <div>
              <label style="display: block; margin-bottom: 4px; color: #666; font-size: 14px;">
                Group (optional, defaults to 'general')
              </label>
              <ct-input
                $value={groupInput}
                placeholder="e.g., alpha, beta, gamma"
                style="width: 100%;"
              />
            </div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
            <div>
              <label style="display: block; margin-bottom: 4px; color: #666; font-size: 14px;">
                Delta (add/subtract)
              </label>
              <ct-input
                $value={deltaInput}
                placeholder="e.g., 5 or -3"
                style="width: 100%;"
              />
            </div>
            <div>
              <label style="display: block; margin-bottom: 4px; color: #666; font-size: 14px;">
                Absolute Value (set directly)
              </label>
              <ct-input
                $value={valueInput}
                placeholder="e.g., 10"
                style="width: 100%;"
              />
            </div>
          </div>

          <div style="display: flex; gap: 12px;">
            <ct-button onClick={addWithDelta} style="flex: 1;">
              Add/Modify with Delta
            </ct-button>
            <ct-button onClick={setAbsolute} style="flex: 1;">
              Set Absolute Value
            </ct-button>
          </div>
        </ct-card>

        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-bottom: 24px;">
          <ct-card style="padding: 16px; text-align: center;">
            <div style="color: #666; font-size: 14px; margin-bottom: 4px;">
              Overall Total
            </div>
            <div style="font-size: 28px; font-weight: 600; color: #0066cc;">
              {overallTotalDisplay}
            </div>
          </ct-card>

          <ct-card style="padding: 16px; text-align: center;">
            <div style="color: #666; font-size: 14px; margin-bottom: 4px;">
              Groups
            </div>
            <div style="font-size: 28px; font-weight: 600; color: #0066cc;">
              {lift((count: number) => String(count))(groupCount)}
            </div>
          </ct-card>

          <ct-card style="padding: 16px; text-align: center;">
            <div style="color: #666; font-size: 14px; margin-bottom: 4px;">
              Dominant Group
            </div>
            <div style="font-size: 20px; font-weight: 600; color: #0066cc;">
              {dominantDisplay}
            </div>
          </ct-card>
        </div>

        <div style="margin-bottom: 24px;">
          <h2 style="margin: 0 0 12px 0; font-size: 20px; color: #333;">
            Group Summaries
          </h2>
          {summariesDisplay}
        </div>

        <div>
          <h2 style="margin: 0 0 12px 0; font-size: 20px; color: #333;">
            All Entries
          </h2>
          {entriesDisplay}
        </div>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      entries: entryList,
      summaries,
      groupTotals: totals,
      overallTotal,
      groupCount,
      dominantGroup: dominant,
      summaryLabel,
      controls: {
        record: recordGroupMeasurement({
          entries,
          defaultAmount: defaultAmountValue,
        }),
      },
    };
  },
);
