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
  toSchema,
  UI,
} from "commontools";

interface DerivedMinMaxArgs {
  value: Default<number, 0>;
  history: Default<number[], []>;
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

const sanitizeHistory = (entries: number[] | undefined): number[] => {
  if (!Array.isArray(entries)) {
    return [];
  }
  const sanitized: number[] = [];
  for (const entry of entries) {
    sanitized.push(toInteger(entry));
  }
  return sanitized;
};

const minimumOf = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  let min = values[0];
  for (const value of values) {
    if (value < min) {
      min = value;
    }
  }
  return min;
};

const maximumOf = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  let max = values[0];
  for (const value of values) {
    if (value > max) {
      max = value;
    }
  }
  return max;
};

const adjustCounter = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number>; history: Cell<number[]> },
  ) => {
    const amount = resolveAmount(event?.amount);
    const current = toInteger(context.value.get());
    const next = current + amount;
    context.value.set(next);
    context.history.push(next);
  },
);

const computeLimits = lift(
  toSchema<{ values: Cell<number[]>; current: Cell<number> }>(),
  toSchema<{ min: number; max: number }>(),
  ({ values, current }) => {
    const entries = sanitizeHistory(values.get());
    const baseline = toInteger(current.get());
    if (entries.length === 0) {
      return { min: baseline, max: baseline };
    }
    return {
      min: minimumOf(entries),
      max: maximumOf(entries),
    };
  },
);

const formatCount = (value: number): string => {
  const safe = Number.isFinite(value) ? value : 0;
  return `${toInteger(safe)}`;
};

const describeHistory = (entries: number[]) => {
  if (entries.length === 0) {
    return [
      {
        id: "empty",
        title: "No values recorded",
        detail: "Adjust the counter to capture min and max boundaries.",
      },
    ];
  }
  return entries
    .slice(-5)
    .reverse()
    .map((value, index) => {
      const position = entries.length - index;
      return {
        id: `entry-${position}`,
        title: `#${position} → ${formatCount(value)}`,
        detail: position === entries.length
          ? "Most recent value"
          : "Earlier adjustment",
      };
    });
};

