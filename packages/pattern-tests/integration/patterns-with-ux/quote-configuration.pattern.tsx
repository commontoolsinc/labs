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

interface QuoteOptionSeed {
  id: string;
  label: string;
  price: number;
  defaultSelected: boolean;
}

interface QuoteOptionInput extends Partial<QuoteOptionSeed> {}

interface QuoteOption {
  id: string;
  label: string;
  price: number;
  selected: boolean;
}

interface ToggleOptionEvent {
  id?: string;
}

interface ConfigureOptionEvent {
  id?: string;
  price?: number;
  selected?: boolean;
  label?: string;
}

interface ConfigurePricingEvent {
  basePrice?: number;
  discountRate?: number;
}

interface QuoteConfigurationArgs {
  basePrice: Default<number, 1800>;
  discountRate: Default<number, 0>;
  options: Default<QuoteOptionInput[], typeof defaultOptionSeeds>;
}

interface PricingDetails {
  base: number;
  optionsTotal: number;
  subtotal: number;
  discountAmount: number;
  total: number;
}

const defaultBasePrice = 1800;

const defaultOptionSeeds: QuoteOptionSeed[] = [
  {
    id: "support",
    label: "Priority support",
    price: 250,
    defaultSelected: true,
  },
  {
    id: "training",
    label: "Team onboarding workshop",
    price: 450,
    defaultSelected: false,
  },
  {
    id: "analytics",
    label: "Advanced analytics suite",
    price: 600,
    defaultSelected: false,
  },
  {
    id: "compliance",
    label: "Regulatory compliance review",
    price: 320,
    defaultSelected: false,
  },
];

const maxDiscountRate = 0.5;
const currencyPrecision = 100;

const clampCurrency = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(value, 0) * currencyPrecision) / currencyPrecision;
};

const toIdentifier = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
};

const sanitizeLabel = (
  maybeLabel: unknown,
  fallback: string,
  index: number,
): string => {
  if (typeof maybeLabel === "string") {
    const trimmed = maybeLabel.trim();
    if (trimmed.length > 0) {
      return trimmed.slice(0, 64);
    }
  }
  if (fallback.length > 0) {
    return fallback.slice(0, 64);
  }
  return `Option ${index + 1}`;
};

const sanitizeId = (
  maybeId: unknown,
  label: string,
  fallback: string,
  index: number,
  used: Set<string>,
): string => {
  const base = typeof maybeId === "string" && maybeId.trim().length > 0
    ? toIdentifier(maybeId)
    : toIdentifier(label.length > 0 ? label : fallback);
  let candidate = base.length > 0 ? base : `option-${index + 1}`;
  if (!used.has(candidate)) {
    return candidate;
  }
  let attempt = 1;
  while (used.has(candidate)) {
    attempt += 1;
    const suffix = `-${attempt}`;
    const sliceLength = Math.max(16, 48 - suffix.length);
    candidate = `${candidate.slice(0, sliceLength)}${suffix}`;
  }
  return candidate;
};

const sanitizePrice = (maybePrice: unknown, fallback: number): number => {
  if (typeof maybePrice === "number" && Number.isFinite(maybePrice)) {
    return clampCurrency(maybePrice);
  }
  return clampCurrency(fallback);
};

const sanitizeSelected = (
  maybeSelected: unknown,
  fallback: boolean,
): boolean => {
  if (typeof maybeSelected === "boolean") {
    return maybeSelected;
  }
  return fallback;
};

const sanitizeOptionList = (
  value: readonly QuoteOptionInput[] | undefined,
): QuoteOption[] => {
  const source = Array.isArray(value) && value.length > 0
    ? value
    : defaultOptionSeeds;
  const sanitized: QuoteOption[] = [];
  const usedIds = new Set<string>();
  for (let index = 0; index < source.length; index += 1) {
    const entry = source[index];
    const fallback = defaultOptionSeeds[index] ?? defaultOptionSeeds[0];
    const label = sanitizeLabel(
      entry?.label,
      fallback?.label ?? `Option ${index + 1}`,
      index,
    );
    const id = sanitizeId(
      entry?.id,
      label,
      fallback?.id ?? label,
      index,
      usedIds,
    );
    const price = sanitizePrice(entry?.price, fallback?.price ?? 0);
    const selected = sanitizeSelected(
      entry?.defaultSelected,
      fallback?.defaultSelected ?? false,
    );
    sanitized.push({ id, label, price, selected });
    usedIds.add(id);
  }
  if (sanitized.length === 0) {
    const fallback: QuoteOption[] = [];
    for (let index = 0; index < defaultOptionSeeds.length; index += 1) {
      const seed = defaultOptionSeeds[index];
      const id = sanitizeId(seed.id, seed.label, seed.id, index, usedIds);
      usedIds.add(id);
      fallback.push({
        id,
        label: seed.label,
        price: clampCurrency(seed.price),
        selected: seed.defaultSelected,
      });
    }
    return fallback;
  }
  return sanitized;
};

