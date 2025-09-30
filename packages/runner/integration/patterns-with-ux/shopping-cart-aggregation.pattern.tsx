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

interface CartItemInput {
  id?: string;
  name?: string;
  price?: number;
  quantity?: number;
  category?: string;
}

interface DiscountRuleInput {
  id?: string;
  label?: string;
  category?: string;
  threshold?: number;
  percent?: number;
}

interface ShoppingCartArgs {
  items: Default<CartItemInput[], []>;
  discounts: Default<DiscountRuleInput[], []>;
}

interface CartItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
  category: string;
}

interface DiscountRule {
  id: string;
  label: string;
  category: string;
  threshold: number;
  percent: number;
}

interface LineTotal {
  id: string;
  name: string;
  category: string;
  unitPrice: number;
  quantity: number;
  subtotal: number;
}

interface CategoryTotal {
  category: string;
  quantity: number;
  subtotal: number;
}

interface DiscountApplication {
  id: string;
  label: string;
  category: string;
  threshold: number;
  percent: number;
  qualified: boolean;
  amount: number;
}

type CartEvent =
  | { type: "add"; item?: CartItemInput }
  | { type: "update"; id?: string; quantity?: number; price?: number }
  | { type: "remove"; id?: string }
  | { type: "clear" };

type DiscountEvent =
  | { type?: "replace"; rules?: DiscountRuleInput[] }
  | { type: "clear" };

const defaultItemName = "Item";
const defaultCategory = "general";

const clampNumber = (value: number, min: number, max: number): number => {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

const normalizeString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const claimIdentifier = (base: string, used: Set<string>): string => {
  let candidate = base;
  let suffix = 1;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
};

const sanitizeName = (value: unknown, index: number): string => {
  const normalized = normalizeString(value);
  if (normalized) return normalized;
  return `${defaultItemName} ${index + 1}`;
};

const sanitizeCategory = (value: unknown): string => {
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized) return normalized;
  return defaultCategory;
};

const sanitizePrice = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampNumber(Math.round(value * 100) / 100, 0, 1_000_000);
  }
  return 0;
};

const sanitizeQuantity = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.trunc(value);
    return clampNumber(rounded, 0, 10_000);
  }
  return 1;
};

const sanitizePercent = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampNumber(Math.round(value * 100) / 100, 0, 100);
  }
  return 0;
};

const sanitizeThreshold = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.trunc(value);
    return clampNumber(rounded, 1, 10_000);
  }
  return 1;
};

const sanitizeCartItem = (
  input: CartItemInput | undefined,
  index: number,
  used: Set<string>,
): CartItem => {
  const providedId = normalizeString(input?.id)?.toLowerCase();
  const fallback = `item-${index + 1}`;
  const id = providedId ?? claimIdentifier(fallback, used);
  const name = sanitizeName(input?.name ?? id, index);
  const price = sanitizePrice(input?.price);
  const quantity = sanitizeQuantity(input?.quantity);
  const category = sanitizeCategory(input?.category);
  return { id, name, price, quantity, category };
};

const sanitizeCartItems = (
  entries: readonly CartItemInput[] | undefined,
): CartItem[] => {
  const result: CartItem[] = [];
  const list = Array.isArray(entries) ? entries : [];
  const used = new Set<string>();
  for (let index = 0; index < list.length; index++) {
    const sanitized = sanitizeCartItem(list[index], index, used);
    used.add(sanitized.id);
    result.push(sanitized);
  }
  return result;
};

const sanitizeDiscountRule = (
  input: DiscountRuleInput | undefined,
  index: number,
  used: Set<string>,
): DiscountRule => {
  const providedId = normalizeString(input?.id)?.toLowerCase();
  const fallback = `rule-${index + 1}`;
  const id = providedId ?? claimIdentifier(fallback, used);
  const label = sanitizeName(input?.label ?? id, index);
  const category = sanitizeCategory(input?.category);
  const threshold = sanitizeThreshold(input?.threshold);
  const percent = sanitizePercent(input?.percent);
  return { id, label, category, threshold, percent };
};

