/// <cts-enable />
import { Cell, compute, handler, lift, recipe, str } from "commontools";

interface RollingAverageArgs {
  value?: number;
  history?: number[];
  window?: number;
}

const recordAndAverage = handler(
  (
    event: { amount?: number } | undefined,
    context: {
      value: Cell<number>;
      history: Cell<number[]>;
      window: Cell<number>;
    },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const currentValue = context.value.get();
    const next = (typeof currentValue === "number" ? currentValue : 0) +
      amount;
    context.value.set(next);

    const windowSize = context.window.get();
    const limit = typeof windowSize === "number" && windowSize > 0
      ? Math.floor(windowSize)
      : 5;
    const current = context.history.get();
    const currentList = Array.isArray(current) ? current : [];
    const updated = [...currentList, next].slice(-limit);
    context.history.set(updated);
  },
);

export const counterWithRollingAverage = recipe<RollingAverageArgs>(
  "Counter With Rolling Average",
  ({ value, history, window }) => {
    value.setDefault(0);
    history.setDefault([]);
    window.setDefault(5);

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

    return {
      value,
      history,
      window,
      average,
      currentValue,
      historyView,
      label: str`Average ${average}`,
      increment: recordAndAverage({ value, history, window }),
      effects: { initialize },
    };
  },
);