const normalizeOptionId = (value: unknown): string | null => {
  if (value == null) return null;
  const raw = typeof value === "string" ? value : String(value);
  const normalized = toIdentifier(raw);
  return normalized.length > 0 ? normalized : null;
};

const toRawOptionId = (value: unknown): string | null => {
  if (value == null) return null;
  const raw = typeof value === "string" ? value : String(value);
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 64) : null;
};

const optionMatchesId = (
  option: QuoteOption,
  normalized: string | null,
  raw: string | null,
): boolean => {
  if (normalized && option.id === normalized) return true;
  if (raw && option.id === raw) return true;
  if (raw) {
    const lowered = raw.toLowerCase();
    if (option.label.toLowerCase() === lowered) return true;
    const slugged = toIdentifier(raw);
    if (slugged.length > 0 && option.id === slugged) return true;
  }
  return false;
};

const fingerprintOptions = (
  entries: readonly QuoteOption[] | undefined,
): string => {
  if (!entries || entries.length === 0) return "";
  return entries.map((option) => {
    const price = option.price.toFixed(2);
    const flag = option.selected ? "1" : "0";
    return `${option.id}:${option.label}:${price}:${flag}`;
  }).join("|");
};

const sanitizeBasePrice = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return clampCurrency(defaultBasePrice);
  }
  return clampCurrency(Math.max(value, 0));
};

const sanitizeDiscountRate = (value: number | undefined): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) return 0;
  if (value >= maxDiscountRate) return maxDiscountRate;
  return Math.round(value * 1000) / 1000;
};

const toggleOptionSelection = handler(
  (
    event: ToggleOptionEvent | undefined,
    context: { options: Cell<QuoteOption[]> },
  ) => {
    const normalizedId = normalizeOptionId(event?.id);
    const rawId = toRawOptionId(event?.id);
    if (!normalizedId && !rawId) return;
    const current = context.options.get();
    if (!Array.isArray(current) || current.length === 0) {
      return;
    }
    let changed = false;
    for (let index = 0; index < current.length; index += 1) {
      const option = current[index];
      if (!optionMatchesId(option, normalizedId, rawId)) {
        continue;
      }
      const selectedCell = context.options.key(index).key("selected");
      selectedCell.set(!option.selected);
      changed = true;
    }
    if (!changed) {
      return;
    }
  },
);

const configureOption = handler(
  (
    event: ConfigureOptionEvent | undefined,
    context: { options: Cell<QuoteOption[]> },
  ) => {
    const normalizedId = normalizeOptionId(event?.id);
    const rawId = toRawOptionId(event?.id);
    if (!normalizedId && !rawId) return;
    const current = context.options.get();
    if (!Array.isArray(current) || current.length === 0) {
      return;
    }
    let changed = false;
    for (let index = 0; index < current.length; index += 1) {
      const option = current[index];
      if (!optionMatchesId(option, normalizedId, rawId)) {
        continue;
      }
      const price =
        typeof event?.price === "number" && Number.isFinite(event.price)
          ? clampCurrency(Math.max(event.price, 0))
          : option.price;
      const selected = typeof event?.selected === "boolean"
        ? event.selected
        : option.selected;
      const label = typeof event?.label === "string" && event.label.trim()
        ? event.label.trim().slice(0, 64)
        : option.label;
      if (price !== option.price) {
        context.options.key(index).key("price").set(price);
        changed = true;
      }
      if (selected !== option.selected) {
        context.options.key(index).key("selected").set(selected);
        changed = true;
      }
      if (label !== option.label) {
        context.options.key(index).key("label").set(label);
        changed = true;
      }
    }
  },
);

