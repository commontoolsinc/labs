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

interface CurrencyConversionArgs {
  baseCurrency: Default<string, "USD">;
  amount: Default<number, 100>;
  rates: Default<Record<string, number>, {
    USD: 1;
    EUR: 0.92;
    GBP: 0.78;
  }>;
  targets: Default<string[], ["USD", "EUR", "GBP"]>;
}

interface RateUpdateEvent {
  currency?: string;
  rate?: number;
}

interface AmountUpdateEvent {
  amount?: number;
}

const roundTo = (value: number, places: number): number => {
  const multiplier = 10 ** places;
  return Math.round(value * multiplier) / multiplier;
};

const sanitizeCode = (code: unknown, fallback: string): string => {
  if (typeof code === "string") {
    const trimmed = code.trim().toUpperCase();
    if (trimmed.length > 0) return trimmed;
  }
  return fallback;
};

const sanitizeAmount = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return roundTo(value, 2);
};

const sanitizeRate = (value: unknown, fallback: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = roundTo(value, 4);
  return normalized > 0 ? normalized : fallback;
};

const sanitizeRateMap = (
  value: Record<string, number> | undefined,
  base: string,
): Record<string, number> => {
  const sanitized: Record<string, number> = {};
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      const code = sanitizeCode(key, base);
      sanitized[code] = code === base ? 1 : sanitizeRate(value[key], 1);
    }
  }
  sanitized[base] = 1;
  return sanitized;
};

const ensureTargetList = (
  targets: readonly string[] | undefined,
  base: string,
  rateKeys: readonly string[],
): string[] => {
  const codes = new Set<string>();
  codes.add(base);
  if (targets) {
    for (const entry of targets) {
      codes.add(sanitizeCode(entry, base));
    }
  }
  for (const key of rateKeys) {
    codes.add(sanitizeCode(key, base));
  }
  const list = Array.from(codes);
  list.sort((left, right) => left.localeCompare(right));
  return list;
};

const computeConversions = (
  data: {
    amount: number;
    base: string;
    rates: Record<string, number>;
    codes: readonly string[];
  },
): Record<string, number> => {
  const conversions: Record<string, number> = {};
  for (const code of data.codes) {
    if (code === data.base) {
      conversions[code] = roundTo(data.amount, 2);
      continue;
    }
    const rate = sanitizeRate(data.rates[code], 1);
    conversions[code] = roundTo(data.amount * rate, 2);
  }
  return conversions;
};

const setBaseAmount = handler(
  (
    event: AmountUpdateEvent | number | undefined,
    context: { amount: Cell<number> },
  ) => {
    const fallback = sanitizeAmount(context.amount.get(), 0);
    if (typeof event === "number") {
      context.amount.set(sanitizeAmount(event, fallback));
      return;
    }
    if (typeof event?.amount === "number") {
      context.amount.set(sanitizeAmount(event.amount, fallback));
      return;
    }
    if (event === undefined) {
      context.amount.set(fallback);
    }
  },
);

const setConversionRate = handler(
  (
    event: RateUpdateEvent | undefined,
    context: {
      rates: Cell<Record<string, number>>;
      targets: Cell<string[]>;
      baseCurrency: Cell<string>;
    },
  ) => {
    const base = sanitizeCode(context.baseCurrency.get(), "USD");
    const normalized = sanitizeRateMap(context.rates.get(), base);
    const target = sanitizeCode(event?.currency, base);
    const existing = normalized[target] ?? 1;
    const nextRate = target === base ? 1 : sanitizeRate(event?.rate, existing);
    normalized[target] = nextRate;
    normalized[base] = 1;
    context.rates.set({ ...normalized });
    const updatedTargets = ensureTargetList(
      context.targets.get(),
      base,
      Object.keys(normalized),
    );
    context.targets.set(updatedTargets);
  },
);

