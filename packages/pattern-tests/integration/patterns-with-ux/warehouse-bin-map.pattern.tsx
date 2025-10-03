/// <cts-enable />
// @ts-nocheck
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

interface BinDefinition {
  id: string;
  capacity: number;
}

interface ItemPlacement {
  id: string;
  bin: string;
}

interface WarehouseBinMapArgs {
  bins: Default<BinDefinition[], typeof defaultBins>;
  items: Default<ItemPlacement[], typeof defaultItems>;
}

interface RelocateEvent {
  itemId?: string;
  targetBin?: string;
}

interface OccupancyEntry {
  capacity: number;
  used: number;
  available: number;
}

const defaultBins: BinDefinition[] = [
  { id: "A1", capacity: 2 },
  { id: "B2", capacity: 3 },
  { id: "C3", capacity: 1 },
];

const defaultItems: ItemPlacement[] = [
  { id: "widget-100", bin: "A1" },
  { id: "widget-200", bin: "A1" },
  { id: "widget-300", bin: "B2" },
];

const sanitizeId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toUpperCase() : null;
};

const sanitizeBins = (value: unknown): BinDefinition[] => {
  if (!Array.isArray(value)) {
    return structuredClone(defaultBins);
  }
  const seen = new Set<string>();
  const bins: BinDefinition[] = [];
  for (const entry of value) {
    const id = sanitizeId((entry as BinDefinition | undefined)?.id);
    if (!id || seen.has(id)) continue;
    const capacityValue = (entry as BinDefinition | undefined)?.capacity;
    const capacity = typeof capacityValue === "number" && capacityValue > 0
      ? Math.floor(capacityValue)
      : 1;
    seen.add(id);
    bins.push({ id, capacity });
  }
  if (bins.length === 0) {
    return structuredClone(defaultBins);
  }
  return bins;
};

const sanitizePlacementList = (
  entries: readonly ItemPlacement[] | undefined,
  bins: readonly BinDefinition[],
): ItemPlacement[] => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [];
  }
  const capacities = new Map<string, number>();
  for (const bin of bins) {
    capacities.set(bin.id, bin.capacity);
  }
  const usage = new Map<string, number>();
  const seen = new Set<string>();
  const placements: ItemPlacement[] = [];
  for (const entry of entries) {
    const id = sanitizeId(entry?.id);
    const bin = sanitizeId(entry?.bin);
    if (!id || !bin || seen.has(id) || !capacities.has(bin)) continue;
    const used = usage.get(bin) ?? 0;
    const limit = capacities.get(bin) ?? 0;
    if (used >= limit) continue;
    placements.push({ id, bin });
    usage.set(bin, used + 1);
    seen.add(id);
  }
  return placements;
};

const sanitizePlacements = (
  value: unknown,
  bins: readonly BinDefinition[],
): ItemPlacement[] => {
  const initial = sanitizePlacementList(
    Array.isArray(value) ? value as ItemPlacement[] : undefined,
    bins,
  );
  if (initial.length > 0) return initial;
  return sanitizePlacementList(defaultItems, bins);
};

const buildOccupancy = (
  bins: readonly BinDefinition[],
  placements: readonly ItemPlacement[],
): Record<string, OccupancyEntry> => {
  const counts = new Map<string, number>();
  for (const placement of placements) {
    const next = (counts.get(placement.bin) ?? 0) + 1;
    counts.set(placement.bin, next);
  }
  const occupancy: Record<string, OccupancyEntry> = {};
  for (const bin of bins) {
    const used = counts.get(bin.id) ?? 0;
    const capacity = bin.capacity;
    const available = capacity - used;
    occupancy[bin.id] = {
      capacity,
      used,
      available: available > 0 ? available : 0,
    };
  }
  return occupancy;
};

