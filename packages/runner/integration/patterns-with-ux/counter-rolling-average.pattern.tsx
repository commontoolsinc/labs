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

interface RollingAverageArgs {
  value: Default<number, 0>;
  history: Default<number[], []>;
  window: Default<number, 5>;
}

type RollingContext = {
  value: Cell<number>;
  history: Cell<number[]>;
  window: Cell<number>;
};

const formatNumber = (input: number): string => {
  const value = Number.isFinite(input) ? input : 0;
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(2);
};

const applyChange = (amount: number, context: RollingContext) => {
  const delta = Number.isFinite(amount) ? amount : 0;
  const currentValue = context.value.get();
  const next = (typeof currentValue === "number" ? currentValue : 0) + delta;
  context.value.set(next);

  const windowSize = context.window.get();
  const limit = Number.isFinite(windowSize) && windowSize > 0
    ? Math.floor(windowSize)
    : 5;
  const current = context.history.get();
  const entries = Array.isArray(current) ? current : [];
  const updated = [...entries, next].slice(-limit);
  context.history.set(updated);
};

const recordAndAverage = handler(
  (
    event: { amount?: number } | undefined,
    context: RollingContext,
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    applyChange(amount, context);
  },
);

const incrementBy = (amount: number) =>
  handler<unknown, RollingContext>((_event, context) => {
    applyChange(amount, context);
  });

const applyCustomAmount = handler<
  unknown,
  RollingContext & { amount: Cell<number>; field: Cell<string> }
>((_event, context) => {
  const nextAmount = context.amount.get();
  applyChange(nextAmount, context);
  context.field.set(formatNumber(nextAmount));
});

const applyWindowSize = handler<
  unknown,
  RollingContext & { candidate: Cell<number>; field: Cell<string> }
>((_event, context) => {
  const nextWindow = context.candidate.get();
  context.window.set(nextWindow);
  const entries = context.history.get();
  const sanitizedHistory = Array.isArray(entries) ? entries : [];
  context.history.set(sanitizedHistory.slice(-nextWindow));
  context.field.set(`${nextWindow}`);
});