const configurePricing = handler(
  (
    event: ConfigurePricingEvent | undefined,
    context: { basePrice: Cell<number>; discountRate: Cell<number> },
  ) => {
    if (
      typeof event?.basePrice === "number" && Number.isFinite(event.basePrice)
    ) {
      context.basePrice.set(sanitizeBasePrice(event.basePrice));
    }
    if (
      typeof event?.discountRate === "number" &&
      Number.isFinite(event.discountRate)
    ) {
      context.discountRate.set(sanitizeDiscountRate(event.discountRate));
    }
  },
);

export const quoteConfiguration = recipe<QuoteConfigurationArgs>(
  "Quote Configuration",
  ({ basePrice, discountRate, options }) => {
    const initialOptions = sanitizeOptionList(undefined);
    const optionState = cell<QuoteOption[]>(initialOptions);
    let lastOptionSignature = fingerprintOptions(initialOptions);

    const syncOptions = compute(() => {
      const raw = options.get();
      const normalized = sanitizeOptionList(raw);
      const signature = fingerprintOptions(normalized);
      if (signature === lastOptionSignature) {
        return normalized;
      }
      lastOptionSignature = signature;
      optionState.set(normalized);
      return normalized;
    });

    const safeBasePrice = lift(sanitizeBasePrice)(basePrice);
    const safeDiscountRate = lift(sanitizeDiscountRate)(discountRate);

    const optionsView = lift((list: QuoteOption[] | undefined) => {
      if (!Array.isArray(list)) {
        return [] as QuoteOption[];
      }
      return list.map((option) => ({ ...option }));
    })(optionState);

    const selectedOptionIds = lift((list: QuoteOption[]) => {
      return list.filter((option) => option.selected).map((option) =>
        option.id
      );
    })(optionsView);

    const pricing = lift((input: {
      base: number;
      addOns: QuoteOption[];
      discount: number;
    }): PricingDetails => {
      const addOnTotal = input.addOns.reduce((total, option) => {
        return option.selected ? total + option.price : total;
      }, 0);
      const normalizedBase = clampCurrency(input.base);
      const normalizedAddOns = clampCurrency(addOnTotal);
      const subtotal = clampCurrency(normalizedBase + normalizedAddOns);
      const discountAmount = clampCurrency(subtotal * input.discount);
      const total = clampCurrency(subtotal - discountAmount);
      return {
        base: normalizedBase,
        optionsTotal: normalizedAddOns,
        subtotal,
        discountAmount,
        total,
      };
    })({
      base: safeBasePrice,
      addOns: optionsView,
      discount: safeDiscountRate,
    });

    const subtotal = lift((details: PricingDetails) => details.subtotal)(
      pricing,
    );
    const discountAmount = lift((details: PricingDetails) =>
      details.discountAmount
    )(
      pricing,
    );
    const total = lift((details: PricingDetails) => details.total)(pricing);
    const optionsTotal = lift((details: PricingDetails) =>
      details.optionsTotal
    )(
      pricing,
    );

    const formattedTotal = lift((value: number) => `$${value.toFixed(2)}`)(
      total,
    );
    const formattedDiscount = lift((value: number) => `$${value.toFixed(2)}`)(
      discountAmount,
    );
    const summary =
      str`Quote total ${formattedTotal} (discount ${formattedDiscount})`;

    // UI-specific handlers
    const basePriceField = cell<string>("");
    const discountRateField = cell<string>("");

    compute(() => {
      const current = safeBasePrice.get();
      basePriceField.set(String(current));
    });

    compute(() => {
      const current = safeDiscountRate.get();
      const percentage = Math.round(current * 100);
      discountRateField.set(String(percentage));
    });

    const updateBasePrice = handler<
      unknown,
      {
        field: Cell<string>;
        basePrice: Cell<number>;
        discountRate: Cell<number>;
      }
    >((_event, { field, basePrice, discountRate }) => {
      const rawValue = field.get();
      const text = typeof rawValue === "string" ? rawValue : String(rawValue);
      const parsed = Number(text);
      if (Number.isFinite(parsed) && parsed > 0) {
        basePrice.set(sanitizeBasePrice(parsed));
      }
    })({ field: basePriceField, basePrice, discountRate });

    const updateDiscountRate = handler<
      unknown,
      {
        field: Cell<string>;
        basePrice: Cell<number>;
        discountRate: Cell<number>;
      }
    >((_event, { field, basePrice, discountRate }) => {
      const text = field.get() ?? "";
      const parsed = Number(text);
      if (Number.isFinite(parsed)) {
        const rate = parsed / 100;
        discountRate.set(sanitizeDiscountRate(rate));
      }
    })({ field: discountRateField, basePrice, discountRate });

    const toggleOption = handler<
      { id?: string },
      { options: Cell<QuoteOption[]> }
    >((event, { options }) => {
      const normalizedId = normalizeOptionId(event?.id);
      const rawId = toRawOptionId(event?.id);
      if (!normalizedId && !rawId) return;
      const current = options.get();
      if (!Array.isArray(current) || current.length === 0) {
        return;
      }
      for (let index = 0; index < current.length; index += 1) {
        const option = current[index];
        if (!optionMatchesId(option, normalizedId, rawId)) {
          continue;
        }
        const selectedCell = options.key(index).key("selected");
        selectedCell.set(!option.selected);
      }
    })({ options: optionState });

    const name = str`Quote Configuration`;

    const optionIdField = cell<string>("");

    const toggleOptionById = handler<
      unknown,
      { idField: Cell<string>; options: Cell<QuoteOption[]> }
    >((_event, { idField, options }) => {
      const rawId = idField.get();
      const id = typeof rawId === "string" ? rawId.trim() : "";
      if (id.length === 0) return;

      const normalizedId = normalizeOptionId(id);
      const rawIdValue = toRawOptionId(id);
      if (!normalizedId && !rawIdValue) return;

      const current = options.get();
      if (!Array.isArray(current) || current.length === 0) {
        return;
      }

      for (let index = 0; index < current.length; index += 1) {
        const option = current[index];
        if (!optionMatchesId(option, normalizedId, rawIdValue)) {
          continue;
        }
        const selectedCell = options.key(index).key("selected");
        selectedCell.set(!option.selected);
      }

      idField.set("");
    })({ idField: optionIdField, options: optionState });

    const optionCards = lift((options: QuoteOption[]) => {
      const optionsElements = [];
      for (const option of options) {
        const selectedStyle = option.selected
          ? "background: #dcfce7; border: 2px solid #16a34a;"
          : "background: #f3f4f6; border: 2px solid #d1d5db;";
        const statusBadge = option.selected ? "✓ Selected" : "Not selected";
        const badgeColor = option.selected ? "#16a34a" : "#6b7280";

        const optionCard = h(
          "ct-card",
          {
            style: "padding: 12px; transition: all 0.2s; " + selectedStyle,
          },
          h(
            "div",
            {
              style:
                "display: flex; justify-content: space-between; align-items: center;",
            },
            h(
              "div",
              { style: "flex: 1;" },
              h(
                "div",
                {
                  style:
                    "font-weight: 600; margin-bottom: 4px; color: #1f2937;",
                },
                option.label,
              ),
              h(
                "div",
                {
                  style:
                    "font-size: 12px; color: #6b7280; margin-bottom: 4px; font-family: monospace;",
                },
                "ID: " + option.id,
              ),
              h(
                "div",
                {
                  style:
                    "font-size: 14px; color: #6b7280; font-family: monospace;",
                },
                "$" + option.price.toFixed(2),
              ),
            ),
            h(
              "span",
              {
                style:
                  "padding: 4px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; color: white; background: " +
                  badgeColor + ";",
              },
              statusBadge,
            ),
          ),
        );
        optionsElements.push(optionCard);
      }
      return h(
        "div",
        {
          style:
            "display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px;",
        },
        ...optionsElements,
      );
    })(optionsView);

    const ui = (
      <div style="padding: 24px; max-width: 900px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 24px; border-radius: 8px; margin-bottom: 24px; color: white;">
          <h1 style="margin: 0 0 8px 0; font-size: 28px; font-weight: 700;">
            Quote Configuration
          </h1>
          <p style="margin: 0; opacity: 0.9; font-size: 16px;">
            Configure your quote by adjusting base price, discount, and
            selecting options
          </p>
        </div>

        <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 24px;">
          <ct-card style="padding: 16px;">
            <label style="display: block; font-weight: 600; margin-bottom: 8px; color: #374151;">
              Base Price ($)
            </label>
            <div style="display: flex; gap: 8px; align-items: center;">
              <ct-input
                $value={basePriceField}
                type="number"
                style="flex: 1; font-family: monospace;"
                placeholder="1800"
              />
              <ct-button onClick={updateBasePrice}>Update</ct-button>
            </div>
          </ct-card>

          <ct-card style="padding: 16px;">
            <label style="display: block; font-weight: 600; margin-bottom: 8px; color: #374151;">
              Discount Rate (%)
            </label>
            <div style="display: flex; gap: 8px; align-items: center;">
              <ct-input
                $value={discountRateField}
                type="number"
                style="flex: 1; font-family: monospace;"
                placeholder="0"
              />
              <ct-button onClick={updateDiscountRate}>Update</ct-button>
            </div>
          </ct-card>
        </div>

        <ct-card style="padding: 20px; margin-bottom: 24px;">
          <h2 style="margin: 0 0 16px 0; font-size: 20px; font-weight: 600; color: #111827;">
            Available Options
          </h2>
          <div style="margin-bottom: 16px; padding: 12px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb;">
            <label style="display: block; font-weight: 600; margin-bottom: 8px; color: #374151; font-size: 14px;">
              Toggle Option (enter option name or ID)
            </label>
            <div style="display: flex; gap: 8px;">
              <ct-input
                $value={optionIdField}
                type="text"
                style="flex: 1;"
                placeholder="e.g., support, training, analytics..."
              />
              <ct-button onClick={toggleOptionById}>Toggle</ct-button>
            </div>
          </div>
          {optionCards}
        </ct-card>

        <ct-card style="padding: 24px; background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border: 2px solid #f59e0b;">
          <h2 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 700; color: #78350f;">
            Quote Summary
          </h2>
          {lift((input: { pricing: PricingDetails; discount: number }) => {
            const discountPercent = Math.round(input.discount * 100);
            const p = input.pricing;
            return (
              <div style="display: flex; flex-direction: column; gap: 12px;">
                <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 12px; border-bottom: 1px solid #d97706;">
                  <span style="font-size: 16px; color: #78350f;">
                    Base Price:
                  </span>
                  <span style="font-size: 18px; font-weight: 600; font-family: monospace; color: #78350f;">
                    ${p.base.toFixed(2)}
                  </span>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 12px; border-bottom: 1px solid #d97706;">
                  <span style="font-size: 16px; color: #78350f;">
                    Selected Options:
                  </span>
                  <span style="font-size: 18px; font-weight: 600; font-family: monospace; color: #78350f;">
                    ${p.optionsTotal.toFixed(2)}
                  </span>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 12px; border-bottom: 1px solid #d97706;">
                  <span style="font-size: 16px; color: #78350f;">
                    Subtotal:
                  </span>
                  <span style="font-size: 18px; font-weight: 600; font-family: monospace; color: #78350f;">
                    ${p.subtotal.toFixed(2)}
                  </span>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 12px; border-bottom: 1px solid #d97706;">
                  <span style="font-size: 16px; color: #78350f;">
                    Discount ({discountPercent}%):
                  </span>
                  <span style="font-size: 18px; font-weight: 600; font-family: monospace; color: #dc2626;">
                    -${p.discountAmount.toFixed(2)}
                  </span>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; padding-top: 12px; margin-top: 8px; border-top: 3px solid #78350f;">
                  <span style="font-size: 20px; font-weight: 700; color: #78350f;">
                    Total:
                  </span>
                  <span style="font-size: 28px; font-weight: 700; font-family: monospace; color: #78350f;">
                    ${p.total.toFixed(2)}
                  </span>
                </div>
              </div>
            );
          })({ pricing, discount: safeDiscountRate })}
        </ct-card>
      </div>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      basePrice: safeBasePrice,
      discountRate: safeDiscountRate,
      options: optionsView,
      selectedOptionIds,
      optionsTotal,
      subtotal,
      discountAmount,
      total,
      summary,
      pricing,
      toggleOption: toggleOptionSelection({ options: optionState }),
      configureOption: configureOption({ options: optionState }),
      configurePricing: configurePricing({
        basePrice,
        discountRate,
      }),
      effects: { syncOptions },
    };
  },
);
