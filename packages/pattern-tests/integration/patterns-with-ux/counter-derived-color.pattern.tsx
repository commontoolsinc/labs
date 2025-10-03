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
  UI,
} from "commontools";

interface DerivedColorArgs {
  value: Default<number, 0>;
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

function getColor(count: number): string {
  if (count < 0) return "blue";
  if (count < 5) return "green";
  if (count < 10) return "orange";
  return "red";
}

function getColorLabel(color: string): string {
  const labels: Record<string, string> = {
    blue: "Blue (negative)",
    green: "Green (0-4)",
    orange: "Orange (5-9)",
    red: "Red (10+)",
  };
  return labels[color] || color;
}

function getColorHex(color: string): string {
  const hex: Record<string, string> = {
    blue: "#3b82f6",
    green: "#22c55e",
    orange: "#f97316",
    red: "#ef4444",
  };
  return hex[color] || "#64748b";
}

function getBackgroundColor(color: string): string {
  const bg: Record<string, string> = {
    blue: "#dbeafe",
    green: "#dcfce7",
    orange: "#ffedd5",
    red: "#fee2e2",
  };
  return bg[color] || "#f1f5f9";
}

export const counterWithDerivedColorUx = recipe<DerivedColorArgs>(
  "Counter With Derived Color (UX)",
  ({ value }) => {
    const currentValue = lift((input: number | undefined) => toInteger(input))(
      value,
    );
    const color = derive(currentValue, (current) => getColor(current));
    const colorLabel = derive(color, (c) => getColorLabel(c));
    const colorHex = derive(color, (c) => getColorHex(c));
    const backgroundColor = derive(color, (c) => getBackgroundColor(c));

    const containerStyle = lift(({ bg, fg }: { bg: string; fg: string }) => `
      background: ${bg};
      border: 3px solid ${fg};
      border-radius: 1rem;
      padding: 2rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.75rem;
      transition: all 0.3s ease;
    `)({ bg: backgroundColor, fg: colorHex });

    const valueStyle = lift((fg: string) => `
      font-size: 4rem;
      font-weight: 700;
      color: ${fg};
      line-height: 1;
    `)(colorHex);

    const labelStyle = lift((fg: string) => `
      font-size: 1.1rem;
      font-weight: 600;
      color: ${fg};
    `)(colorHex);

    const amountField = cell<string>("1");
    const amountMagnitude = derive(amountField, (text) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return 1;
      }
      const normalized = Math.abs(Math.trunc(parsed));
      return normalized === 0 ? 1 : normalized;
    });

    const applyIncrease = handler<
      unknown,
      {
        amount: Cell<number>;
        value: Cell<number>;
      }
    >((_event, { amount, value }) => {
      const step = resolveAmount(amount.get());
      const baseline = toInteger(value.get());
      const next = baseline + Math.abs(step);
      value.set(next);
    })({ amount: amountMagnitude, value });

    const applyDecrease = handler<
      unknown,
      {
        amount: Cell<number>;
        value: Cell<number>;
      }
    >((_event, { amount, value }) => {
      const step = resolveAmount(amount.get());
      const baseline = toInteger(value.get());
      const next = baseline - Math.abs(step);
      value.set(next);
    })({ amount: amountMagnitude, value });

    const syncAmountField = compute(() => {
      const text = `${amountMagnitude.get()}`;
      if (amountField.get() !== text) {
        amountField.set(text);
      }
    });

    const currentDisplay = derive(currentValue, (v) => `${v}`);
    const name = str`Color-coded counter (${currentDisplay})`;
    const status = str`Value: ${currentDisplay} • Color: ${colorLabel}`;

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 32rem;
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
                  Derived color visualization
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Watch the color change as you adjust the counter
                </h2>
              </div>

              <div style={containerStyle}>
                <div style={valueStyle}>
                  {currentDisplay}
                </div>
                <div style={labelStyle}>
                  {colorLabel}
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="adjust-amount"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Step size
                  </label>
                  <ct-input
                    id="adjust-amount"
                    type="number"
                    step="1"
                    min="1"
                    $value={amountField}
                    aria-label="Choose how far to adjust the counter"
                  >
                  </ct-input>
                </div>
                <div style="
                    display: flex;
                    gap: 0.5rem;
                    flex-wrap: wrap;
                  ">
                  <ct-button onClick={applyIncrease}>
                    Increase by {amountMagnitude}
                  </ct-button>
                  <ct-button variant="secondary" onClick={applyDecrease}>
                    Decrease by {amountMagnitude}
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
                flex-direction: column;
                gap: 0.5rem;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Color ranges
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.5rem;
              "
            >
              <div style="
                  border: 1px solid #e2e8f0;
                  border-radius: 0.5rem;
                  padding: 0.75rem;
                  display: flex;
                  align-items: center;
                  gap: 0.75rem;
                ">
                <div style="
                    width: 2rem;
                    height: 2rem;
                    border-radius: 0.375rem;
                    background: #3b82f6;
                  ">
                </div>
                <div>
                  <strong style="font-size: 0.9rem; color: #0f172a;">
                    Blue
                  </strong>{" "}
                  <span style="font-size: 0.85rem; color: #475569;">
                    for negative values
                  </span>
                </div>
              </div>
              <div style="
                  border: 1px solid #e2e8f0;
                  border-radius: 0.5rem;
                  padding: 0.75rem;
                  display: flex;
                  align-items: center;
                  gap: 0.75rem;
                ">
                <div style="
                    width: 2rem;
                    height: 2rem;
                    border-radius: 0.375rem;
                    background: #22c55e;
                  ">
                </div>
                <div>
                  <strong style="font-size: 0.9rem; color: #0f172a;">
                    Green
                  </strong>{" "}
                  <span style="font-size: 0.85rem; color: #475569;">
                    for values 0-4
                  </span>
                </div>
              </div>
              <div style="
                  border: 1px solid #e2e8f0;
                  border-radius: 0.5rem;
                  padding: 0.75rem;
                  display: flex;
                  align-items: center;
                  gap: 0.75rem;
                ">
                <div style="
                    width: 2rem;
                    height: 2rem;
                    border-radius: 0.375rem;
                    background: #f97316;
                  ">
                </div>
                <div>
                  <strong style="font-size: 0.9rem; color: #0f172a;">
                    Orange
                  </strong>{" "}
                  <span style="font-size: 0.85rem; color: #475569;">
                    for values 5-9
                  </span>
                </div>
              </div>
              <div style="
                  border: 1px solid #e2e8f0;
                  border-radius: 0.5rem;
                  padding: 0.75rem;
                  display: flex;
                  align-items: center;
                  gap: 0.75rem;
                ">
                <div style="
                    width: 2rem;
                    height: 2rem;
                    border-radius: 0.375rem;
                    background: #ef4444;
                  ">
                </div>
                <div>
                  <strong style="font-size: 0.9rem; color: #0f172a;">
                    Red
                  </strong>{" "}
                  <span style="font-size: 0.85rem; color: #475569;">
                    for values 10+
                  </span>
                </div>
              </div>
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.85rem; color: #475569;"
          >
            {status}
          </div>
        </div>
      ),
      value,
      currentValue,
      color,
      colorLabel,
      colorHex,
      backgroundColor,
      containerStyle,
      valueStyle,
      labelStyle,
      amountField,
      amountMagnitude,
      currentDisplay,
      name,
      status,
      effects: {
        syncAmountField,
      },
      controls: {
        applyIncrease,
        applyDecrease,
      },
    };
  },
);

export default counterWithDerivedColorUx;