const sanitizeDiscountRules = (
  entries: readonly DiscountRuleInput[] | undefined,
): DiscountRule[] => {
  const result: DiscountRule[] = [];
  const list = Array.isArray(entries) ? entries : [];
  const used = new Set<string>();
  for (let index = 0; index < list.length; index++) {
    const sanitized = sanitizeDiscountRule(list[index], index, used);
    used.add(sanitized.id);
    result.push(sanitized);
  }
  return result;
};

const roundCurrency = (value: number): number => {
  return Math.round(value * 100) / 100;
};

const formatCurrency = (value: number): string => {
  return `$${roundCurrency(value).toFixed(2)}`;
};

const computeLineTotals = (items: CartItem[]): LineTotal[] => {
  return items.map((item) => {
    const subtotal = roundCurrency(item.price * item.quantity);
    return {
      id: item.id,
      name: item.name,
      category: item.category,
      unitPrice: item.price,
      quantity: item.quantity,
      subtotal,
    };
  });
};

const computeCategoryTotals = (items: CartItem[]): CategoryTotal[] => {
  const map = new Map<string, { quantity: number; subtotal: number }>();
  for (const item of items) {
    const entry = map.get(item.category) ?? { quantity: 0, subtotal: 0 };
    entry.quantity += item.quantity;
    entry.subtotal = roundCurrency(entry.subtotal + item.price * item.quantity);
    map.set(item.category, entry);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, entry]) => ({
      category,
      quantity: entry.quantity,
      subtotal: roundCurrency(entry.subtotal),
    }));
};

const computeDiscountApplications = (
  rules: DiscountRule[],
  totals: CategoryTotal[],
): DiscountApplication[] => {
  const index = new Map<string, CategoryTotal>();
  for (const entry of totals) {
    index.set(entry.category, entry);
  }
  return rules.map((rule) => {
    const bucket = index.get(rule.category);
    if (!bucket) {
      return { ...rule, qualified: false, amount: 0 };
    }
    const qualified = bucket.quantity >= rule.threshold && rule.percent > 0;
    if (!qualified) {
      return { ...rule, qualified, amount: 0 };
    }
    const raw = (bucket.subtotal * rule.percent) / 100;
    return { ...rule, qualified, amount: roundCurrency(raw) };
  });
};

const sumLineSubtotal = (lines: LineTotal[]): number => {
  let total = 0;
  for (const line of lines) {
    total = roundCurrency(total + line.subtotal);
  }
  return total;
};

const sumLineQuantity = (lines: LineTotal[]): number => {
  let total = 0;
  for (const line of lines) {
    total += line.quantity;
  }
  return total;
};

const sumDiscountAmount = (entries: DiscountApplication[]): number => {
  let total = 0;
  for (const entry of entries) {
    total = roundCurrency(total + entry.amount);
  }
  return total;
};

const modifyCart = handler(
  (
    event: CartEvent | undefined,
    context: { items: Cell<CartItemInput[]>; history: Cell<string[]> },
  ) => {
    if (!event || typeof event !== "object") return;

    const current = sanitizeCartItems(context.items.get());
    const used = new Set(current.map((item) => item.id));
    const existingHistory = context.history.get();
    const history = Array.isArray(existingHistory) ? [...existingHistory] : [];

    switch (event.type) {
      case "add": {
        const sanitized = sanitizeCartItem(event.item, current.length, used);
        const index = current.findIndex((item) => item.id === sanitized.id);
        const next = index >= 0
          ? current.map((item, position) =>
            position === index ? sanitized : item
          )
          : [...current, sanitized];
        const amountLabel = `${sanitized.quantity} x ` +
          `${formatCurrency(sanitized.price)}`;
        const message = index >= 0
          ? `Replaced ${sanitized.id} with ${amountLabel}`
          : `Added ${sanitized.id} with ${amountLabel}`;
        context.items.set(next);
        context.history.set([...history, message]);
        break;
      }
      case "update": {
        const id = normalizeString(event.id)?.toLowerCase();
        if (!id) return;
        const index = current.findIndex((item) => item.id === id);
        if (index === -1) return;
        const existing = current[index];
        const quantity = event.quantity === undefined
          ? existing.quantity
          : sanitizeQuantity(event.quantity);
        const price = event.price === undefined
          ? existing.price
          : sanitizePrice(event.price);
        const updated: CartItem = {
          ...existing,
          quantity,
          price,
        };
        const next = current.map((item, position) => {
          return position === index ? updated : item;
        });
        const message = `Updated ${updated.id} to ${updated.quantity} x ` +
          `${formatCurrency(updated.price)}`;
        context.items.set(next);
        context.history.set([...history, message]);
        break;
      }
      case "remove": {
        const id = normalizeString(event.id)?.toLowerCase();
        if (!id) return;
        if (!current.some((item) => item.id === id)) return;
        const next = current.filter((item) => item.id !== id);
        const message = `Removed ${id} from cart`;
        context.items.set(next);
        context.history.set([...history, message]);
        break;
      }
      case "clear": {
        if (current.length === 0) return;
        context.items.set([]);
        context.history.set([...history, "Cleared cart items"]);
        break;
      }
    }
  },
);

