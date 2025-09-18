/// <cts-enable />
import { Cell, handler, lift, recipe, str } from "commontools";

interface AggregatorArgs {
  counters?: number[];
}

const adjustCounter = handler(
  (
    event: { index?: number; amount?: number } | undefined,
    context: { counters: Cell<number[]> },
  ) => {
    const index = event?.index ?? 0;
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const target = context.counters.key(index) as Cell<number>;
    const current = target.get() ?? 0;
    target.set(current + amount);
  },
);

export const counterAggregator = recipe<AggregatorArgs>(
  "Counter Aggregator",
  ({ counters }) => {
    counters.setDefault([]);

    const total = lift((values: number[]) =>
      values.reduce((sum, value) => sum + value, 0)
    )(counters);
    const count = lift((values: number[]) => values.length)(counters);
    const summary = str`Total ${total} across ${count}`;

    return {
      counters,
      total,
      count,
      summary,
      adjust: adjustCounter({ counters }),
    };
  },
);
