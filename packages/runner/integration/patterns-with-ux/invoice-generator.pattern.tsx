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

interface InvoiceItemInput {
  id?: string;
  description?: string;
  quantity?: number;
  unitPrice?: number;
  itemDiscountRate?: number;
}

interface InvoiceItem {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  itemDiscountRate: number;
}

interface InvoiceLineSummary extends InvoiceItem {
  baseTotal: number;
  itemDiscountAmount: number;
  lineTotal: number;
}

interface InvoiceTotals {
  subtotal: number;
  itemDiscountTotal: number;
  invoiceDiscountRate: number;
  invoiceDiscountAmount: number;
  discountedSubtotal: number;
  taxRate: number;
  taxAmount: number;
  totalDue: number;
}

interface InvoiceGeneratorArgs {
  items: Default<InvoiceItemInput[], typeof defaultItems>;
  taxRate: Default<number, 0.0725>;
  invoiceDiscountRate: Default<number, 0.05>;
}

const defaultItems: InvoiceItemInput[] = [
  {
    id: "design-services",
    description: "Design sprint and prototyping",
    quantity: 12,
    unitPrice: 120,
    itemDiscountRate: 0.1,
  },
  {
    id: "implementation",
    description: "Implementation sprint",
    quantity: 40,
    unitPrice: 95,
    itemDiscountRate: 0.05,
  },
  {
    id: "managed-hosting",
    description: "Managed hosting",
    quantity: 12,
    unitPrice: 12.5,
    itemDiscountRate: 0,
  },
];

const roundCurrency = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const roundRate = (value: number): number => {
  return Math.round(value * 10000) / 10000;
};

const clampRate = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return roundRate(value);
};

const sanitizeQuantity = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return Math.max(0, Math.round(fallback));
  }
  const normalized = Math.round(value);
  return normalized >= 0 ? normalized : 0;
};

const sanitizeMoney = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return roundCurrency(Math.max(0, fallback));
  }
  return roundCurrency(Math.max(0, value));
};

const sanitizeText = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed.slice(0, 80);
    }
  }
  return fallback;
};

const slugify = (value: string): string => {
  return value.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
};

const sanitizeIdentifier = (value: unknown, fallback: string): string => {
  if (typeof value === "string") {
    const slug = slugify(value.trim());
    if (slug.length > 0) return slug;
  }
  const fallbackSlug = slugify(fallback);
  return fallbackSlug.length > 0 ? fallbackSlug : "line";
};

