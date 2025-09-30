/// <cts-enable />
import {
  Cell,
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

    // UI cells
    const skuField = cell<string>("");
    const quantityField = cell<string>("");
    const thresholdField = cell<string>("");
    const actionType = cell<string>("receive");

    // UI handlers
    const receiveHandler = handler(
      (
        _event: unknown,
        context: {
          skuField: Cell<string>;
          quantityField: Cell<string>;
          inventory: Cell<InventoryEntry[]>;
        },
      ) => {
        const skuStr = context.skuField.get();
        const qtyStr = context.quantityField.get();

        const sku = sanitizeSku(skuStr);
        const quantity = toPositiveInteger(
          typeof qtyStr === "string" && qtyStr.trim() !== ""
            ? parseFloat(qtyStr)
            : null,
        );

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
        context.skuField.set("");
        context.quantityField.set("");
      },
    );

    const saleHandler = handler(
      (
        _event: unknown,
        context: {
          skuField: Cell<string>;
          quantityField: Cell<string>;
          inventory: Cell<InventoryEntry[]>;
        },
      ) => {
        const skuStr = context.skuField.get();
        const qtyStr = context.quantityField.get();

        const sku = sanitizeSku(skuStr);
        const quantity = toPositiveInteger(
          typeof qtyStr === "string" && qtyStr.trim() !== ""
            ? parseFloat(qtyStr)
            : null,
        );

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
        context.skuField.set("");
        context.quantityField.set("");
      },
    );

    const thresholdHandler = handler(
      (
        _event: unknown,
        context: {
          skuField: Cell<string>;
          thresholdField: Cell<string>;
          inventory: Cell<InventoryEntry[]>;
        },
      ) => {
        const skuStr = context.skuField.get();
        const threshStr = context.thresholdField.get();

        const sku = sanitizeSku(skuStr);
        const threshold = toNonNegativeInteger(
          typeof threshStr === "string" && threshStr.trim() !== ""
            ? parseFloat(threshStr)
            : null,
        );

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
        context.skuField.set("");
        context.thresholdField.set("");
      },
    );

    const receiveAction = receiveHandler({
      skuField,
      quantityField,
      inventory,
    });

    const saleAction = saleHandler({
      skuField,
      quantityField,
      inventory,
    });

    const thresholdAction = thresholdHandler({
      skuField,
      thresholdField,
      inventory,
    });

    // Inventory display
    const inventoryDisplay = lift((entries: InventoryEntry[]) => {
      const elements = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const isLowStock = entry.stock <= entry.reorderLevel;
        const bg = isLowStock ? "#fef3c7" : "#f0fdf4";
        const borderColor = isLowStock ? "#f59e0b" : "#22c55e";
        const statusColor = isLowStock ? "#dc2626" : "#16a34a";
        const statusLabel = isLowStock ? "LOW STOCK" : "OK";

        elements.push(
          h(
            "div",
            {
              style: "padding: 16px; background: " + bg +
                "; border-left: 4px solid " + borderColor +
                "; margin-bottom: 12px; border-radius: 8px;",
            },
            h(
              "div",
              {
                style:
                  "display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;",
              },
              h("div", {
                style:
                  "font-family: monospace; font-size: 16px; font-weight: 700; color: #0f172a;",
              }, entry.sku),
              h("div", {
                style: "font-size: 11px; font-weight: 700; color: " +
                  statusColor +
                  "; padding: 4px 8px; background: white; border-radius: 4px;",
              }, statusLabel),
            ),
            h(
              "div",
              {
                style:
                  "display: grid; grid-template-columns: 1fr 1fr; gap: 12px; font-size: 14px;",
              },
              h(
                "div",
                {},
                h("div", {
                  style: "color: #64748b; font-size: 12px; margin-bottom: 2px;",
                }, "Current Stock"),
                h("div", {
                  style:
                    "font-family: monospace; font-weight: 600; color: #1e293b;",
                }, String(entry.stock)),
              ),
              h(
                "div",
                {},
                h("div", {
                  style: "color: #64748b; font-size: 12px; margin-bottom: 2px;",
                }, "Reorder Level"),
                h("div", {
                  style:
                    "font-family: monospace; font-weight: 600; color: #1e293b;",
                }, String(entry.reorderLevel)),
              ),
            ),
          ),
        );
      }

      return h("div", {}, ...elements);
    })(inventoryView);

    // Low stock alert display
    const lowStockDisplay = lift((entries: LowStockReportEntry[]) => {
      if (entries.length === 0) {
        return h("div", {
          style:
            "padding: 20px; text-align: center; background: #f0fdf4; border: 2px solid #22c55e; border-radius: 8px; color: #16a34a; font-weight: 600;",
        }, "✓ All inventory levels healthy");
      }

      const elements = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];

        elements.push(
          h(
            "div",
            {
              style:
                "padding: 12px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px; margin-bottom: 8px;",
            },
            h(
              "div",
              {
                style:
                  "display: flex; justify-content: space-between; align-items: center;",
              },
              h("div", {
                style:
                  "font-family: monospace; font-weight: 700; color: #dc2626;",
              }, entry.sku),
              h("div", {
                style:
                  "font-size: 12px; font-weight: 600; color: #991b1b; background: white; padding: 4px 8px; border-radius: 4px;",
              }, "Order " + String(entry.recommendedOrder)),
            ),
            h(
              "div",
              {
                style:
                  "margin-top: 6px; font-size: 13px; color: #7f1d1d; display: flex; gap: 16px;",
              },
              h("span", {}, "Stock: " + String(entry.stock)),
              h(
                "span",
                {},
                "Threshold: " + String(entry.reorderLevel),
              ),
            ),
          ),
        );
      }

      return h("div", {}, ...elements);
    })(lowStockReport);

    const name = lift(
      (input: { count: number; message: string }) =>
        "Inventory (" + String(input.count) + " alerts) - " + input.message,
    )({ count: alertCount, message: alertMessage });

    const ui = (
      <div
        style={{
          fontFamily: "system-ui, sans-serif",
          maxWidth: "800px",
          margin: "0 auto",
          padding: "20px",
          background: "linear-gradient(135deg, #0f766e 0%, #06b6d4 100%)",
          minHeight: "100vh",
        }}
      >
        <div
          style={{
            background: "white",
            borderRadius: "12px",
            padding: "24px",
            boxShadow: "0 4px 6px rgba(0,0,0,0.1)",
          }}
        >
          <h1
            style={{
              margin: "0 0 8px 0",
              fontSize: "28px",
              fontWeight: "700",
              color: "#0f172a",
            }}
          >
            📦 Inventory Manager
          </h1>
          <p
            style={{
              margin: "0 0 24px 0",
              fontSize: "14px",
              color: "#64748b",
              lineHeight: "1.5",
            }}
          >
            Track stock levels and manage reorder thresholds
          </p>

          <div
            style={{
              marginBottom: "24px",
              padding: "16px",
              background: lift(
                (needsAlert: boolean) =>
                  needsAlert
                    ? "linear-gradient(135deg, #fee2e2 0%, #fecaca 100%)"
                    : "linear-gradient(135deg, #dcfce7 0%, #bbf7d0 100%)",
              )(needsAttention),
              borderRadius: "8px",
              border: lift(
                (needsAlert: boolean) =>
                  needsAlert ? "2px solid #dc2626" : "2px solid #22c55e",
              )(needsAttention),
            }}
          >
            <div
              style={{
                fontSize: "12px",
                fontWeight: "600",
                color: "#64748b",
                marginBottom: "4px",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
              }}
            >
              Alert Status
            </div>
            <div
              style={{
                fontSize: "20px",
                fontWeight: "700",
                color: lift(
                  (needsAlert: boolean) => needsAlert ? "#dc2626" : "#16a34a",
                )(needsAttention),
              }}
            >
              {alertMessage}
            </div>
          </div>

          <div style={{ marginBottom: "24px" }}>
            <h2
              style={{
                margin: "0 0 12px 0",
                fontSize: "18px",
                fontWeight: "600",
                color: "#334155",
              }}
            >
              Low Stock Alerts
            </h2>
            {lowStockDisplay}
          </div>

          <div style={{ marginBottom: "24px" }}>
            <h2
              style={{
                margin: "0 0 12px 0",
                fontSize: "18px",
                fontWeight: "600",
                color: "#334155",
              }}
            >
              Current Inventory
            </h2>
            {inventoryDisplay}
          </div>

          <div
            style={{
              marginTop: "24px",
              padding: "20px",
              background: "#f8fafc",
              borderRadius: "8px",
            }}
          >
            <h2
              style={{
                margin: "0 0 16px 0",
                fontSize: "18px",
                fontWeight: "600",
                color: "#334155",
              }}
            >
              Inventory Actions
            </h2>

            <div style={{ display: "grid", gap: "16px" }}>
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: "13px",
                    fontWeight: "500",
                    color: "#475569",
                    marginBottom: "4px",
                  }}
                >
                  SKU (e.g., WIDGET-ALPHA)
                </label>
                <ct-input
                  $value={skuField}
                  placeholder="WIDGET-ALPHA"
                  style="width: 100%; padding: 10px; border: 2px solid #cbd5e1; border-radius: 6px; font-size: 14px; font-family: monospace;"
                />
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "12px",
                }}
              >
                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: "13px",
                      fontWeight: "500",
                      color: "#475569",
                      marginBottom: "4px",
                    }}
                  >
                    Quantity
                  </label>
                  <ct-input
                    $value={quantityField}
                    placeholder="10"
                    style="width: 100%; padding: 10px; border: 2px solid #cbd5e1; border-radius: 6px; font-size: 14px; font-family: monospace;"
                  />
                </div>

                <div>
                  <label
                    style={{
                      display: "block",
                      fontSize: "13px",
                      fontWeight: "500",
                      color: "#475569",
                      marginBottom: "4px",
                    }}
                  >
                    Reorder Threshold
                  </label>
                  <ct-input
                    $value={thresholdField}
                    placeholder="5"
                    style="width: 100%; padding: 10px; border: 2px solid #cbd5e1; border-radius: 6px; font-size: 14px; font-family: monospace;"
                  />
                </div>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr",
                  gap: "12px",
                }}
              >
                <ct-button
                  onClick={receiveAction}
                  style={{
                    padding: "12px 16px",
                    background: "#0f766e",
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "14px",
                    fontWeight: "600",
                    cursor: "pointer",
                  }}
                >
                  📥 Receive
                </ct-button>
                <ct-button
                  onClick={saleAction}
                  style={{
                    padding: "12px 16px",
                    background: "#dc2626",
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "14px",
                    fontWeight: "600",
                    cursor: "pointer",
                  }}
                >
                  📤 Sale
                </ct-button>
                <ct-button
                  onClick={thresholdAction}
                  style={{
                    padding: "12px 16px",
                    background: "#7c3aed",
                    color: "white",
                    border: "none",
                    borderRadius: "6px",
                    fontSize: "14px",
                    fontWeight: "600",
                    cursor: "pointer",
                  }}
                >
                  ⚙️ Set Threshold
                </ct-button>
              </div>

              <p
                style={{
                  marginTop: "8px",
                  fontSize: "12px",
                  color: "#64748b",
                  lineHeight: "1.5",
                }}
              >
                <strong>Receive:</strong> Add stock to inventory •{" "}
                <strong>Sale:</strong> Remove stock (deduct qty) •{" "}
                <strong>Set Threshold:</strong> Update reorder level
              </p>
            </div>
          </div>
        </div>
      </div>
    );

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
      [NAME]: name,
      [UI]: ui,
    };
  },
);

export type { InventoryEntry, InventoryReorderArgs, LowStockReportEntry };
