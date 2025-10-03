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

interface HistoryCounterArgs {
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

const formatCount = (value: number): string => {
  const safe = Number.isFinite(value) ? value : 0;
  return `${toInteger(safe)}`;
};

export const counterHistoryTrackerUx = recipe<HistoryCounterArgs>(
  "Counter History Tracker (UX)",
  ({ value, history }) => {
    const currentValue = lift((input: number | undefined) => toInteger(input))(
      value,
    );

    const historySize = derive(history, (h) => Array.isArray(h) ? h.length : 0);

    const amountField = cell<string>("1");
    const amountMagnitude = derive(amountField, (text) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        return 1;
      }
      const normalized = Math.abs(Math.trunc(parsed));
      return normalized === 0 ? 1 : normalized;
    });

    const applyIncrement = handler<
      unknown,
      {
        amount: Cell<number>;
        value: Cell<number>;
        history: Cell<number[]>;
      }
    >((_event, { amount, value, history }) => {
      const step = resolveAmount(amount.get());
      const current = toInteger(value.get());
      const next = current + step;
      value.set(next);
      history.push(next);
    })({ amount: amountMagnitude, value, history });

    const applyDecrement = handler<
      unknown,
      {
        amount: Cell<number>;
        value: Cell<number>;
        history: Cell<number[]>;
      }
    >((_event, { amount, value, history }) => {
      const step = resolveAmount(amount.get());
      const current = toInteger(value.get());
      const next = current - step;
      value.set(next);
      history.push(next);
    })({ amount: amountMagnitude, value, history });

    const clearHistory = handler<unknown, { history: Cell<number[]> }>(
      (_event, { history }) => {
        history.set([]);
      },
    )({ history });

    const syncAmountField = compute(() => {
      const text = formatCount(amountMagnitude.get());
      if (amountField.get() !== text) {
        amountField.set(text);
      }
    });

    const currentDisplay = derive(currentValue, (value) => formatCount(value));
    const historySizeDisplay = derive(historySize, (size) => String(size));

    const label =
      str`Value: ${currentDisplay}, History size: ${historySizeDisplay}`;
    const name = str`Counter History Tracker (${currentDisplay})`;

    const historyEntries = lift((historyArray: number[] | undefined) => {
      if (
        !historyArray || !Array.isArray(historyArray) ||
        historyArray.length === 0
      ) {
        return (
          <div style="
              padding: 1.5rem;
              text-align: center;
              color: #94a3b8;
              font-size: 0.9rem;
            ">
            No history yet. Increment or decrement to track changes.
          </div>
        );
      }

      const reversed = historyArray.slice().reverse();
      const maxHeight = Math.max(
        ...historyArray.map((v) => Math.abs(v)),
        1,
      );

      const items = reversed.map((entry, idx) => {
        const isPositive = entry >= 0;
        const absValue = Math.abs(entry);
        const heightPct = (absValue / maxHeight) * 100;
        const bgColor = isPositive ? "#10b981" : "#ef4444";
        const lightBgColor = isPositive ? "#d1fae5" : "#fee2e2";
        const textColor = isPositive ? "#065f46" : "#991b1b";
        const barHeight = String(Math.max(heightPct, 5));

        return (
          <div
            key={String(historyArray.length - idx - 1)}
            style="
              display: flex;
              flex-direction: column;
              align-items: center;
              gap: 0.25rem;
              min-width: 40px;
            "
          >
            <span
              style={"font-size: 0.75rem; font-weight: 600; color: " +
                textColor}
            >
              {String(entry)}
            </span>
            <div
              style={"width: 100%; height: 80px; display: flex; align-items: flex-end; justify-content: center; background: " +
                lightBgColor +
                "; border-radius: 0.25rem; padding: 0.25rem;"}
            >
              <div
                style={"width: 24px; background: " +
                  bgColor +
                  "; border-radius: 0.25rem; height: " +
                  barHeight +
                  "%;"}
              >
              </div>
            </div>
            <span style="font-size: 0.65rem; color: #94a3b8;">
              {String(historyArray.length - idx - 1)}
            </span>
          </div>
        );
      });

      return (
        <div style="
            display: flex;
            gap: 0.5rem;
            overflow-x: auto;
            padding: 0.5rem;
          ">
          {items}
        </div>
      );
    })(history);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 48rem;
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
                  History Tracker
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Track counter value changes over time
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
                      display: flex;
                      justify-content: space-between;
                      font-size: 0.75rem;
                      color: #64748b;
                    ">
                    <span>
                      History entries: {historySizeDisplay}
                    </span>
                  </div>
                </div>

                <div style="
                    display: grid;
                    grid-template-columns: repeat(3, minmax(0, 1fr));
                    gap: 0.75rem;
                  ">
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.4rem;
                    ">
                    <label
                      for="increment-amount"
                      style="
                        font-size: 0.85rem;
                        font-weight: 500;
                        color: #334155;
                      "
                    >
                      Step size
                    </label>
                    <ct-input
                      id="increment-amount"
                      type="number"
                      step="1"
                      min="1"
                      $value={amountField}
                      aria-label="Choose how much to increment or decrement"
                    >
                    </ct-input>
                  </div>
                  <div style="
                      display: flex;
                      gap: 0.5rem;
                      align-items: flex-end;
                    ">
                    <ct-button
                      onClick={applyIncrement}
                      aria-label="Increment counter and record in history"
                    >
                      +{amountMagnitude}
                    </ct-button>
                    <ct-button
                      variant="secondary"
                      onClick={applyDecrement}
                      aria-label="Decrement counter and record in history"
                    >
                      -{amountMagnitude}
                    </ct-button>
                  </div>
                  <div style="
                      display: flex;
                      align-items: flex-end;
                    ">
                    <ct-button
                      variant="secondary"
                      onClick={clearHistory}
                      aria-label="Clear history"
                    >
                      Clear history
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
                Value history
              </h3>
              <span style="font-size: 0.85rem; color: #64748b;">
                {historySizeDisplay} entries
              </span>
            </div>
            <div slot="content">
              {historyEntries}
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
      history,
      currentValue,
      historySize,
      label,
      amountField,
      amountMagnitude,
      currentDisplay,
      historySizeDisplay,
      effects: {
        syncAmountField,
      },
      controls: {
        applyIncrement,
        applyDecrement,
        clearHistory,
      },
    };
  },
);

export default counterHistoryTrackerUx;