const ensureUniqueId = (
  candidate: string,
  used: Set<string>,
  fallback: string,
): string => {
  const base = candidate.length > 0 ? candidate : fallback;
  let id = base.length > 0 ? base : fallback;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}-${suffix}`;
    suffix++;
  }
  used.add(id);
  return id;
};

const fallbackItemForIndex = (index: number): InvoiceItemInput => {
  const template = defaultItems[index];
  if (template) return template;
  return {
    id: `line-${index + 1}`,
    description: `Line ${index + 1}`,
    quantity: 1,
    unitPrice: 100,
    itemDiscountRate: 0,
  };
};

const sanitizeInvoiceItem = (
  raw: InvoiceItemInput | undefined,
  fallback: InvoiceItemInput,
  index: number,
  used: Set<string>,
): InvoiceItem => {
  const fallbackId = sanitizeIdentifier(fallback.id, `line-${index + 1}`);
  const candidateId = sanitizeIdentifier(raw?.id, fallbackId);
  const id = ensureUniqueId(candidateId, used, fallbackId);
  const fallbackDescription = sanitizeText(
    fallback.description,
    `Line ${index + 1}`,
  );
  const description = sanitizeText(raw?.description, fallbackDescription);
  const fallbackQuantity = sanitizeQuantity(fallback.quantity, 1);
  const quantity = sanitizeQuantity(raw?.quantity, fallbackQuantity);
  const fallbackUnitPrice = sanitizeMoney(fallback.unitPrice, 100);
  const unitPrice = sanitizeMoney(raw?.unitPrice, fallbackUnitPrice);
  const fallbackDiscount = clampRate(fallback.itemDiscountRate, 0);
  const itemDiscountRate = clampRate(
    raw?.itemDiscountRate,
    fallbackDiscount,
  );
  return { id, description, quantity, unitPrice, itemDiscountRate };
};

const sanitizeItemList = (
  value: readonly InvoiceItemInput[] | undefined,
  previous?: readonly InvoiceItem[],
): InvoiceItem[] => {
  const base = Array.isArray(value) ? value : [];
  const source = base.length > 0 ? base : defaultItems;
  const sanitized: InvoiceItem[] = [];
  const used = new Set<string>();

  for (let index = 0; index < source.length; index++) {
    const raw = source[index];
    const fallback = previous?.[index] ?? fallbackItemForIndex(index);
    const item = sanitizeInvoiceItem(raw, fallback, index, used);
    sanitized.push(item);
  }

  if (sanitized.length === 0) {
    return sanitizeItemList(defaultItems);
  }

  return sanitized;
};

const computeLineSummaries = (
  items: readonly InvoiceItem[],
): InvoiceLineSummary[] => {
  return items.map((item) => {
    const baseTotal = roundCurrency(item.quantity * item.unitPrice);
    const itemDiscountAmount = roundCurrency(
      baseTotal * clampRate(item.itemDiscountRate, 0),
    );
    const lineTotal = roundCurrency(baseTotal - itemDiscountAmount);
    return {
      ...item,
      baseTotal,
      itemDiscountAmount,
      lineTotal,
    };
  });
};

const computeInvoiceTotals = (
  lines: readonly InvoiceLineSummary[],
  invoiceDiscountRate: number,
  taxRate: number,
): InvoiceTotals => {
  const subtotal = roundCurrency(
    lines.reduce((total, line) => total + line.lineTotal, 0),
  );
  const itemDiscountTotal = roundCurrency(
    lines.reduce((total, line) => total + line.itemDiscountAmount, 0),
  );
  const normalizedInvoiceDiscount = clampRate(invoiceDiscountRate, 0);
  const invoiceDiscountAmount = roundCurrency(
    subtotal * normalizedInvoiceDiscount,
  );
  const discountedSubtotal = roundCurrency(
    subtotal - invoiceDiscountAmount,
  );
  const normalizedTaxRate = clampRate(taxRate, 0);
  const taxAmount = roundCurrency(discountedSubtotal * normalizedTaxRate);
  const totalDue = roundCurrency(discountedSubtotal + taxAmount);
  return {
    subtotal,
    itemDiscountTotal,
    invoiceDiscountRate: normalizedInvoiceDiscount,
    invoiceDiscountAmount,
    discountedSubtotal,
    taxRate: normalizedTaxRate,
    taxAmount,
    totalDue,
  };
};

const formatCurrency = (value: number | undefined): string => {
  const safeValue = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return `$${safeValue.toFixed(2)}`;
};

const formatPercent = (value: number): string => {
  return `${(value * 100).toFixed(2)}%`;
};

export const invoiceGeneratorUx = recipe<InvoiceGeneratorArgs>(
  "Invoice Generator",
  ({ items, taxRate, invoiceDiscountRate }) => {
    const normalizedItems = lift((value: InvoiceItemInput[] | undefined) =>
      sanitizeItemList(value)
    )(items);

    const normalizedTaxRate = lift((value: number | undefined) =>
      clampRate(value, 0.0725)
    )(taxRate);

    const normalizedInvoiceDiscountRate = lift((value: number | undefined) =>
      clampRate(value, 0.05)
    )(invoiceDiscountRate);

    const lineSummaries = lift((entries: InvoiceItem[] | undefined) =>
      computeLineSummaries(Array.isArray(entries) ? entries : [])
    )(normalizedItems);

    const totals = lift((input: {
      lines: InvoiceLineSummary[];
      invoiceDiscountRate: number;
      taxRate: number;
    }) =>
      computeInvoiceTotals(
        input.lines,
        input.invoiceDiscountRate,
        input.taxRate,
      )
    )({
      lines: lineSummaries,
      invoiceDiscountRate: normalizedInvoiceDiscountRate,
      taxRate: normalizedTaxRate,
    });

    const totalDue = lift((value: InvoiceTotals | undefined) =>
      value?.totalDue ?? 0
    )(totals);

    const formattedTotalDue = lift((value: number | undefined) =>
      formatCurrency(value ?? 0)
    )(totalDue);

    // UI-specific state for editing
    const taxRateInput = cell<string>("7.25");
    const invoiceDiscountInput = cell<string>("5");

    const applyAddItem = handler<
      unknown,
      { items: Cell<InvoiceItemInput[]> }
    >((_event, { items }) => {
      const current = sanitizeItemList(items.get());
      const nextList = [...current, {
        id: `line-${current.length + 1}`,
        description: "New item",
        quantity: 1,
        unitPrice: 100,
        itemDiscountRate: 0,
      }];
      const sanitized = sanitizeItemList(nextList, current);
      items.set(sanitized);
    })({ items });

    const applyRateUpdate = handler<
      unknown,
      {
        taxInput: Cell<string>;
        discountInput: Cell<string>;
        taxRate: Cell<number>;
        invoiceDiscountRate: Cell<number>;
      }
    >((_event, { taxInput, discountInput, taxRate, invoiceDiscountRate }) => {
      const newTax = Number(taxInput.get()) / 100;
      const newDiscount = Number(discountInput.get()) / 100;

      if (Number.isFinite(newTax) && newTax >= 0 && newTax <= 1) {
        taxRate.set(newTax);
      }
      if (
        Number.isFinite(newDiscount) && newDiscount >= 0 && newDiscount <= 1
      ) {
        invoiceDiscountRate.set(newDiscount);
      }
    })({
      taxInput: taxRateInput,
      discountInput: invoiceDiscountInput,
      taxRate,
      invoiceDiscountRate,
    });

    // Computed name
    const name = str`Invoice (${formattedTotalDue})`;

    // Build the UI with display-only line items
    const lineItemsDisplay = lift((data: {
      lines: InvoiceLineSummary[];
      totals: InvoiceTotals;
      taxRate: number;
      discountRate: number;
    }) => {
      const { lines, totals, taxRate, discountRate } = data;

      const lineElements = [];
      for (const line of lines) {
        lineElements.push(
          <div style="background: #f8f9fa; border-radius: 6px; padding: 12px; margin-bottom: 8px; border-left: 4px solid #3498db;">
            <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
              <div style="flex: 1;">
                <strong style="color: #2c3e50; font-size: 15px;">
                  {line.description}
                </strong>
              </div>
              <div style="text-align: right; font-weight: bold; color: #2c3e50; font-size: 16px;">
                {formatCurrency(line.lineTotal)}
              </div>
            </div>
            <div style="display: flex; gap: 16px; font-size: 13px; color: #7f8c8d;">
              <span>Qty: {line.quantity}</span>
              <span>@ {formatCurrency(line.unitPrice)}</span>
              {line.itemDiscountRate > 0
                ? (
                  <span style="color: #e74c3c;">
                    -{formatPercent(line.itemDiscountRate)} discount
                  </span>
                )
                : null}
            </div>
          </div>,
        );
      }

      return (
        <div>
          <h2 style="font-size: 18px; color: #34495e; margin: 0 0 12px 0;">
            Line Items
          </h2>
          {lineElements}
          <div style="border-top: 2px solid #ecf0f1; padding-top: 16px; margin-top: 16px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px; color: #7f8c8d;">
              <span>Subtotal:</span>
              <span>{formatCurrency(totals.subtotal)}</span>
            </div>
            {totals.itemDiscountTotal > 0
              ? (
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px; color: #e74c3c;">
                  <span>Item Discounts:</span>
                  <span>-{formatCurrency(totals.itemDiscountTotal)}</span>
                </div>
              )
              : null}
            {totals.invoiceDiscountAmount > 0
              ? (
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px; color: #e74c3c;">
                  <span>Invoice Discount ({formatPercent(discountRate)}):</span>
                  <span>-{formatCurrency(totals.invoiceDiscountAmount)}</span>
                </div>
              )
              : null}
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px; color: #7f8c8d;">
              <span>Tax ({formatPercent(taxRate)}):</span>
              <span>{formatCurrency(totals.taxAmount)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding-top: 12px; border-top: 2px solid #3498db; margin-top: 12px;">
              <strong style="font-size: 20px; color: #2c3e50;">
                Total Due:
              </strong>
              <strong style="font-size: 24px; color: #27ae60;">
                {formatCurrency(totals.totalDue)}
              </strong>
            </div>
          </div>
        </div>
      );
    })({
      lines: lineSummaries,
      totals,
      taxRate: normalizedTaxRate,
      discountRate: normalizedInvoiceDiscountRate,
    });

    return {
      [NAME]: name,
      [UI]: (
        <div style="font-family: system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 16px; background: #f8f9fa;">
          <div style="background: white; border-radius: 8px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <h1 style="margin: 0 0 24px 0; color: #2c3e50; font-size: 28px; border-bottom: 3px solid #3498db; padding-bottom: 12px;">
              Invoice
            </h1>

            {lineItemsDisplay}

            <div style="margin-top: 24px;">
              <ct-button
                onClick={applyAddItem}
                style="width: 100%; padding: 10px; margin-bottom: 16px; background: #27ae60; color: white; border: none; border-radius: 4px; font-size: 14px; font-weight: bold; cursor: pointer;"
              >
                + Add Line Item
              </ct-button>

              <div style="background: #ecf0f1; border-radius: 6px; padding: 16px;">
                <h3 style="margin: 0 0 12px 0; color: #34495e; font-size: 16px;">
                  Update Rates
                </h3>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px;">
                  <div>
                    <label style="display: block; margin-bottom: 4px; font-size: 13px; color: #34495e;">
                      Tax Rate %
                    </label>
                    <ct-input
                      $value={taxRateInput}
                      type="number"
                      step="0.01"
                      style="width: 100%;"
                    />
                  </div>
                  <div>
                    <label style="display: block; margin-bottom: 4px; font-size: 13px; color: #34495e;">
                      Invoice Discount %
                    </label>
                    <ct-input
                      $value={invoiceDiscountInput}
                      type="number"
                      step="0.01"
                      style="width: 100%;"
                    />
                  </div>
                </div>
                <ct-button
                  onClick={applyRateUpdate}
                  style="width: 100%; padding: 10px; background: #9b59b6; color: white; border: none; border-radius: 4px; font-size: 14px; font-weight: bold; cursor: pointer;"
                >
                  Update Rates
                </ct-button>
              </div>
            </div>
          </div>
        </div>
      ),
      items,
      normalizedItems,
      sanitizedItems: normalizedItems,
      sanitizedTaxRate: normalizedTaxRate,
      sanitizedInvoiceDiscountRate: normalizedInvoiceDiscountRate,
      lineSummaries,
      totals,
      totalDue,
      formattedTotalDue,
    };
  },
);

export default invoiceGeneratorUx;
