/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface ContributionItemSeed {
  label?: string;
  value?: number;
}

interface ContributionGroupSeed {
  label?: string;
  items?: ContributionItemSeed[];
}

interface NestedComputedPercentagesArgs {
  groups: Default<ContributionGroupSeed[], []>;
}

interface SanitizedContributionItem {
  label: string;
  value: number;
}

interface SanitizedContributionGroup {
  label: string;
  items: SanitizedContributionItem[];
  total: number;
}

const sanitizeNumber = (raw: unknown): number => {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return 0;
  }
  return Math.round(raw * 100) / 100;
};

const sanitizeIndex = (raw: unknown): number => {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return -1;
  }
  const index = Math.trunc(raw);
  return index < 0 ? -1 : index;
};

const sanitizeLabel = (raw: unknown, fallback: string): string => {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return fallback;
};

const sanitizeGroups = (
  value: ContributionGroupSeed[] | undefined,
): SanitizedContributionGroup[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const sanitized: SanitizedContributionGroup[] = [];
  for (let groupIndex = 0; groupIndex < value.length; groupIndex++) {
    const group = value[groupIndex];
    const label = sanitizeLabel(group?.label, `Group ${groupIndex + 1}`);
    const rawItems = Array.isArray(group?.items) ? group.items : [];
    const items: SanitizedContributionItem[] = [];
    for (let itemIndex = 0; itemIndex < rawItems.length; itemIndex++) {
      const item = rawItems[itemIndex];
      const itemLabel = sanitizeLabel(
        item?.label,
        `Item ${itemIndex + 1}`,
      );
      items.push({
        label: itemLabel,
        value: sanitizeNumber(item?.value),
      });
    }
    const total = items.reduce((sum, item) => sum + item.value, 0);
    sanitized.push({ label, items, total });
  }
  return sanitized;
};

const calculatePercent = (value: number, total: number): number => {
  if (total <= 0) {
    return 0;
  }
  const ratio = (value / total) * 100;
  return Math.round(ratio * 100) / 100;
};

const addGroup = handler(
  (_event: unknown, context: { groups: Cell<ContributionGroupSeed[]> }) => {
    const current = context.groups.get() ?? [];
    const newGroups = [...current, {
      label: `Group ${current.length + 1}`,
      items: [],
    }];
    context.groups.set(newGroups);
  },
);

const addItem = handler(
  (_event: unknown, context: {
    groups: Cell<ContributionGroupSeed[]>;
    groupIndexField: Cell<string>;
    itemValueField: Cell<string>;
  }) => {
    const groupIndexText = context.groupIndexField.get() || "0";
    const groupIndex = Number(groupIndexText);
    const sanitizedGroupIndex = Number.isFinite(groupIndex)
      ? Math.trunc(groupIndex)
      : 0;

    const groupsValue = context.groups.get();
    if (
      !Array.isArray(groupsValue) ||
      sanitizedGroupIndex < 0 ||
      sanitizedGroupIndex >= groupsValue.length
    ) {
      return;
    }

    const valueText = context.itemValueField.get() || "0";
    const value = Number(valueText);
    const sanitizedValue = Number.isFinite(value) ? value : 0;

    const groupCell = context.groups.key(sanitizedGroupIndex) as Cell<
      ContributionGroupSeed
    >;
    const itemsCell = groupCell.key("items") as Cell<ContributionItemSeed[]>;
    const current = itemsCell.get();
    const items = Array.isArray(current) ? [...current] : [];
    items.push({ value: sanitizedValue });
    itemsCell.set(items);

    // Reset the value field
    context.itemValueField.set("0");
  },
);

export const counterWithNestedComputedPercentagesUx = recipe<
  NestedComputedPercentagesArgs
