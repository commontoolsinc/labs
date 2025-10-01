/// <cts-enable />
import { Cell, Default, handler, lift, recipe, str } from "commontools";

interface CounterEntry {
  id?: string;
  label?: string;
  value?: number;
}

interface AggregatedCounter {
  id: string;
  label: string;
  value: number;
}

interface CounterAggregatorArgs {
  counters: Default<CounterEntry[], []>;
}

type AdjustEvent = {
  id?: string;
  index?: number;
  delta?: number;
  set?: number;
};

type AppendEvent = {
  id?: string;
  label?: string;
  value?: number;
};

const adjustCounter = handler(
  (
    event: AdjustEvent | undefined,
    context: { counters: Cell<CounterEntry[]> },
  ) => {
    if (!event) {
      return;
    }

    const list = context.counters.get() ?? [];
    let index = -1;

    if (event.id) {
      index = list.findIndex((entry) => entry.id === event.id);
    }

    if (index === -1 && typeof event.index === "number") {
      index = event.index;
    }

    if (index === -1) {
      return;
    }

    const entryCell = context.counters.key(index) as Cell<CounterEntry>;
    const valueCell = entryCell.key("value") as Cell<number>;
    const current = typeof valueCell.get() === "number" ? valueCell.get() : 0;
    const delta = typeof event.delta === "number" ? event.delta : 0;
    const nextValue = typeof event.set === "number"
      ? event.set
      : current + delta;

    valueCell.set(nextValue);
  },
);

const appendCounter = handler(
  (
    event: AppendEvent | undefined,
    context: { counters: Cell<CounterEntry[]> },
  ) => {
    const list = context.counters.get() ?? [];
    const id = event?.id && event.id.length > 0
      ? event.id
      : `counter-${list.length + 1}`;

    if (list.some((entry) => entry.id === id)) {
      return;
    }

    const value = typeof event?.value === "number" ? event.value : 0;
    const label = event?.label ?? `Counter ${list.length + 1}`;

    context.counters.set([
      ...list,
      { id, label, value },
    ]);
  },
);

export const counterAggregator = recipe<CounterAggregatorArgs>(
  "Counter Aggregator",
  ({ counters }) => {
    const sanitizedCounters = lift((entries: CounterEntry[]) =>
      entries.map((entry, index) => ({
        id: entry.id && entry.id.length > 0 ? entry.id : `counter-${index + 1}`,
        label: entry.label ?? `Counter ${index + 1}`,
        value: typeof entry.value === "number" ? entry.value : 0,
      }))
    )(counters);

    const values = lift((entries: AggregatedCounter[]) =>
      entries.map((entry) => entry.value)
    )(sanitizedCounters);

    const total = lift((numbers: number[]) =>
      numbers.reduce((sum, value) => sum + value, 0)
    )(values);

    const count = lift((numbers: number[]) => numbers.length)(values);

    const largest = lift((numbers: number[]) => {
      if (numbers.length === 0) {
        return 0;
      }

      return numbers.reduce(
        (max, value) => value > max ? value : max,
        numbers[0],
      );
    })(values);

    const summary = str`Aggregate total ${total} across ${count} counters`;

    const labels = lift((entries: AggregatedCounter[]) =>
      entries.map((entry) => entry.label)
    )(sanitizedCounters);

    return {
      counters: sanitizedCounters,
      values,
      total,
      count,
      largest,
      labels,
      summary,
      adjust: adjustCounter({ counters }),
      append: appendCounter({ counters }),
    };
  },
);
