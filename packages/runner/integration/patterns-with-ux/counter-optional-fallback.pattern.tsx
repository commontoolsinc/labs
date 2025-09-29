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

interface OptionalFallbackArgs {
  value?: number;
  defaultValue: Default<number, 10>;
}

const toInteger = (input: unknown, fallback = 0): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.trunc(input);
};

const resolveAmount = (input: unknown): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return 1;
  }
  return Math.trunc(input);
};

const formatCount = (value: number): string => {
  const safe = Number.isFinite(value) ? value : 0;
  return `${toInteger(safe)}`;
};

const bumpWithFallback = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number>; defaultValue: Cell<number> },
  ) => {
    const amount = resolveAmount(event?.amount);
    const currentRaw = context.value.get();
    const fallback = context.defaultValue.get();
    const base = typeof currentRaw === "number"
      ? currentRaw
      : typeof fallback === "number"
      ? fallback
      : 10;
    context.value.set(base + amount);
  },
);

const resetToFallback = handler(
  (
    _event: unknown,
    context: { value: Cell<number>; defaultValue: Cell<number> },
  ) => {
    const fallback = context.defaultValue.get();
    const safeDefault = typeof fallback === "number" ? fallback : 10;
    context.value.set(safeDefault);
  },
);

const clearValue = handler(
  (
    _event: unknown,
    context: { value: Cell<number> },
  ) => {
    context.value.set(undefined as any);
  },
);

const updateDefaultValue = handler(
  (
    _event: unknown,
    context: { input: Cell<string>; defaultValue: Cell<number> },
  ) => {
    const text = context.input.get() ?? "10";
    const parsed = Number(text);
    const newDefault = toInteger(parsed, 10);
    context.defaultValue.set(newDefault);
  },
);

export const counterWithOptionalFallbackUx = recipe<OptionalFallbackArgs>(
  "Counter With Optional Fallback (UX)",
  ({ value, defaultValue }) => {
    const fallbackEffect = compute(() => {
      const fallback = defaultValue.get() ?? 10;
      const current = value.get();
      if (typeof current !== "number") {
        value.set(fallback);
      }
      return fallback;
    });

    const safeDefault = lift((fallback: number | undefined) =>
      typeof fallback === "number" ? fallback : 10
    )(defaultValue);

    const safeValue = lift((inputs: { value?: number; fallback?: number }) => {
      if (typeof inputs.value === "number") return inputs.value;
      if (typeof inputs.fallback === "number") return inputs.fallback;
      return 10;
    })({ value, fallback: defaultValue });

    const valueIsDefined = lift((val: number | undefined) =>
      typeof val === "number"
    )(value);

    const label = str`Value ${safeValue} (default ${safeDefault})`;
    const name = str`Counter with fallback (${safeValue})`;

    const amountField = cell<string>("1");
    const defaultField = cell<string>("10");

    const syncDefaultField = compute(() => {
      const text = formatCount(safeDefault.get());
      if (defaultField.get() !== text) {
        defaultField.set(text);
      }
    });

    const increment = bumpWithFallback({ value, defaultValue });
    const reset = resetToFallback({ value, defaultValue });
    const clear = clearValue({ value });
    const applyDefault = updateDefaultValue({
      input: defaultField,
      defaultValue,
    });

    const currentDisplay = lift((val: number) => formatCount(val))(safeValue);
    const defaultDisplay = lift((val: number) => formatCount(val))(safeDefault);

    const statusStyle = lift((isDefined: boolean) => {
      if (isDefined) {
        return "background: #dcfce7; border: 2px solid #16a34a; color: #166534; padding: 0.75rem; border-radius: 0.5rem; font-weight: 500;";
      }
      return "background: #fef3c7; border: 2px solid #f59e0b; color: #92400e; padding: 0.75rem; border-radius: 0.5rem; font-weight: 500;";
    })(valueIsDefined);

    const statusText = lift((isDefined: boolean) => {
      if (isDefined) {
        return "✓ Value is set";
      }
      return "⚠ Value is undefined (using fallback)";
    })(valueIsDefined);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 36rem;
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
                  Optional Fallback Pattern
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Counter with optional value and default fallback
                </h2>
                <p style="
                    margin: 0.5rem 0 0 0;
                    font-size: 0.9rem;
                    color: #64748b;
                    line-height: 1.5;
                  ">
                  Demonstrates how undefined values fall back to defaults. The
                  counter uses the actual value if set, or the default value
                  when undefined.
                </p>
              </div>

              <div style={statusStyle}>
                {statusText}
              </div>

              <div style="
                  background: #f8fafc;
                  border-radius: 0.75rem;
                  padding: 1.25rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: baseline;
                  ">
                  <span style="font-size: 0.8rem; color: #475569;">
                    Current value
                  </span>
                  <strong style="font-size: 2.5rem; color: #0f172a;">
                    {currentDisplay}
                  </strong>
                </div>

                <div style="
                    display: flex;
                    gap: 0.75rem;
                    flex-wrap: wrap;
                  ">
                  <ct-button onClick={increment} aria-label="Increment counter">
                    + Increment
                  </ct-button>
                  <ct-button
                    variant="secondary"
                    onClick={reset}
                    aria-label="Reset to default value"
                  >
                    ↻ Reset to default
                  </ct-button>
                  <ct-button
                    variant="secondary"
                    onClick={clear}
                    aria-label="Clear value (set to undefined)"
                  >
                    ✕ Clear value
                  </ct-button>
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
                Fallback configuration
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
                  display: flex;
                  flex-direction: column;
                  gap: 0.4rem;
                ">
                <label
                  for="default-value"
                  style="
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: #334155;
                  "
                >
                  Default value (fallback)
                </label>
                <div style="
                    display: flex;
                    gap: 0.75rem;
                    align-items: flex-start;
                  ">
                  <ct-input
                    id="default-value"
                    type="number"
                    step="1"
                    $value={defaultField}
                    aria-label="Set the default fallback value"
                    style="flex: 1;"
                  >
                  </ct-input>
                  <ct-button
                    variant="secondary"
                    onClick={applyDefault}
                    aria-label="Apply new default value"
                  >
                    Apply default
                  </ct-button>
                </div>
                <span style="
                    font-size: 0.8rem;
                    color: #64748b;
                    margin-top: 0.25rem;
                  ">
                  Current default: {defaultDisplay}
                </span>
              </div>

              <div style="
                  background: #eff6ff;
                  border-left: 3px solid #3b82f6;
                  padding: 0.75rem;
                  border-radius: 0.25rem;
                  font-size: 0.85rem;
                  color: #1e40af;
                  line-height: 1.5;
                ">
                <strong>Fallback resolution:</strong>{" "}
                When the value is undefined, the counter falls back to the
                default value (
                {defaultDisplay}). If the default is also undefined, it uses 10
                as a final fallback.
              </div>
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.85rem; color: #475569;"
          >
            {label}
          </div>
        </div>
      ),
      value,
      defaultValue,
      current: safeValue,
      effectiveDefault: safeDefault,
      label,
      increment,
      valueIsDefined,
      currentDisplay,
      defaultDisplay,
      effects: { fallbackEffect, syncDefaultField },
      controls: {
        reset,
        clear,
        applyDefault,
      },
    };
  },
);

export default counterWithOptionalFallbackUx;