const configureDiscounts = handler(
  (
    event: DiscountEvent | undefined,
    context: { discounts: Cell<DiscountRuleInput[]>; history: Cell<string[]> },
  ) => {
    if (!event || typeof event !== "object") return;

    const history = Array.isArray(context.history.get())
      ? [...context.history.get()]
      : [];

    if (event.type === "clear") {
      context.discounts.set([]);
      context.history.set([...history, "Cleared discounts"]);
      return;
    }

    const rules = sanitizeDiscountRules(event.rules);
    context.discounts.set(rules);
    const message = `Configured ${rules.length} discount rule(s)`;
    context.history.set([...history, message]);
  },
);

// UI handlers
const addItemHandler = handler(
  (
    _event: unknown,
    context: {
      items: Cell<CartItemInput[]>;
      history: Cell<string[]>;
      itemId: Cell<string>;
      itemName: Cell<string>;
      itemPrice: Cell<string>;
      itemQuantity: Cell<string>;
      itemCategory: Cell<string>;
    },
  ) => {
    const id = context.itemId.get();
    const name = context.itemName.get();
    const price = Number(context.itemPrice.get());
    const quantity = Number(context.itemQuantity.get());
    const category = context.itemCategory.get();

    const item: CartItemInput = {
      id: id || undefined,
      name: name || undefined,
      price: Number.isFinite(price) ? price : undefined,
      quantity: Number.isFinite(quantity) ? quantity : undefined,
      category: category || undefined,
    };

    const current = sanitizeCartItems(context.items.get());
    const used = new Set(current.map((item) => item.id));
    const existingHistory = context.history.get();
    const history = Array.isArray(existingHistory) ? [...existingHistory] : [];

    const sanitized = sanitizeCartItem(item, current.length, used);
    const index = current.findIndex((item) => item.id === sanitized.id);
    const next = index >= 0
      ? current.map((item, position) => position === index ? sanitized : item)
      : [...current, sanitized];
    const amountLabel = `${sanitized.quantity} x ` +
      `${formatCurrency(sanitized.price)}`;
    const message = index >= 0
      ? `Replaced ${sanitized.id} with ${amountLabel}`
      : `Added ${sanitized.id} with ${amountLabel}`;
    context.items.set(next);
    context.history.set([...history, message]);

    // Clear form
    context.itemId.set("");
    context.itemName.set("");
    context.itemPrice.set("");
    context.itemQuantity.set("");
    context.itemCategory.set("");
  },
);