>(
  "Counter With Nested Computed Percentages (UX)",
  ({ groups }) => {
    const sanitizedGroups = lift(sanitizeGroups)(groups);

    const grandTotal = lift((entries: SanitizedContributionGroup[]) => {
      return entries.reduce((sum, group) => sum + group.total, 0);
    })(sanitizedGroups);

    const groupBreakdown = lift(
      (
        state: {
          groups: SanitizedContributionGroup[];
          total: number;
        },
      ) => {
        const breakdown: Array<{
          label: string;
          total: number;
          percentOfTotal: number;
          items: Array<{
            label: string;
            value: number;
            percentOfGroup: number;
            percentOfTotal: number;
          }>;
        }> = [];
        for (const group of state.groups) {
          const percentOfTotal = calculatePercent(group.total, state.total);
          const items: Array<{
            label: string;
            value: number;
            percentOfGroup: number;
            percentOfTotal: number;
          }> = [];
          for (const item of group.items) {
            const percentOfGroup = calculatePercent(item.value, group.total);
            const percentItemTotal = calculatePercent(item.value, state.total);
            items.push({
              label: item.label,
              value: item.value,
              percentOfGroup,
              percentOfTotal: percentItemTotal,
            });
          }
          breakdown.push({
            label: group.label,
            total: group.total,
            percentOfTotal,
            items,
          });
        }
        return breakdown;
      },
    )({ groups: sanitizedGroups, total: grandTotal });

    const name = str`Budget: ${grandTotal}`;

    const groupIndexField = cell<string>("0");
    const itemValueField = cell<string>("0");

    const addGroupHandler = addGroup({ groups });
    const addItemHandler = addItem({ groups, groupIndexField, itemValueField });

    const groupsDisplay = lift((
      breakdown: typeof groupBreakdown extends Cell<
        infer T
      > ? T
        : never,
    ) => {
      if (breakdown.length === 0) {
        return (
          <div style="
              text-align: center;
              padding: 2rem;
              color: #64748b;
              font-style: italic;
            ">
            No groups yet. Click "Add Group" to get started.
          </div>
        );
      }

      const groupElements = [];
      for (let groupIndex = 0; groupIndex < breakdown.length; groupIndex++) {
        const group = breakdown[groupIndex];
        const itemElements = [];

        for (let itemIndex = 0; itemIndex < group.items.length; itemIndex++) {
          const item = group.items[itemIndex];
          const bgColor = itemIndex % 2 === 0 ? "#f8fafc" : "#ffffff";

          itemElements.push(
            <div
              style={"background: " + bgColor +
                "; border-radius: 0.5rem; padding: 0.75rem; display: flex; gap: 1rem; align-items: center; border-bottom: 1px solid #e2e8f0;"}
            >
              <span style="flex: 1; font-weight: 500; color: #0f172a;">
                {item.label}
              </span>
              <span style="
                  background: #dbeafe;
                  color: #1e40af;
                  padding: 0.25rem 0.75rem;
                  border-radius: 1rem;
                  font-size: 0.85rem;
                  font-weight: 600;
                  font-family: monospace;
                  min-width: 60px;
                  text-align: center;
                ">
                {String(item.value)}
              </span>
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.125rem;
                  min-width: 110px;
                  font-size: 0.75rem;
                  color: #64748b;
                ">
                <div>
                  <strong>{String(item.percentOfGroup)}%</strong> of group
                </div>
                <div>
                  <strong>{String(item.percentOfTotal)}%</strong> of total
                </div>
              </div>
            </div>,
          );
        }

        groupElements.push(
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
                  background: linear-gradient(135deg, #fef3c7, #fde68a);
                  padding: 1rem;
                  border-radius: 0.5rem;
                ">
                <div style="
                    font-size: 1.1rem;
                    font-weight: 600;
                    color: #78350f;
                    margin-bottom: 0.5rem;
                  ">
                  {group.label}
                </div>
                <div style="
                    display: flex;
                    gap: 1.5rem;
                    font-size: 0.875rem;
                    color: #92400e;
                  ">
                  <span>
                    Group Total:{" "}
                    <strong style="font-family: monospace;">
                      {String(group.total)}
                    </strong>
                  </span>
                  <span>
                    <strong>{String(group.percentOfTotal)}%</strong>{" "}
                    of grand total
                  </span>
                </div>
              </div>

              {itemElements.length > 0
                ? (
                  <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                    border-radius: 0.5rem;
                    overflow: hidden;
                  ">
                    {itemElements}
                  </div>
                )
                : (
                  <div style="
                    text-align: center;
                    padding: 1.5rem;
                    color: #94a3b8;
                    font-size: 0.9rem;
                    font-style: italic;
                  ">
                    No items in this group yet.
                  </div>
                )}
            </div>
          </ct-card>,
        );
      }

      return groupElements;
    })(groupBreakdown);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 50rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1.25rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <span style="
                    color: #475569;
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                  ">
                  Budget Tracker
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Track contributions across groups with nested percentages
                </h2>
              </div>

              <div style="
                  background: linear-gradient(135deg, #f0f9ff, #e0f2fe);
                  border-radius: 0.75rem;
                  padding: 1.5rem;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 1rem;
                  ">
                  <div>
                    <div style="
                        font-size: 0.875rem;
                        color: #0369a1;
                        font-weight: 500;
                        text-transform: uppercase;
                        letter-spacing: 0.05em;
                      ">
                      Grand Total
                    </div>
                    <div style="
                        font-size: 2.5rem;
                        font-weight: 700;
                        color: #075985;
                        font-family: monospace;
                      ">
                      {grandTotal}
                    </div>
                  </div>
                  <ct-button onClick={addGroupHandler} aria-label="Add Group">
                    + Add Group
                  </ct-button>
                </div>

                <div style="
                    background: white;
                    border-radius: 0.5rem;
                    padding: 1rem;
                    display: flex;
                    gap: 0.75rem;
                    align-items: flex-end;
                  ">
                  <div style="flex: 1; display: flex; flex-direction: column; gap: 0.4rem;">
                    <label style="font-size: 0.875rem; font-weight: 500; color: #334155;">
                      Group Index
                    </label>
                    <ct-input
                      type="number"
                      $value={groupIndexField}
                      placeholder="0"
                      style="width: 100%;"
                      aria-label="Group index"
                    />
                  </div>
                  <div style="flex: 1; display: flex; flex-direction: column; gap: 0.4rem;">
                    <label style="font-size: 0.875rem; font-weight: 500; color: #334155;">
                      Item Value
                    </label>
                    <ct-input
                      type="number"
                      $value={itemValueField}
                      placeholder="0"
                      style="width: 100%;"
                      aria-label="Item value"
                    />
                  </div>
                  <ct-button onClick={addItemHandler} aria-label="Add Item">
                    + Add Item
                  </ct-button>
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 1rem;
                ">
                {groupsDisplay}
              </div>

              <div style="
                  background: #f8fafc;
                  border-radius: 0.5rem;
                  padding: 1rem;
                  font-size: 0.85rem;
                  color: #475569;
                  line-height: 1.5;
                ">
                <strong>Pattern:</strong>{" "}
                This demonstrates nested computed percentages where each item
                shows both its percentage within its group and its percentage of
                the grand total. Groups automatically compute their totals, and
                the grand total updates reactively as you modify values. Use the
                form above to add items to specific groups by index.
              </div>
            </div>
          </ct-card>
        </div>
      ),
      groups,
      sanitizedGroups,
      grandTotal,
      groupBreakdown,
    };
  },
);

export default counterWithNestedComputedPercentagesUx;