export const currencyConversionUx = recipe<CurrencyConversionArgs>(
  "Currency Conversion (UX)",
  ({ amount, baseCurrency, rates, targets }) => {
    const baseCode = lift((value: string | undefined) =>
      sanitizeCode(value, "USD")
    )(baseCurrency);

    const normalizedAmount = lift((value: number | undefined) =>
      sanitizeAmount(value, 0)
    )(amount);

    const normalizedRates = lift((inputs: {
      rates: Record<string, number> | undefined;
      base: string;
    }) => sanitizeRateMap(inputs.rates, inputs.base))({
      rates,
      base: baseCode,
    });

    const currencyCodes = lift((inputs: {
      targets: string[] | undefined;
      base: string;
      normalizedRates: Record<string, number>;
    }) =>
      ensureTargetList(
        inputs.targets,
        inputs.base,
        Object.keys(inputs.normalizedRates),
      )
    )({
      targets,
      base: baseCode,
      normalizedRates,
    });

    const conversions = lift((inputs: {
      amount: number;
      base: string;
      rates: Record<string, number>;
      codes: string[];
    }) =>
      computeConversions({
        amount: inputs.amount,
        base: inputs.base,
        rates: inputs.rates,
        codes: inputs.codes,
      })
    )({
      amount: normalizedAmount,
      base: baseCode,
      rates: normalizedRates,
      codes: currencyCodes,
    });

    const conversionList = lift((inputs: {
      codes: string[];
      conversions: Record<string, number>;
    }) =>
      inputs.codes.map((code) => {
        const value = inputs.conversions[code] ?? 0;
        return `${code} ${value.toFixed(2)}`;
      })
    )({
      codes: currencyCodes,
      conversions,
    });

    const currencyCount = lift((codes: string[]) => codes.length)(
      currencyCodes,
    );

    const amountLabel = lift((value: number) => value.toFixed(2))(
      normalizedAmount,
    );

    const summary =
      str`${amountLabel} ${baseCode} across ${currencyCount} currencies`;

    // UI-specific cells and handlers
    const amountField = cell<string>("");
    const currencyField = cell<string>("");
    const rateField = cell<string>("");

    // Sync form fields from actual state
    compute(() => {
      const currentAmount = normalizedAmount.get();
      amountField.set(String(currentAmount));
    });

    const updateAmount = handler(
      (
        _event,
        context: { amount: Cell<number>; amountField: Cell<string> },
      ) => {
        const text = context.amountField.get();
        const parsed = Number(text);
        if (Number.isFinite(parsed) && parsed >= 0) {
          context.amount.set(sanitizeAmount(parsed, 0));
        }
      },
    );

    const updateRate = handler(
      (_event, context: {
        rates: Cell<Record<string, number>>;
        targets: Cell<string[]>;
        baseCurrency: Cell<string>;
        currencyField: Cell<string>;
        rateField: Cell<string>;
      }) => {
        const currency = context.currencyField.get();
        const rateText = context.rateField.get();
        const parsed = Number(rateText);

        if (
          typeof currency === "string" && currency.trim() !== "" &&
          Number.isFinite(parsed) && parsed > 0
        ) {
          const base = sanitizeCode(context.baseCurrency.get(), "USD");
          const normalized = sanitizeRateMap(context.rates.get(), base);
          const target = sanitizeCode(currency, base);
          normalized[target] = sanitizeRate(parsed, 1);
          normalized[base] = 1;
          context.rates.set({ ...normalized });
          const updatedTargets = ensureTargetList(
            context.targets.get(),
            base,
            Object.keys(normalized),
          );
          context.targets.set(updatedTargets);

          // Clear form fields
          context.currencyField.set("");
          context.rateField.set("");
        }
      },
    );

    const name = str`Currency Converter: ${baseCode}`;

    const ui = (
      <ct-card style="padding: 2rem; max-width: 800px; margin: 0 auto;">
        <ct-stack style="gap: 2rem;">
          {/* Header */}
          <ct-stack style="gap: 0.5rem;">
            <ct-text style="font-size: 1.5rem; font-weight: bold; color: #1e40af;">
              💱 Currency Converter
            </ct-text>
            <ct-text style="font-size: 0.9rem; color: #64748b;">
              {summary}
            </ct-text>
          </ct-stack>

          {/* Base Amount Control */}
          <ct-card style="padding: 1.5rem; background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%); border-left: 4px solid #3b82f6;">
            <ct-stack style="gap: 1rem;">
              <ct-text style="font-weight: 600; color: #1e40af;">
                Base Amount ({baseCode})
              </ct-text>
              <ct-stack style="gap: 0.5rem;">
                <ct-input
                  id="amount-input"
                  $value={amountField}
                  type="number"
                  placeholder="Enter amount"
                  style="padding: 0.5rem; border: 1px solid #cbd5e1; border-radius: 4px;"
                />
                <ct-button
                  id="update-amount-button"
                  onClick={updateAmount({ amount, amountField })}
                  style="padding: 0.5rem 1rem; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: 500;"
                >
                  Update Amount
                </ct-button>
              </ct-stack>
            </ct-stack>
          </ct-card>

          {/* Conversion Results */}
          <ct-card style="padding: 1.5rem; background: #f8fafc; border: 1px solid #e2e8f0;">
            <ct-stack style="gap: 1rem;">
              <ct-text style="font-weight: 600; color: #334155;">
                Conversions
              </ct-text>
              {lift(
                (
                  inputs: {
                    codes: string[];
                    conversions: Record<string, number>;
                    base: string;
                  },
                ) => {
                  const elements = [];
                  for (const code of inputs.codes) {
                    const value = inputs.conversions[code] ?? 0;
                    const isBase = code === inputs.base;
                    const backgroundColor = isBase ? "#dbeafe" : "#ffffff";
                    const borderColor = isBase ? "#3b82f6" : "#e2e8f0";

                    elements.push(
                      h(
                        "ct-card",
                        {
                          style: "padding: 1rem; background: " +
                            backgroundColor + "; border: 2px solid " +
                            borderColor +
                            "; display: flex; justify-content: space-between; align-items: center;",
                        },
                        h("ct-text", {
                          style:
                            "font-weight: 600; color: #334155; font-size: 1.1rem;",
                        }, code),
                        h("ct-text", {
                          style:
                            "font-family: monospace; font-size: 1.2rem; color: " +
                            (isBase ? "#1e40af" : "#0f172a") +
                            "; font-weight: bold;",
                        }, value.toFixed(2)),
                      ),
                    );
                  }
                  return h("ct-stack", { style: "gap: 0.5rem;" }, ...elements);
                },
              )({ codes: currencyCodes, conversions, base: baseCode })}
            </ct-stack>
          </ct-card>

          {/* Update Exchange Rate */}
          <ct-card style="padding: 1.5rem; background: linear-gradient(135deg, #fefce8 0%, #fef3c7 100%); border-left: 4px solid #eab308;">
            <ct-stack style="gap: 1rem;">
              <ct-text style="font-weight: 600; color: #854d0e;">
                Update Exchange Rate
              </ct-text>
              <ct-stack style="gap: 0.5rem;">
                <ct-input
                  id="currency-code-input"
                  $value={currencyField}
                  placeholder="Currency code (e.g., JPY)"
                  style="padding: 0.5rem; border: 1px solid #cbd5e1; border-radius: 4px;"
                />
                <ct-input
                  id="exchange-rate-input"
                  $value={rateField}
                  type="number"
                  placeholder="Rate from base currency"
                  style="padding: 0.5rem; border: 1px solid #cbd5e1; border-radius: 4px;"
                />
                <ct-button
                  id="update-rate-button"
                  onClick={updateRate({
                    rates,
                    targets,
                    baseCurrency,
                    currencyField,
                    rateField,
                  })}
                  style="padding: 0.5rem 1rem; background: #eab308; color: #422006; border: none; border-radius: 4px; cursor: pointer; font-weight: 500;"
                >
                  Add/Update Rate
                </ct-button>
              </ct-stack>
            </ct-stack>
          </ct-card>

          {/* Current Rates Reference */}
          <ct-card style="padding: 1.5rem; background: #fafaf9; border: 1px solid #e7e5e4;">
            <ct-stack style="gap: 1rem;">
              <ct-text style="font-weight: 600; color: #57534e;">
                Current Rates (from {baseCode})
              </ct-text>
              {lift(
                (
                  inputs: {
                    codes: string[];
                    rates: Record<string, number>;
                    base: string;
                  },
                ) => {
                  const elements = [];
                  for (const code of inputs.codes) {
                    if (code === inputs.base) continue;
                    const rate = inputs.rates[code] ?? 1;
                    elements.push(
                      h("ct-text", {
                        style:
                          "font-family: monospace; color: #57534e; padding: 0.25rem 0;",
                      }, code + ": " + rate.toFixed(4)),
                    );
                  }
                  return h("ct-stack", { style: "gap: 0.25rem;" }, ...elements);
                },
              )({
                codes: currencyCodes,
                rates: normalizedRates,
                base: baseCode,
              })}
            </ct-stack>
          </ct-card>
        </ct-stack>
      </ct-card>
    );

    return {
      [NAME]: name,
      [UI]: ui,
      amount,
      baseCurrency,
      rates,
      targets,
      baseCode,
      normalizedAmount,
      normalizedRates,
      currencyCodes,
      conversions,
      conversionList,
      currencyCount,
      summary,
      setAmount: setBaseAmount({ amount }),
      updateRate: setConversionRate({
        rates,
        targets,
        baseCurrency,
      }),
    };
  },
);
