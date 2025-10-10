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

interface BoundedCounterArgs {
  value: Default<number, 0>;
  min: Default<number, 0>;
  max: Default<number, 10>;
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

const adjustCounter = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number>; min: Cell<number>; max: Cell<number> },
  ) => {
    const amount = resolveAmount(event?.amount);
    const minValue = toInteger(context.min.get());
    const maxValue = toInteger(context.max.get());
    const current = toInteger(context.value.get());
    const next = Math.min(Math.max(current + amount, minValue), maxValue);
    context.value.set(next);
  },
);

export const boundedCounterUx = recipe<BoundedCounterArgs>(
  "Bounded Counter (UX)",
  ({ value, min, max }) => {
    const currentValue = lift((input: number | undefined) => toInteger(input))(
      value,
    );
    const minValue = lift((input: number | undefined) => toInteger(input))(min);
    const maxValue = lift((input: number | undefined) => toInteger(input, 10))(
      max,
    );

    const clampEffect = compute(() => {
      const current = toInteger(value.get());
      const minVal = toInteger(min.get());
      const maxVal = toInteger(max.get(), minVal);
      const normalized = Math.min(Math.max(current, minVal), maxVal);
      if (normalized !== current) value.set(normalized);
      return normalized;
    });

    const adjust = adjustCounter({ value, min, max });

    const amountField = cell<string>("1");
    const amountMagnitude = derive(amountField, (text) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return 1;
      }
      const normalized = Math.abs(Math.trunc(parsed));
      return normalized === 0 ? 1 : normalized;
    });

    const minField = cell<string>("0");
    const maxField = cell<string>("10");

    const applyIncrease = handler<
      unknown,
      {
        amount: Cell<number>;
        value: Cell<number>;
        min: Cell<number>;
        max: Cell<number>;
      }
    >((_event, { amount, value, min, max }) => {
      const step = resolveAmount(amount.get());
      const minVal = toInteger(min.get());
      const maxVal = toInteger(max.get(), minVal);
      const current = toInteger(value.get());
      const next = Math.min(current + Math.abs(step), maxVal);
      value.set(next);
    })({ amount: amountMagnitude, value, min, max });

    const applyDecrease = handler<
      unknown,
      {
        amount: Cell<number>;
        value: Cell<number>;
        min: Cell<number>;
        max: Cell<number>;
      }
    >((_event, { amount, value, min, max }) => {
      const step = resolveAmount(amount.get());
      const minVal = toInteger(min.get());
      const maxVal = toInteger(max.get(), minVal);
      const current = toInteger(value.get());
      const next = Math.max(current - Math.abs(step), minVal);
      value.set(next);
    })({ amount: amountMagnitude, value, min, max });

    const applyMin = handler<
      unknown,
      {
        input: Cell<string>;
        min: Cell<number>;
        value: Cell<number>;
        max: Cell<number>;
      }
    >((_event, { input, min, value, max }) => {
      const text = input.get() ?? "0";
      const parsed = Number(text);
      const newMin = toInteger(parsed);
      min.set(newMin);
      const current = toInteger(value.get());
      const maxVal = toInteger(max.get(), newMin);
      if (current < newMin) {
        value.set(newMin);
      }
      if (maxVal < newMin) {
        max.set(newMin);
      }
    })({ input: minField, min, value, max });

    const applyMax = handler<
      unknown,
      {
        input: Cell<string>;
        max: Cell<number>;
        value: Cell<number>;
        min: Cell<number>;
      }
    >((_event, { input, max, value, min }) => {
      const text = input.get() ?? "10";
      const parsed = Number(text);
      const newMax = toInteger(parsed, 10);
      max.set(newMax);
      const current = toInteger(value.get());
      const minVal = toInteger(min.get());
      if (current > newMax) {
        value.set(newMax);
      }
      if (minVal > newMax) {
        min.set(newMax);
      }
    })({ input: maxField, max, value, min });

    const syncMinField = compute(() => {
      const text = formatCount(minValue.get());
      if (minField.get() !== text) {
        minField.set(text);
      }
    });

    const syncMaxField = compute(() => {
      const text = formatCount(maxValue.get());
      if (maxField.get() !== text) {
        maxField.set(text);
      }
    });

    const syncAmountField = compute(() => {
      const text = formatCount(amountMagnitude.get());
      if (amountField.get() !== text) {
        amountField.set(text);
      }
    });

    const currentDisplay = derive(currentValue, (value) => formatCount(value));
    const minDisplay = derive(minValue, (value) => formatCount(value));
    const maxDisplay = derive(maxValue, (value) => formatCount(value));

    const label =
      str`Value ${currentDisplay} (min ${minDisplay}, max ${maxDisplay})`;
    const name = str`Bounded counter (${currentDisplay})`;

    const atMin = lift((
      { current, minimum }: { current: number; minimum: number },
    ) => current <= minimum)({ current: currentValue, minimum: minValue });

    const atMax = lift((
      { current, maximum }: { current: number; maximum: number },
    ) => current >= maximum)({ current: currentValue, maximum: maxValue });

    const range = lift((
      { minimum, maximum }: { minimum: number; maximum: number },
    ) => maximum - minimum)({ minimum: minValue, maximum: maxValue });

    const progress = lift(
      (
        { current, minimum, maximum }: {
          current: number;
          minimum: number;
          maximum: number;
        },
      ) => {
        const span = maximum - minimum;
        if (span === 0) return 0;
        return ((current - minimum) / span) * 100;
      },
    )({ current: currentValue, minimum: minValue, maximum: maxValue });

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
                  Bounded Counter
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Adjust within minimum and maximum bounds
                </h2>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <div style="
                    background: #f8fafc;
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.5rem;
                  ">
                  <div style="
                      display: flex;
                      justify-content: space-between;
                      align-items: baseline;
                    ">
                    <span style="font-size: 0.8rem; color: #475569;">
                      Current value
                    </span>
                    <strong style="font-size: 2rem; color: #0f172a;">
                      {currentDisplay}
                    </strong>
                  </div>

                  <div style="
                      position: relative;
                      height: 0.5rem;
                      background: #e2e8f0;
                      border-radius: 0.25rem;
                      overflow: hidden;
                    ">
                    <div
                      style={lift(
                        (pct: number) =>
                          `position: absolute; left: 0; top: 0; bottom: 0; width: ${pct}%; background: linear-gradient(90deg, #3b82f6, #6366f1); border-radius: 0.25rem; transition: width 0.2s ease;`,
                      )(progress)}
                    >
                    </div>
                  </div>

                  <div style="
                      display: flex;
                      justify-content: space-between;
                      font-size: 0.75rem;
                      color: #64748b;
                    ">
                    <span>Min: {minDisplay}</span>
                    <span>Range: {range}</span>
                    <span>Max: {maxDisplay}</span>
                  </div>
                </div>

                <div style="
                    display: grid;
                    grid-template-columns: repeat(2, minmax(0, 1fr));
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
                      align-items: flex-end;
                    ">
                    <ct-button
                      id="increment-button"
                      onClick={applyIncrease}
                      disabled={atMax}
                      aria-label="Increase counter"
                    >
                      +{amountMagnitude}
                    </ct-button>
                    <ct-button
                      id="decrement-button"
                      variant="secondary"
                      onClick={applyDecrease}
                      disabled={atMin}
                      aria-label="Decrease counter"
                    >
                      -{amountMagnitude}
                    </ct-button>
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
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Boundary settings
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: grid;
                grid-template-columns: repeat(2, minmax(0, 1fr));
                gap: 1rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.4rem;
                ">
                <label
                  for="min-value"
                  style="
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: #334155;
                  "
                >
                  Minimum value
                </label>
                <ct-input
                  id="min-value"
                  type="number"
                  step="1"
                  $value={minField}
                  aria-label="Set the minimum boundary"
                >
                </ct-input>
                <ct-button
                  variant="secondary"
                  onClick={applyMin}
                  style="margin-top: 0.25rem;"
                >
                  Apply minimum
                </ct-button>
              </div>
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.4rem;
                ">
                <label
                  for="max-value"
                  style="
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: #334155;
                  "
                >
                  Maximum value
                </label>
                <ct-input
                  id="max-value"
                  type="number"
                  step="1"
                  $value={maxField}
                  aria-label="Set the maximum boundary"
                >
                </ct-input>
                <ct-button
                  variant="secondary"
                  onClick={applyMax}
                  style="margin-top: 0.25rem;"
                >
                  Apply maximum
                </ct-button>
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
      min,
      max,
      currentValue,
      minValue,
      maxValue,
      label,
      adjust,
      amountField,
      amountMagnitude,
      minField,
      maxField,
      currentDisplay,
      minDisplay,
      maxDisplay,
      atMin,
      atMax,
      range,
      progress,
      effects: {
        clampEffect,
        syncMinField,
        syncMaxField,
        syncAmountField,
      },
      controls: {
        applyIncrease,
        applyDecrease,
        applyMin,
        applyMax,
      },
    };
  },
);

export default boundedCounterUx;
