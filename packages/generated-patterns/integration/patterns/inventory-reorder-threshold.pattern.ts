/// <cts-enable />
import { type Cell, Default, handler, lift, recipe, str } from "commontools";

interface InventoryEntry {
  sku: string;
  stock: number;
  reorderLevel: number;
}

interface InventoryReorderArgs {
  inventory: Default<InventoryEntry[], typeof defaultInventory>;
}

interface StockChangeEvent {
  sku?: string;
  quantity?: number;
}

interface ThresholdChangeEvent {
  sku?: string;
  threshold?: number;
}

interface LowStockReportEntry extends InventoryEntry {
  recommendedOrder: number;
}

const defaultInventory: InventoryEntry[] = [
  { sku: "WIDGET-ALPHA", stock: 12, reorderLevel: 5 },
  { sku: "WIDGET-BETA", stock: 4, reorderLevel: 6 },
  { sku: "WIDGET-GAMMA", stock: 9, reorderLevel: 4 },
];

const sanitizeSku = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toUpperCase();
};

const toNonNegativeInteger = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const integer = Math.floor(value);
  return integer >= 0 ? integer : null;
};

const toPositiveInteger = (value: unknown): number | null => {
  const integer = toNonNegativeInteger(value);
  if (integer === null || integer === 0) return null;
  return integer;
};

const cloneInventory = (
  entries: readonly InventoryEntry[],
): InventoryEntry[] => entries.map((entry) => ({ ...entry }));

const sanitizeInventoryEntry = (
  value: unknown,
): InventoryEntry | null => {
  const source = value as InventoryEntry | undefined;
  const sku = sanitizeSku(source?.sku);
  if (!sku) return null;
  const stock = toNonNegativeInteger(source?.stock) ?? 0;
  const reorderLevel = toNonNegativeInteger(source?.reorderLevel) ?? 0;
  return { sku, stock, reorderLevel };
};

const sanitizeInventoryList = (value: unknown): InventoryEntry[] => {
  if (!Array.isArray(value)) {
    return cloneInventory(defaultInventory);
  }
  const seen = new Set<string>();
  const sanitized: InventoryEntry[] = [];
  for (const raw of value) {
    const entry = sanitizeInventoryEntry(raw);
    if (!entry || seen.has(entry.sku)) continue;
    sanitized.push(entry);
    seen.add(entry.sku);
  }
  if (sanitized.length === 0) {
    return cloneInventory(defaultInventory);
  }
  return sanitized;
};

const receiveShipment = handler(
  (
    event: StockChangeEvent | undefined,
    context: { inventory: Cell<InventoryEntry[]> },
  ) => {
    const sku = sanitizeSku(event?.sku);
    const quantity = toPositiveInteger(event?.quantity);
    if (!sku || quantity === null) return;

    const current = sanitizeInventoryList(context.inventory.get());
    let mutated = false;
    const updated = current.map((entry) => {
      if (entry.sku !== sku) return entry;
      mutated = true;
      return { ...entry, stock: entry.stock + quantity };
    });
    if (!mutated) return;
    context.inventory.set(updated);
  },
);

const recordSale = handler(
  (
    event: StockChangeEvent | undefined,
    context: { inventory: Cell<InventoryEntry[]> },
  ) => {
    const sku = sanitizeSku(event?.sku);
    const quantity = toPositiveInteger(event?.quantity);
    if (!sku || quantity === null) return;

    const current = sanitizeInventoryList(context.inventory.get());
    let mutated = false;
    const updated = current.map((entry) => {
      if (entry.sku !== sku) return entry;
      const nextStock = entry.stock - quantity;
      mutated = entry.stock !== nextStock;
      return { ...entry, stock: nextStock > 0 ? nextStock : 0 };
    });
    if (!mutated) return;
    context.inventory.set(updated);
  },
);

const updateThreshold = handler(
  (
    event: ThresholdChangeEvent | undefined,
    context: { inventory: Cell<InventoryEntry[]> },
  ) => {
    const sku = sanitizeSku(event?.sku);
    const threshold = toNonNegativeInteger(event?.threshold);
    if (!sku || threshold === null) return;

    const current = sanitizeInventoryList(context.inventory.get());
    let mutated = false;
    const updated = current.map((entry) => {
      if (entry.sku !== sku) return entry;
      if (entry.reorderLevel === threshold) return entry;
      mutated = true;
      return { ...entry, reorderLevel: threshold };
    });
    if (!mutated) return;
    context.inventory.set(updated);
  },
);

export const inventoryReorderThreshold = recipe<InventoryReorderArgs>(
  "Inventory Reorder Threshold",
  ({ inventory }) => {
    const inventoryView = lift(sanitizeInventoryList)(inventory);
    const lowStockEntries = lift((entries: InventoryEntry[]) =>
      entries.filter((entry) => entry.stock <= entry.reorderLevel)
    )(inventoryView);
    const lowStockSkus = lift((entries: InventoryEntry[]) =>
      entries.map((entry) => entry.sku)
    )(lowStockEntries);
    const lowStockReport = lift((entries: InventoryEntry[]) =>
      entries.map((entry) => ({
        sku: entry.sku,
        stock: entry.stock,
        reorderLevel: entry.reorderLevel,
        recommendedOrder: entry.reorderLevel - entry.stock + 1,
      }))
    )(lowStockEntries);
    const alertCount = lift((entries: InventoryEntry[]) => entries.length)(
      lowStockEntries,
    );
    const needsAttention = lift((count: number) => count > 0)(alertCount);
    const alertLabel = str`${alertCount} items below reorder threshold`;
    const alertMessage = lift((skus: string[]) => {
      if (skus.length === 0) return "All items healthy";
      return `Reorder needed for ${skus.join(", ")}`;
    })(lowStockSkus);

    return {
      inventory,
      inventoryView,
      lowStockEntries,
      lowStockSkus,
      lowStockReport,
      alertCount,
      needsAttention,
      alertLabel,
      alertMessage,
      receiveShipment: receiveShipment({ inventory }),
      recordSale: recordSale({ inventory }),
      setThreshold: updateThreshold({ inventory }),
    };
  },
);

export type { InventoryEntry, InventoryReorderArgs, LowStockReportEntry };