const updateItemHandler = handler(
  (
    _event: unknown,
    context: {
      items: Cell<CartItemInput[]>;
      history: Cell<string[]>;
      updateId: Cell<string>;
      updateQuantity: Cell<string>;
      updatePrice: Cell<string>;
    },
  ) => {
    const id = normalizeString(context.updateId.get())?.toLowerCase();
    if (!id) return;

    const current = sanitizeCartItems(context.items.get());
    const index = current.findIndex((item) => item.id === id);
    if (index === -1) return;

    const existing = current[index];
    const quantityStr = context.updateQuantity.get();
    const priceStr = context.updatePrice.get();

    const quantity = quantityStr !== ""
      ? sanitizeQuantity(Number(quantityStr))
      : existing.quantity;
    const price = priceStr !== ""
      ? sanitizePrice(Number(priceStr))
      : existing.price;

    const updated: CartItem = {
      ...existing,
      quantity,
      price,
    };

    const next = current.map((item, position) => {
      return position === index ? updated : item;
    });

    const existingHistory = context.history.get();
    const history = Array.isArray(existingHistory) ? [...existingHistory] : [];
    const message = `Updated ${updated.id} to ${updated.quantity} x ` +
      `${formatCurrency(updated.price)}`;

    context.items.set(next);
    context.history.set([...history, message]);

    // Clear form
    context.updateId.set("");
    context.updateQuantity.set("");
    context.updatePrice.set("");
  },
);

const removeItemHandler = handler(
  (
    _event: unknown,
    context: {
      items: Cell<CartItemInput[]>;
      history: Cell<string[]>;
      removeId: Cell<string>;
    },
  ) => {
    const id = normalizeString(context.removeId.get())?.toLowerCase();
    if (!id) return;

    const current = sanitizeCartItems(context.items.get());
    if (!current.some((item) => item.id === id)) return;

    const next = current.filter((item) => item.id !== id);

    const existingHistory = context.history.get();
    const history = Array.isArray(existingHistory) ? [...existingHistory] : [];
    const message = `Removed ${id} from cart`;

    context.items.set(next);
    context.history.set([...history, message]);

    // Clear form
    context.removeId.set("");
  },
);

const clearCartHandler = handler(
  (
    _event: unknown,
    context: { items: Cell<CartItemInput[]>; history: Cell<string[]> },
  ) => {
    const current = sanitizeCartItems(context.items.get());
    if (current.length === 0) return;

    const existingHistory = context.history.get();
    const history = Array.isArray(existingHistory) ? [...existingHistory] : [];

    context.items.set([]);
    context.history.set([...history, "Cleared cart items"]);
  },
);

