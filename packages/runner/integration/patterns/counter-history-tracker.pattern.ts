/// <cts-enable />
import { Cell, handler, recipe, str } from "commontools";

interface HistoryCounterArgs {
  value?: number;
  history?: number[];
}

const trackIncrement = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number>; history: Cell<number[]> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
    context.history.push(next);
  },
);

export const counterWithHistory = recipe<HistoryCounterArgs>(
  "Counter History Tracker",
  ({ value, history }) => {
    value.setDefault(0);
    history.setDefault([]);

    const label = str`History size: ${history}`;

    return {
      value,
      history,
      label,
      increment: trackIncrement({ value, history }),
    };
  },
);