const relocateInventory = handler(
  (
    event: RelocateEvent | undefined,
    context: {
      items: Cell<ItemPlacement[]>;
      bins: Cell<BinDefinition[]>;
      placements: Cell<ItemPlacement[]>;
      history: Cell<string[]>;
    },
  ) => {
    const itemId = sanitizeId(event?.itemId);
    const targetBin = sanitizeId(event?.targetBin);
    if (!itemId || !targetBin) return;

    const bins = context.bins.get() ?? [];
    if (!bins.some((entry) => entry.id === targetBin)) return;

    const placements = context.placements.get() ?? [];
    const index = placements.findIndex((entry) => entry.id === itemId);
    if (index === -1) return;
    const currentPlacement = placements[index];
    if (currentPlacement.bin === targetBin) return;

    const capacities = new Map<string, number>();
    for (const bin of bins) {
      capacities.set(bin.id, bin.capacity);
    }
    const usage = new Map<string, number>();
    for (let i = 0; i < placements.length; i++) {
      if (i === index) continue;
      const entry = placements[i];
      usage.set(entry.bin, (usage.get(entry.bin) ?? 0) + 1);
    }

    const limit = capacities.get(targetBin) ?? 0;
    const used = usage.get(targetBin) ?? 0;
    if (used >= limit) return;

    const updated = placements.map((entry, position) => ({
      id: entry.id,
      bin: position === index ? targetBin : entry.bin,
    }));
    context.items.set(updated);

    const history = context.history.get();
    const log = Array.isArray(history) ? history : [];
    const message =
      `Moved ${itemId} from ${currentPlacement.bin} to ${targetBin}`;
    context.history.set([...log, message]);

    buildOccupancy(bins, updated);
  },
);

