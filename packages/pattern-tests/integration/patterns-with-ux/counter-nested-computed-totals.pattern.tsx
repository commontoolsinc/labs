/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  compute,
  Default,
  derive,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  toSchema,
  UI,
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

export const counterWithNestedComputedTotalsUx = recipe<
  NestedComputedTotalsArgs
>(
  "Counter With Nested Computed Totals (UX)",
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

    const name = str`Budget Tracker (${grandTotal})`;

    // UI state for adding values
    const valueInputField = cell<string>("0");
    const selectedGroupIndexField = cell<number>(0);

    const valueToAdd = derive(valueInputField, (text) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return 0;
      }
      return Math.round(parsed * 100) / 100;
    });

    const addValueHandler = handler<
      unknown,
      {
        valueInput: Cell<string>;
        groupIndex: Cell<number>;
        groups: Cell<SubtotalGroupSeed[]>;
      }
    >((_event, { valueInput, groupIndex, groups }) => {
      const text = valueInput.get() ?? "0";
      const parsed = Number(text);
      const value = sanitizeNumber(parsed);
      const index = sanitizeIndex(groupIndex.get());

      const raw = groups.get();
      const list = Array.isArray(raw) ? raw : [];

      if (index < 0 || index >= list.length) {
        return;
      }

      const groupCell = groups.key(index) as Cell<SubtotalGroupSeed>;
      const valuesCell = groupCell.key("values") as Cell<number[]>;
      const current = sanitizeValues(valuesCell.get());
      valuesCell.set([...current, value]);

      // Reset input
      valueInput.set("0");
    })({
      valueInput: valueInputField,
      groupIndex: selectedGroupIndexField,
      groups: groupSeeds,
    });

    const groupsDisplay = lift((
      breakdown: typeof groups extends Cell<
        infer T
      > ? T
        : never,
    ) => {
      if (!Array.isArray(breakdown)) {
        return (
          <div style="
              text-align: center;
              padding: 2rem;
              color: #64748b;
              font-style: italic;
            ">
            No groups yet. Add groups to get started.
          </div>
        );
      }

      if (breakdown.length === 0) {
        return (
          <div style="
              text-align: center;
              padding: 2rem;
              color: #64748b;
              font-style: italic;
            ">
            No groups yet. Add groups to get started.
          </div>
        );
      }

      const groupElements = [];
      for (let index = 0; index < breakdown.length; index++) {
        const entry = breakdown[index];
        const label = (entry as { label?: unknown }).label;
        const subtotal = (entry as { subtotal?: unknown }).subtotal;
        const items = (entry as { items?: unknown }).items;
        const itemCount = (entry as { itemCount?: unknown }).itemCount;

        const groupLabel = typeof label === "string"
          ? label
          : resolveLabel(label, index);
        const groupSubtotal = typeof subtotal === "number"
          ? subtotal
          : sanitizeNumber(subtotal);
        const groupItems = Array.isArray(items) ? items : [];
        const count = typeof itemCount === "number" ? itemCount : 0;

        const itemElements = [];
        for (let i = 0; i < groupItems.length; i++) {
          const value = groupItems[i];
          itemElements.push(
            <div style="
                background: #f1f5f9;
                border-radius: 0.375rem;
                padding: 0.375rem 0.75rem;
                font-size: 0.85rem;
                color: #334155;
                font-weight: 500;
              ">
              ${String(value)}
            </div>,
          );
        }

        groupElements.push(
          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                  {groupLabel}
                </h3>
                <span style="font-size: 0.75rem; color: #64748b;">
                  Group {String(index)}
                </span>
              </div>
              <div style="
                  background: #f0fdf4;
                  border: 1px solid #86efac;
                  border-radius: 0.5rem;
                  padding: 0.5rem 1rem;
                  text-align: right;
                ">
                <div style="
                    font-size: 0.75rem;
                    color: #166534;
                    margin-bottom: 0.125rem;
                  ">
                  Subtotal
                </div>
                <div style="
                    font-size: 1.25rem;
                    font-weight: 700;
                    color: #059669;
                  ">
                  ${String(groupSubtotal)}
                </div>
              </div>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
              "
            >
              {count === 0
                ? (
                  <div style="
                      color: #94a3b8;
                      font-size: 0.85rem;
                      font-style: italic;
                    ">
                    No items in this group
                  </div>
                )
                : (
                  <div style="
                      display: flex;
                      flex-wrap: wrap;
                      gap: 0.5rem;
                    ">
                    {itemElements}
                  </div>
                )}
              <div style="
                  margin-top: 0.25rem;
                  padding-top: 0.5rem;
                  border-top: 1px solid #e2e8f0;
                  font-size: 0.75rem;
                  color: #64748b;
                ">
                {String(count)} {count === 1 ? "item" : "items"}
              </div>
            </div>
          </ct-card>,
        );
      }

      return groupElements;
    })(groups);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1rem;
            max-width: 42rem;
            padding: 0.5rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <span style="
                    color: #059669;
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                    font-weight: 600;
                  ">
                  Budget Tracker
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.4rem;
                    color: #0f172a;
                  ">
                  Nested totals with group subtotals
                </h2>
              </div>

              <div style="
                  background: linear-gradient(135deg, #059669 0%, #10b981 100%);
                  border-radius: 1rem;
                  padding: 1.5rem;
                  color: white;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: baseline;
                  ">
                  <div>
                    <div style="
                        font-size: 0.85rem;
                        opacity: 0.9;
                        margin-bottom: 0.25rem;
                      ">
                      Grand Total
                    </div>
                    <div style="font-size: 2.5rem; font-weight: 700;">
                      ${grandTotal}
                    </div>
                  </div>
                  <div style="text-align: right;">
                    <div style="font-size: 0.85rem; opacity: 0.9;">
                      {groupCount} groups
                    </div>
                    <div style="font-size: 0.85rem; opacity: 0.9;">
                      {totalItems} items
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Add new item
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
              "
            >
              <div style="
                  display: grid;
                  grid-template-columns: 1fr 2fr;
                  gap: 0.75rem;
                  align-items: end;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="value-input"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Amount ($)
                  </label>
                  <ct-input
                    id="value-input"
                    type="number"
                    step="0.01"
                    $value={valueInputField}
                    aria-label="Enter amount to add"
                  >
                  </ct-input>
                </div>

                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="group-select"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Group
                  </label>
                  <div style="display: flex; gap: 0.5rem; align-items: center;">
                    <ct-input
                      id="group-select"
                      type="number"
                      step="1"
                      min="0"
                      $value={selectedGroupIndexField}
                      aria-label="Select group index"
                      style="flex: 1;"
                    >
                    </ct-input>
                    <ct-button
                      onClick={addValueHandler}
                      aria-label="Add value to selected group"
                    >
                      Add
                    </ct-button>
                  </div>
                </div>
              </div>
            </div>
          </ct-card>

          <div style="
              display: flex;
              flex-direction: column;
              gap: 0.75rem;
            ">
            {groupsDisplay}
          </div>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="
              font-size: 0.75rem;
              color: #64748b;
              padding: 0.5rem;
              background: #f8fafc;
              border-radius: 0.5rem;
            "
          >
            {summary}
          </div>
        </div>
      ),
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
      valueInputField,
      selectedGroupIndexField,
      valueToAdd,
      addValueHandler,
    };
  },
);

export default counterWithNestedComputedTotalsUx;