export const shoppingCartAggregationUx = recipe<ShoppingCartArgs>(
  "Shopping Cart Aggregation (UX)",
  ({ items, discounts }) => {
    const cartItems = lift(sanitizeCartItems)(items);
    const discountRules = lift(sanitizeDiscountRules)(discounts);

    const categoryTotals = lift(computeCategoryTotals)(cartItems);
    const lineTotals = lift(computeLineTotals)(cartItems);

    const subtotal = lift(sumLineSubtotal)(lineTotals);
    const itemCount = lift(sumLineQuantity)(lineTotals);

    const discountApplications = lift((input: {
      rules: DiscountRule[];
      totals: CategoryTotal[];
    }) => computeDiscountApplications(input.rules, input.totals))({
      rules: discountRules,
      totals: categoryTotals,
    });

    const totalDiscount = lift(sumDiscountAmount)(discountApplications);

    const grandTotal = lift((input: { subtotal: number; discount: number }) =>
      roundCurrency(Math.max(0, input.subtotal - input.discount))
    )({
      subtotal,
      discount: totalDiscount,
    });

    const subtotalDisplay = lift(formatCurrency)(subtotal);
    const discountDisplay = lift(formatCurrency)(totalDiscount);
    const totalDisplay = lift(formatCurrency)(grandTotal);

    const history = cell<string[]>([]);
    const lastEvent = lift((input: { log: string[]; lines: LineTotal[] }) => {
      if (!Array.isArray(input.log) || input.log.length === 0) {
        const count = Array.isArray(input.lines) ? input.lines.length : 0;
        return `Cart initialized with ${count} item(s)`;
      }
      return input.log[input.log.length - 1];
    })({
      log: history,
      lines: lineTotals,
    });

    const summary =
      str`Cart subtotal ${subtotalDisplay} • discount ${discountDisplay} • total ${totalDisplay}`;

    // UI form fields
    const itemId = cell<string>("");
    const itemName = cell<string>("");
    const itemPrice = cell<string>("");
    const itemQuantity = cell<string>("");
    const itemCategory = cell<string>("");

    const updateId = cell<string>("");
    const updateQuantity = cell<string>("");
    const updatePrice = cell<string>("");

    const removeId = cell<string>("");

    // Handlers
    const addItem = addItemHandler({
      items,
      history,
      itemId,
      itemName,
      itemPrice,
      itemQuantity,
      itemCategory,
    });

    const updateItem = updateItemHandler({
      items,
      history,
      updateId,
      updateQuantity,
      updatePrice,
    });

    const removeItem = removeItemHandler({
      items,
      history,
      removeId,
    });

    const clearCart = clearCartHandler({ items, history });

    const name = str`Shopping Cart • ${itemCount} items • ${totalDisplay}`;

    const cartItemsDisplay = lift((lines: LineTotal[]) => {
      if (!Array.isArray(lines) || lines.length === 0) {
        return (
          <ct-card style="padding: 2rem; text-align: center; color: #666;">
            Cart is empty
          </ct-card>
        );
      }

      const elements = [];
      for (const line of lines) {
        const subtotalStr = formatCurrency(line.subtotal);
        const unitPriceStr = formatCurrency(line.unitPrice);
        const itemStyle = "display: flex; align-items: center; gap: 1rem; " +
          "padding: 1rem; border: 1px solid #e0e0e0; border-radius: 8px; " +
          "background: white;";
        const nameStyle = "flex: 1; font-weight: 600; color: #333;";
        const categoryStyle =
          "padding: 0.25rem 0.75rem; border-radius: 12px; " +
          "background: #e3f2fd; color: #1976d2; font-size: 0.875rem;";
        const quantityStyle = "color: #666; font-family: monospace;";
        const priceStyle = "font-weight: 600; color: #2e7d32; " +
          "font-family: monospace;";

        elements.push(
          <div key={line.id} style={itemStyle}>
            <div style={nameStyle}>{line.name}</div>
            <div style={categoryStyle}>{line.category}</div>
            <div style={quantityStyle}>
              {String(line.quantity)} × {unitPriceStr}
            </div>
            <div style={priceStyle}>{subtotalStr}</div>
          </div>,
        );
      }

      return (
        <div style="display: flex; flex-direction: column; gap: 0.5rem;">
          {elements}
        </div>
      );
    })(lineTotals);

    const categoryTotalsDisplay = lift((totals: CategoryTotal[]) => {
      if (!Array.isArray(totals) || totals.length === 0) {
        return null;
      }

      const elements = [];
      for (const cat of totals) {
        const subtotalStr = formatCurrency(cat.subtotal);
        const cardStyle = "padding: 1rem; border: 1px solid #e0e0e0; " +
          "border-radius: 8px; background: #fafafa;";
        const headerStyle = "font-weight: 600; color: #333; " +
          "text-transform: uppercase; font-size: 0.875rem; margin-bottom: 0.5rem;";
        const statsStyle = "display: flex; gap: 2rem;";
        const statStyle = "display: flex; flex-direction: column;";
        const labelStyle =
          "font-size: 0.75rem; color: #666; margin-bottom: 0.25rem;";
        const valueStyle = "font-weight: 600; font-family: monospace;";

        elements.push(
          <div key={cat.category} style={cardStyle}>
            <div style={headerStyle}>{cat.category}</div>
            <div style={statsStyle}>
              <div style={statStyle}>
                <div style={labelStyle}>Quantity</div>
                <div style={valueStyle}>{String(cat.quantity)}</div>
              </div>
              <div style={statStyle}>
                <div style={labelStyle}>Subtotal</div>
                <div style={valueStyle}>{subtotalStr}</div>
              </div>
            </div>
          </div>,
        );
      }

      return (
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.5rem;">
          {elements}
        </div>
      );
    })(categoryTotals);

    const discountBreakdownDisplay = lift((apps: DiscountApplication[]) => {
      if (!Array.isArray(apps) || apps.length === 0) {
        return (
          <div style="padding: 1rem; text-align: center; color: #666; font-size: 0.875rem;">
            No discount rules configured
          </div>
        );
      }

      const elements = [];
      for (const app of apps) {
        const amountStr = formatCurrency(app.amount);
        const bgColor = app.qualified ? "#e8f5e9" : "#fafafa";
        const borderColor = app.qualified ? "#66bb6a" : "#e0e0e0";
        const statusColor = app.qualified ? "#2e7d32" : "#757575";
        const cardStyle = "padding: 1rem; border: 2px solid " + borderColor +
          "; border-radius: 8px; background: " + bgColor + ";";
        const headerStyle = "display: flex; justify-content: space-between; " +
          "align-items: center; margin-bottom: 0.5rem;";
        const labelStyle = "font-weight: 600; color: #333;";
        const statusStyle = "padding: 0.25rem 0.75rem; border-radius: 12px; " +
          "background: white; color: " + statusColor +
          "; font-size: 0.875rem; font-weight: 600;";
        const statusText = app.qualified ? "APPLIED" : "NOT QUALIFIED";
        const detailsStyle =
          "font-size: 0.875rem; color: #666; margin-bottom: 0.5rem;";
        const amountStyle = "font-size: 1.25rem; font-weight: 700; color: " +
          statusColor + "; font-family: monospace;";

        elements.push(
          <div key={app.id} style={cardStyle}>
            <div style={headerStyle}>
              <div style={labelStyle}>{app.label}</div>
              <div style={statusStyle}>{statusText}</div>
            </div>
            <div style={detailsStyle}>
              Category: {app.category} • {String(app.percent)}% off when qty ≥
              {" "}
              {String(app.threshold)}
            </div>
            <div style={amountStyle}>-{amountStr}</div>
          </div>,
        );
      }

      return (
        <div style="display: flex; flex-direction: column; gap: 0.75rem;">
          {elements}
        </div>
      );
    })(discountApplications);

    const historyDisplay = lift((log: string[]) => {
      if (!Array.isArray(log) || log.length === 0) {
        return null;
      }

      const elements = [];
      const recent = log.slice().reverse().slice(0, 5);
      for (let i = 0; i < recent.length; i++) {
        const entry = recent[i];
        const itemStyle =
          "padding: 0.5rem 0.75rem; border-left: 3px solid #1976d2; " +
          "background: #f5f5f5; font-size: 0.875rem; color: #333;";
        elements.push(
          <div key={String(i)} style={itemStyle}>{entry}</div>,
        );
      }

      return (
        <div style="display: flex; flex-direction: column; gap: 0.25rem;">
          {elements}
        </div>
      );
    })(history);

    const ui = (
      <div style="font-family: system-ui, sans-serif; max-width: 1200px; margin: 0 auto; padding: 1rem;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 2rem; border-radius: 12px; margin-bottom: 1.5rem;">
          <h1 style="margin: 0 0 0.5rem 0; font-size: 2rem;">
            🛒 Shopping Cart
          </h1>
          <div style="font-size: 1.25rem; opacity: 0.95;">{summary}</div>
        </div>

        <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 1.5rem; margin-bottom: 1.5rem;">
          <div>
            <ct-card>
              <h2 style="margin: 0 0 1rem 0; font-size: 1.25rem; color: #333;">
                Cart Items
              </h2>
              {cartItemsDisplay}
            </ct-card>
          </div>

          <div>
            <ct-card style="background: #f9fbe7; border: 2px solid #cddc39;">
              <h3 style="margin: 0 0 1rem 0; font-size: 1rem; color: #333;">
                Order Summary
              </h3>
              <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                <div style="display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid #e0e0e0;">
                  <span style="color: #666;">Items:</span>
                  <span style="font-weight: 600; font-family: monospace;">
                    {itemCount}
                  </span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid #e0e0e0;">
                  <span style="color: #666;">Subtotal:</span>
                  <span style="font-weight: 600; font-family: monospace;">
                    {subtotalDisplay}
                  </span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid #e0e0e0;">
                  <span style="color: #2e7d32;">Discount:</span>
                  <span style="font-weight: 600; font-family: monospace; color: #2e7d32;">
                    -{discountDisplay}
                  </span>
                </div>
                <div style="display: flex; justify-content: space-between; padding: 1rem 0; border-top: 2px solid #333;">
                  <span style="font-size: 1.25rem; font-weight: 700;">
                    Total:
                  </span>
                  <span style="font-size: 1.5rem; font-weight: 700; font-family: monospace; color: #1976d2;">
                    {totalDisplay}
                  </span>
                </div>
              </div>
            </ct-card>
          </div>
        </div>

        <div style="margin-bottom: 1.5rem;">
          <ct-card>
            <h2 style="margin: 0 0 1rem 0; font-size: 1.25rem; color: #333;">
              Category Breakdown
            </h2>
            {categoryTotalsDisplay}
          </ct-card>
        </div>

        <div style="margin-bottom: 1.5rem;">
          <ct-card>
            <h2 style="margin: 0 0 1rem 0; font-size: 1.25rem; color: #333;">
              Discount Rules
            </h2>
            {discountBreakdownDisplay}
          </ct-card>
        </div>

        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; margin-bottom: 1.5rem;">
          <ct-card>
            <h3 style="margin: 0 0 1rem 0; font-size: 1rem; color: #333;">
              Add Item
            </h3>
            <div style="display: flex; flex-direction: column; gap: 0.5rem;">
              <ct-input $value={itemId} placeholder="ID (optional)" />
              <ct-input $value={itemName} placeholder="Name" />
              <ct-input $value={itemPrice} placeholder="Price" type="number" />
              <ct-input
                $value={itemQuantity}
                placeholder="Quantity"
                type="number"
              />
              <ct-input $value={itemCategory} placeholder="Category" />
              <ct-button onClick={addItem}>Add to Cart</ct-button>
            </div>
          </ct-card>

          <ct-card>
            <h3 style="margin: 0 0 1rem 0; font-size: 1rem; color: #333;">
              Update Item
            </h3>
            <div style="display: flex; flex-direction: column; gap: 0.5rem;">
              <ct-input $value={updateId} placeholder="Item ID" />
              <ct-input
                $value={updateQuantity}
                placeholder="New Quantity (optional)"
                type="number"
              />
              <ct-input
                $value={updatePrice}
                placeholder="New Price (optional)"
                type="number"
              />
              <ct-button onClick={updateItem}>Update Item</ct-button>
            </div>
          </ct-card>
        </div>

        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; margin-bottom: 1.5rem;">
          <ct-card>
            <h3 style="margin: 0 0 1rem 0; font-size: 1rem; color: #333;">
              Remove Item
            </h3>
            <div style="display: flex; flex-direction: column; gap: 0.5rem;">
              <ct-input $value={removeId} placeholder="Item ID" />
              <ct-button onClick={removeItem}>Remove from Cart</ct-button>
            </div>
          </ct-card>

          <ct-card>
            <h3 style="margin: 0 0 1rem 0; font-size: 1rem; color: #333;">
              Clear Cart
            </h3>
            <div style="display: flex; flex-direction: column; gap: 0.5rem;">
              <p style="margin: 0; color: #666; font-size: 0.875rem;">
                Remove all items from cart
              </p>
              <ct-button
                onClick={clearCart}
                style="background: #d32f2f; color: white;"
              >
                Clear All
              </ct-button>
            </div>
          </ct-card>
        </div>

        <ct-card>
          <h3 style="margin: 0 0 1rem 0; font-size: 1rem; color: #333;">
            Recent Activity
          </h3>
          {historyDisplay}
        </ct-card>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      items: cartItems,
      discountRules,
      categoryTotals,
      lineTotals,
      discountBreakdown: discountApplications,
      subtotal,
      itemCount,
      totalDiscount,
      total: grandTotal,
      summary,
      history,
      lastEvent,
      modify: modifyCart({ items, history }),
      configureDiscounts: configureDiscounts({ discounts, history }),
    };
  },
);