export const counterWithDerivedMinMaxUx = recipe<DerivedMinMaxArgs>(
  "Counter With Derived Min Max (UX)",
  ({ value, history }) => {
    const currentValue = lift((input: number | undefined) => toInteger(input))(
      value,
    );
    const historyValues = lift(sanitizeHistory)(history);
    const limits = computeLimits({
      values: historyValues,
      current: currentValue,
    });
    const minValue = derive(limits, (snapshot) => snapshot.min);
    const maxValue = derive(limits, (snapshot) => snapshot.max);
    const label = str`Min: ${minValue}, Max: ${maxValue}`;

    const adjust = adjustCounter({ value, history });

    const amountField = cell<string>("1");
    const amountMagnitude = derive(amountField, (text) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return 1;
      }
      const normalized = Math.abs(Math.trunc(parsed));
      return normalized === 0 ? 1 : normalized;
    });

    const targetField = cell<string>("");
    const targetCandidate = lift(({ input, fallback }: {
      input: string;
      fallback: number;
    }) => {
      const parsed = Number(input);
      if (!Number.isFinite(parsed)) {
        return fallback;
      }
      return toInteger(parsed);
    })({ input: targetField, fallback: currentValue });

    const historyList = derive(
      historyValues,
      (entries) => describeHistory(entries),
    );
    const historyCards = lift(({ items }: {
      items: ReturnType<typeof describeHistory>;
    }) =>
      items.map((item) => (
        <div
          key={item.id}
          style="
            border: 1px solid #e2e8f0;
            border-radius: 0.75rem;
            padding: 0.75rem;
            display: flex;
            flex-direction: column;
            gap: 0.25rem;
          "
        >
          <strong style="font-size: 0.95rem; color: #0f172a;">
            {item.title}
          </strong>
          <span style="font-size: 0.8rem; color: #475569;">
            {item.detail}
          </span>
        </div>
      ))
    )({ items: historyList });

    const currentDisplay = derive(currentValue, (value) => formatCount(value));
    const minDisplay = derive(minValue, (value) => formatCount(value));
    const maxDisplay = derive(maxValue, (value) => formatCount(value));
    const historyCount = derive(historyValues, (entries) => entries.length);
    const historyCountDisplay = derive(
      historyCount,
      (count) => formatCount(count),
    );

    const status = str`Current ${currentDisplay} • Min ${minDisplay} • Max \
${maxDisplay} • ${historyCountDisplay} recorded`;
    const name = str`Derived min/max counter (${currentDisplay})`;

    const applyIncrease = handler<
      unknown,
      {
        amount: Cell<number>;
        value: Cell<number>;
        history: Cell<number[]>;
      }
    >((_event, { amount, value, history }) => {
      const step = resolveAmount(amount.get());
      const baseline = toInteger(value.get());
      const next = baseline + Math.abs(step);
      value.set(next);
      history.push(next);
    })({ amount: amountMagnitude, value, history });

    const applyDecrease = handler<
      unknown,
      {
        amount: Cell<number>;
        value: Cell<number>;
        history: Cell<number[]>;
      }
    >((_event, { amount, value, history }) => {
      const step = resolveAmount(amount.get());
      const baseline = toInteger(value.get());
      const next = baseline - Math.abs(step);
      value.set(next);
      history.push(next);
    })({ amount: amountMagnitude, value, history });

    const applyTarget = handler<
      unknown,
      {
        desired: Cell<number>;
        value: Cell<number>;
        history: Cell<number[]>;
      }
    >((_event, { desired, value, history }) => {
      const goal = toInteger(desired.get(), toInteger(value.get()));
      value.set(goal);
      history.push(goal);
    })({ desired: targetCandidate, value, history });

    const syncAmountField = compute(() => {
      const text = formatCount(amountMagnitude.get());
      if (amountField.get() !== text) {
        amountField.set(text);
      }
    });

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
                  Min / max tracker
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Watch the counter boundaries move with each step
                </h2>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(3, minmax(0, 1fr));
                  gap: 0.75rem;
                ">
                <div style="
                    background: #f8fafc;
                    border-radius: 0.75rem;
                    padding: 0.75rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="font-size: 0.75rem; color: #475569;">
                    Current value
                  </span>
                  <strong style="font-size: 1.3rem; color: #0f172a;">
                    {currentDisplay}
                  </strong>
                </div>
                <div style="
                    background: #ecfdf3;
                    border-radius: 0.75rem;
                    padding: 0.75rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="font-size: 0.75rem; color: #15803d;">
                    Recorded minimum
                  </span>
                  <strong style="font-size: 1.3rem; color: #166534;">
                    {minDisplay}
                  </strong>
                </div>
                <div style="
                    background: #eef2ff;
                    border-radius: 0.75rem;
                    padding: 0.75rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="font-size: 0.75rem; color: #4338ca;">
                    Recorded maximum
                  </span>
                  <strong style="font-size: 1.3rem; color: #312e81;">
                    {maxDisplay}
                  </strong>
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
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
                    <ct-button onClick={applyIncrease}>
                      Increase by {amountMagnitude}
                    </ct-button>
                    <ct-button
                      variant="secondary"
                      onClick={applyDecrease}
                    >
                      Decrease by {amountMagnitude}
                    </ct-button>
                  </div>
                </div>

                <div style="
                    display: grid;
                    grid-template-columns: repeat(2, minmax(0, 1fr));
                    gap: 0.75rem;
                    align-items: end;
                  ">
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.4rem;
                    ">
                    <label
                      for="target-value"
                      style="
                        font-size: 0.85rem;
                        font-weight: 500;
                        color: #334155;
                      "
                    >
                      Jump to value
                    </label>
                    <ct-input
                      id="target-value"
                      type="number"
                      step="1"
                      $value={targetField}
                      aria-label="Set the counter to a specific value"
                    >
                    </ct-input>
                  </div>
                  <ct-button onClick={applyTarget}>
                    Set counter to {targetCandidate}
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
                Recent history
              </h3>
              <ct-badge variant="outline">
                {historyCountDisplay} values
              </ct-badge>
            </div>
            <div
              slot="content"
              style="
                display: grid;
                gap: 0.5rem;
              "
            >
              {historyCards}
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
      history: historyValues,
      minValue,
      maxValue,
      label,
      adjust,
      amountField,
      amountMagnitude,
      targetField,
      targetCandidate,
      currentValue,
      currentDisplay,
      minDisplay,
      maxDisplay,
      historyCount,
      historyCountDisplay,
      historyList,
      historyCards,
      status,
      name,
      effects: {
        syncAmountField,
      },
      controls: {
        applyIncrease,
        applyDecrease,
        applyTarget,
      },
    };
  },
);

export default counterWithDerivedMinMaxUx;
