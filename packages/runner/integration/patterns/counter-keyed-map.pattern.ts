/// <cts-enable />
import { Cell, Default, handler, lift, recipe, str } from "commontools";

interface KeyedMapArgs {
  counters: Default<Record<string, number>, { [key: string]: number }>;
}

const adjustKeyedCounter = handler(
  (
    event: { key?: string; amount?: number } | undefined,
    context: { counters: Cell<Record<string, number>> },
  ) => {
    const key = typeof event?.key === "string" ? event.key : "default";
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const entry = context.counters.key(key) as Cell<number>;
    const current = entry.get() ?? 0;
    entry.set(current + amount);
  },
);

export const counterMapByKey = recipe<KeyedMapArgs>(
  "Counter Map By Key",
  ({ counters }) => {
    const keys = lift((map: Record<string, number>) => Object.keys(map).sort())(
      counters,
    );
    const total = lift((map: Record<string, number>) =>
      Object.values(map).reduce((sum, value) => sum + value, 0)
    )(counters);
    const count = lift((map: Record<string, number>) =>
      Object.keys(map).length
    )(counters);
    const summary = str`${count} keys total ${total}`;

    return {
      counters,
      keys,
      count,
      total,
      summary,
      adjust: adjustKeyedCounter({ counters }),
    };
  },
);