export const counterRollingAverageUx = recipe<RollingAverageArgs>(
  "Counter With Rolling Average (UX)",
  ({ value, history, window }) => {
    const initialize = compute(() => {
      if (typeof value.get() !== "number") {
        value.set(0);
      }
      if (!Array.isArray(history.get())) {
        history.set([]);
      }
      const windowValue = window.get();
      if (typeof windowValue !== "number" || windowValue <= 0) {
        window.set(5);
      }
    });

    const average = lift((entries: number[] | undefined) => {
      const list = Array.isArray(entries) ? entries : [];
      if (list.length === 0) return 0;
      const total = list.reduce((sum, item) => sum + item, 0);
      return total / list.length;
    })(history);
    const currentValue = lift((count: number | undefined) =>
      typeof count === "number" ? count : 0
    )(value);
    const historyView = lift((entries: number[] | undefined) =>
      Array.isArray(entries) ? entries : []
    )(history);

    const windowSize = derive(window, (size) => {
      const parsed = Number(size);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return 5;
      }
      return Math.floor(parsed);
    });
    const averageDisplay = derive(average, (value) => formatNumber(value ?? 0));
    const currentDisplay = derive(currentValue, (value) => formatNumber(value));
    const historyDisplay = derive(
      historyView,
      (entries) =>
        entries.map((entry, index) => ({
          id: `${index}-${entry}`,
          label: formatNumber(entry),
        })),
    );
    const historyBadges = lift(({ entries }: {
      entries: { id: string; label: string }[];
    }) => {
      if (entries.length === 0) {
        return [
          <span
            key="empty"
            style="color: #94a3b8; font-size: 0.85rem;"
          >
            No readings yet. Use the controls above to start.
          </span>,
        ];
      }
      return entries.map((entry) => (
        <span
          key={entry.id}
          style="
            padding: 0.35rem 0.6rem;
            border-radius: 9999px;
            background: #f8fafc;
            border: 1px solid #cbd5f5;
            font-size: 0.85rem;
          "
        >
          {entry.label}
        </span>
      ));
    })({ entries: historyDisplay });

    const amountField = cell<string>("1");
    const customAmount = derive(amountField, (text) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed) || parsed === 0) {
        return 1;
      }
      return Math.round(parsed * 100) / 100;
    });
    const customAmountDisplay = derive(
      customAmount,
      (value) => formatNumber(value),
    );

    const windowField = cell<string>("5");
    const windowCandidate = derive(windowField, (text) => {
      const parsed = Number(text);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return 5;
      }
      return Math.floor(parsed);
    });

    const increment = recordAndAverage({ value, history, window });
    const addOne = incrementBy(1)({ value, history, window });
    const addFive = incrementBy(5)({ value, history, window });
    const subtractOne = incrementBy(-1)({ value, history, window });
    const subtractFive = incrementBy(-5)({ value, history, window });
    const applyCustom = applyCustomAmount({
      value,
      history,
      window,
      amount: customAmount,
      field: amountField,
    });
    const updateWindow = applyWindowSize({
      value,
      history,
      window,
      candidate: windowCandidate,
      field: windowField,
    });
    const syncWindowField = compute(() => {
      const target = `${windowSize.get()}`;
      if (windowField.get() !== target) {
        windowField.set(target);
      }
    });

    const name = str`Rolling average (${windowSize} window)`;
    const status =
      str`Total ${currentDisplay} • Average ${averageDisplay} over ${windowSize} entries`;

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
                gap: 1rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <span style="
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                    color: #475569;
                  ">
                  Rolling window tracker
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.4rem;
                    line-height: 1.35;
                  ">
                  Monitor trends over the last {windowSize} entries
                </h2>
                <p style="
                    margin: 0;
                    color: #475569;
                    font-size: 0.95rem;
                  ">
                  Track how each update shifts the cumulative total and rolling
                  average for your chosen window size.
                </p>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(2, minmax(0, 1fr));
                  gap: 0.75rem;
                ">
                <div style="
                    background: #f1f5f9;
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.35rem;
                  ">
                  <span style="
                      font-size: 0.8rem;
                      color: #475569;
                      text-transform: uppercase;
                      letter-spacing: 0.04em;
                    ">
                    Current total
                  </span>
                  <strong
                    data-testid="current-value"
                    style="
                      font-size: 2rem;
                      line-height: 1;
                    "
                  >
                    {currentDisplay}
                  </strong>
                </div>
                <div style="
                    background: #e2e8f0;
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.35rem;
                  ">
                  <span style="
                      font-size: 0.8rem;
                      color: #475569;
                      text-transform: uppercase;
                      letter-spacing: 0.04em;
                    ">
                    Rolling average
                  </span>
                  <strong
                    data-testid="average-value"
                    style="
                      font-size: 2rem;
                      line-height: 1;
                    "
                  >
                    {averageDisplay}
                  </strong>
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
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
                  flex-wrap: wrap;
                  gap: 0.5rem;
                ">
                <ct-button
                  data-testid="add-one"
                  onClick={addOne}
                >
                  Add 1
                </ct-button>
                <ct-button
                  data-testid="add-five"
                  onClick={addFive}
                  variant="secondary"
                >
                  Add 5
                </ct-button>
                <ct-button
                  data-testid="subtract-one"
                  onClick={subtractOne}
                  variant="ghost"
                >
                  Subtract 1
                </ct-button>
                <ct-button
                  data-testid="subtract-five"
                  onClick={subtractFive}
                  variant="ghost"
                >
                  Subtract 5
                </ct-button>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <label
                  for="custom-amount"
                  style="
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: #334155;
                  "
                >
                  Custom change
                </label>
                <div style="
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.5rem;
                    align-items: center;
                  ">
                  <ct-input
                    id="custom-amount"
                    type="number"
                    step="0.1"
                    $value={amountField}
                    aria-label="Set custom increment amount"
                  >
                  </ct-input>
                  <ct-button
                    data-testid="apply-custom"
                    onClick={applyCustom}
                  >
                    Apply {customAmountDisplay}
                  </ct-button>
                </div>
                <span style="
                    font-size: 0.8rem;
                    color: #64748b;
                  ">
                  Invalid or zero values fall back to 1.
                </span>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <label
                  for="window-size"
                  style="
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: #334155;
                  "
                >
                  Window size
                </label>
                <div style="
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.5rem;
                    align-items: center;
                  ">
                  <ct-input
                    id="window-size"
                    type="number"
                    min="1"
                    step="1"
                    $value={windowField}
                    aria-label="Number of entries in the rolling window"
                  >
                  </ct-input>
                  <ct-button
                    data-testid="update-window"
                    variant="secondary"
                    onClick={updateWindow}
                  >
                    Update to {windowCandidate}
                  </ct-button>
                </div>
                <span style="
                    font-size: 0.8rem;
                    color: #64748b;
                  ">
                  Entries are automatically trimmed to match the window.
                </span>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <span style="
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: #334155;
                  ">
                  Recent totals
                </span>
                <div
                  data-testid="history-list"
                  style="
                    display: flex;
                    flex-wrap: wrap;
                    gap: 0.4rem;
                  "
                >
                  {historyBadges}
                </div>
              </div>
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="
              font-size: 0.9rem;
              color: #334155;
            "
          >
            {status}
          </div>
        </div>
      ),
      value,
      history,
      window,
      average,
      currentValue,
      historyView,
      label: str`Average ${average}`,
      windowSize,
      averageDisplay,
      currentDisplay,
      historyDisplay,
      historyBadges,
      increment,
      controls: {
        addOne,
        addFive,
        subtractOne,
        subtractFive,
        applyCustom,
        updateWindow,
      },
      inputs: {
        amountField,
        customAmount,
        windowField,
        windowCandidate,
      },
      status,
      effects: { initialize, syncWindowField },
    };
  },
);

export default counterRollingAverageUx;