export const warehouseBinMapUx = recipe<WarehouseBinMapArgs>(
  "Warehouse Bin Map (UX)",
  ({ bins, items }) => {
    const binsList = lift(sanitizeBins)(bins);
    const rawItems = lift((value: ItemPlacement[] | undefined) =>
      Array.isArray(value) ? value : []
    )(items);
    const placements = lift((input: {
      entries: ItemPlacement[];
      binList: BinDefinition[];
    }) => sanitizePlacements(input.entries, input.binList))({
      entries: rawItems,
      binList: binsList,
    });

    const occupancy = lift((input: {
      binList: BinDefinition[];
      placements: ItemPlacement[];
    }) => buildOccupancy(input.binList, input.placements))({
      binList: binsList,
      placements,
    });

    const availableBins = lift((summary: Record<string, OccupancyEntry>) =>
      Object.keys(summary).filter((id) => summary[id].available > 0)
    )(occupancy);

    const totalItems = lift((list: ItemPlacement[]) => list.length)(
      placements,
    );
    const binCount = lift((list: BinDefinition[]) => list.length)(binsList);
    const status = str`${totalItems} items across ${binCount} bins`;

    const history = cell<string[]>([]);
    const lastAction = lift((entries: string[]) => {
      if (!Array.isArray(entries) || entries.length === 0) {
        return "initialized";
      }
      return entries[entries.length - 1];
    })(history);

    const relocate = relocateInventory({
      items,
      bins: binsList,
      placements,
      history,
    });

    // UI-specific state
    const itemIdField = cell<string>("");
    const targetBinField = cell<string>("");

    // UI handler for relocation
    const applyRelocation = handler(
      (
        _event: unknown,
        context: {
          itemIdField: Cell<string>;
          targetBinField: Cell<string>;
          items: Cell<ItemPlacement[]>;
          bins: Cell<BinDefinition[]>;
          placements: Cell<ItemPlacement[]>;
          history: Cell<string[]>;
        },
      ) => {
        const itemIdRaw = context.itemIdField.get();
        const targetBinRaw = context.targetBinField.get();

        const itemId = sanitizeId(itemIdRaw);
        const targetBin = sanitizeId(targetBinRaw);
        if (!itemId || !targetBin) return;

        const bins = context.bins.get() ?? [];
        if (!bins.some((entry) => entry.id === targetBin)) return;

        const placements = context.placements.get() ?? [];
        const index = placements.findIndex((entry) => entry.id === itemId);
        if (index === -1) return;
        const currentPlacement = placements[index];
        if (currentPlacement.bin === targetBin) return;

        const capacities = new Map<string, number>();
        for (const bin of bins) {
          capacities.set(bin.id, bin.capacity);
        }
        const usage = new Map<string, number>();
        for (let i = 0; i < placements.length; i++) {
          if (i === index) continue;
          const entry = placements[i];
          usage.set(entry.bin, (usage.get(entry.bin) ?? 0) + 1);
        }

        const limit = capacities.get(targetBin) ?? 0;
        const used = usage.get(targetBin) ?? 0;
        if (used >= limit) return;

        const updated = placements.map((entry, position) => ({
          id: entry.id,
          bin: position === index ? targetBin : entry.bin,
        }));
        context.items.set(updated);

        const historyLog = context.history.get();
        const log = Array.isArray(historyLog) ? historyLog : [];
        const message =
          `Moved ${itemId} from ${currentPlacement.bin} to ${targetBin}`;
        context.history.set([...log, message]);

        // Clear form fields
        context.itemIdField.set("");
        context.targetBinField.set("");
      },
    )({
      itemIdField,
      targetBinField,
      items,
      bins: binsList,
      placements,
      history,
    });

    const name = str`Warehouse bin map (${totalItems} items)`;

    const binsDisplay = lift((
      input: { bins: BinDefinition[]; occ: Record<string, OccupancyEntry> },
    ) => {
      const elements = [];
      for (const bin of input.bins) {
        const entry = input.occ[bin.id];
        if (!entry) continue;

        const utilization = entry.capacity > 0
          ? Math.round((entry.used / entry.capacity) * 100)
          : 0;

        const bgColor = utilization >= 100
          ? "#fef2f2"
          : utilization >= 80
          ? "#fefce8"
          : "#f0fdf4";
        const borderColor = utilization >= 100
          ? "#ef4444"
          : utilization >= 80
          ? "#f59e0b"
          : "#22c55e";
        const statusColor = utilization >= 100
          ? "#b91c1c"
          : utilization >= 80
          ? "#d97706"
          : "#16a34a";

        const statusText = utilization >= 100
          ? "FULL"
          : utilization >= 80
          ? "NEARLY FULL"
          : "AVAILABLE";

        const cardStyle =
          "display: flex; flex-direction: column; gap: 0.75rem; " +
          "padding: 1rem; border-radius: 0.5rem; " +
          "background: " + bgColor + "; " +
          "border: 2px solid " + borderColor + ";";

        const headerStyle =
          "display: flex; justify-content: space-between; align-items: center;";

        const binIdStyle =
          "font-size: 1.25rem; font-weight: 700; color: #0f172a; " +
          "font-family: 'Courier New', monospace;";

        const statusBadgeStyle =
          "font-size: 0.65rem; font-weight: 700; letter-spacing: 0.08em; " +
          "padding: 0.25rem 0.5rem; border-radius: 0.25rem; " +
          "background: " + statusColor + "; color: white;";

        const statsStyle =
          "display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem;";

        const statStyle =
          "display: flex; flex-direction: column; gap: 0.125rem;";

        const statLabelStyle =
          "font-size: 0.7rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em;";

        const statValueStyle =
          "font-size: 1rem; font-weight: 600; color: #0f172a;";

        const progressBarOuterStyle =
          "height: 0.375rem; background: #e2e8f0; border-radius: 0.25rem; overflow: hidden;";

        const progressBarInnerStyle = "height: 100%; background: " +
          statusColor + "; " +
          "width: " + String(utilization) + "%; " +
          "transition: width 0.3s ease;";

        elements.push(
          h("div", { style: cardStyle }, [
            h("div", { style: headerStyle }, [
              h("span", { style: binIdStyle }, bin.id),
              h("span", { style: statusBadgeStyle }, statusText),
            ]),
            h("div", { style: statsStyle }, [
              h("div", { style: statStyle }, [
                h("span", { style: statLabelStyle }, "Capacity"),
                h("span", { style: statValueStyle }, String(entry.capacity)),
              ]),
              h("div", { style: statStyle }, [
                h("span", { style: statLabelStyle }, "Used"),
                h("span", { style: statValueStyle }, String(entry.used)),
              ]),
              h("div", { style: statStyle }, [
                h("span", { style: statLabelStyle }, "Available"),
                h("span", { style: statValueStyle }, String(entry.available)),
              ]),
            ]),
            h("div", { style: progressBarOuterStyle }, [
              h("div", { style: progressBarInnerStyle }),
            ]),
          ]),
        );
      }

      return h(
        "div",
        {
          style:
            "display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem;",
        },
        ...elements,
      );
    })({ bins: binsList, occ: occupancy });

    const itemsDisplay = lift((
      input: {
        placements: ItemPlacement[];
        occ: Record<string, OccupancyEntry>;
      },
    ) => {
      const elements = [];
      for (let i = 0; i < input.placements.length; i++) {
        const item = input.placements[i];

        const rowBg = i % 2 === 0 ? "#ffffff" : "#f8fafc";
        const itemStyle =
          "display: flex; justify-content: space-between; align-items: center; " +
          "padding: 0.75rem 1rem; background: " + rowBg + "; " +
          "border-bottom: 1px solid #e2e8f0;";

        const itemIdStyle =
          "font-family: 'Courier New', monospace; font-weight: 500; color: #0f172a;";

        const binBadgeStyle =
          "font-family: 'Courier New', monospace; font-weight: 700; " +
          "font-size: 0.875rem; padding: 0.25rem 0.75rem; " +
          "background: #dbeafe; color: #1e40af; border-radius: 0.375rem;";

        elements.push(
          h("div", { style: itemStyle }, [
            h("span", { style: itemIdStyle }, item.id),
            h("span", { style: binBadgeStyle }, item.bin),
          ]),
        );
      }

      if (elements.length === 0) {
        const emptyStyle =
          "padding: 2rem; text-align: center; color: #94a3b8; " +
          "background: #f8fafc; border-radius: 0.5rem; border: 2px dashed #cbd5e1;";
        return h("div", { style: emptyStyle }, "No items in warehouse");
      }

      return h(
        "div",
        {
          style:
            "border: 1px solid #e2e8f0; border-radius: 0.5rem; overflow: hidden;",
        },
        ...elements,
      );
    })({ placements, occ: occupancy });

    const historyDisplay = lift((entries: string[]) => {
      const elements = [];
      const recent = entries.slice().reverse().slice(0, 6);

      for (let i = 0; i < recent.length; i++) {
        const entry = recent[i];
        const entryStyle =
          "padding: 0.5rem 0.75rem; border-left: 3px solid #3b82f6; " +
          "background: #eff6ff; font-size: 0.85rem; color: #334155; " +
          "border-radius: 0.25rem;";
        elements.push(h("div", { style: entryStyle }, entry));
      }

      if (elements.length === 0) {
        const emptyStyle =
          "padding: 1rem; text-align: center; color: #94a3b8; " +
          "font-size: 0.875rem; font-style: italic;";
        return h("div", { style: emptyStyle }, "No relocations yet");
      }

      return h(
        "div",
        { style: "display: flex; flex-direction: column; gap: 0.5rem;" },
        ...elements,
      );
    })(history);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 56rem;
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
                    color: #475569;
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                  ">
                  Warehouse Management
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.5rem;
                    color: #0f172a;
                  ">
                  Bin occupancy tracker
                </h2>
              </div>

              <div style="
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  color: white;
                  padding: 1.25rem;
                  border-radius: 0.75rem;
                  display: flex;
                  justify-content: space-between;
                  align-items: center;
                ">
                <div>
                  <div style="font-size: 0.875rem; opacity: 0.9;">
                    Total items
                  </div>
                  <div style="font-size: 2rem; font-weight: 700;">
                    {totalItems}
                  </div>
                </div>
                <div>
                  <div style="font-size: 0.875rem; opacity: 0.9;">
                    Total bins
                  </div>
                  <div style="font-size: 2rem; font-weight: 700;">
                    {binCount}
                  </div>
                </div>
                <div>
                  <div style="font-size: 0.875rem; opacity: 0.9;">
                    Available bins
                  </div>
                  <div style="font-size: 2rem; font-weight: 700;">
                    {availableBins}
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
              <h3 style="margin: 0; font-size: 1.125rem; color: #0f172a;">
                Bin status
              </h3>
            </div>
            <div slot="content">
              {binsDisplay}
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
              <h3 style="margin: 0; font-size: 1.125rem; color: #0f172a;">
                Current inventory
              </h3>
            </div>
            <div slot="content">
              {itemsDisplay}
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
              <h3 style="margin: 0; font-size: 1.125rem; color: #0f172a;">
                Relocate item
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <div style="
                  display: grid;
                  grid-template-columns: repeat(2, minmax(0, 1fr));
                  gap: 1rem;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="item-id"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Item ID
                  </label>
                  <ct-input
                    id="item-id"
                    type="text"
                    placeholder="e.g., WIDGET-100"
                    $value={itemIdField}
                    aria-label="Enter the item ID to relocate"
                  >
                  </ct-input>
                </div>
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="target-bin"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Target bin
                  </label>
                  <ct-input
                    id="target-bin"
                    type="text"
                    placeholder="e.g., B2"
                    $value={targetBinField}
                    aria-label="Enter the target bin ID"
                  >
                  </ct-input>
                </div>
              </div>
              <ct-button onClick={applyRelocation}>
                Relocate item
              </ct-button>
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
              <h3 style="margin: 0; font-size: 1.125rem; color: #0f172a;">
                Recent activity
              </h3>
            </div>
            <div slot="content">
              {historyDisplay}
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.875rem; color: #64748b; font-style: italic;"
          >
            Last action: {lastAction}
          </div>
        </div>
      ),
      bins: binsList,
      items,
      placements,
      occupancy,
      availableBins,
      status,
      history,
      lastAction,
      relocate,
      itemIdField,
      targetBinField,
      applyRelocation,
    };
  },
);

export default warehouseBinMapUx;
