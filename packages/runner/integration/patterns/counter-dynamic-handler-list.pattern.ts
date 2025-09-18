/// <cts-enable />
import {
  type Cell,
  cell,
  createCell,
  Default,
  derive,
  handler,
  lift,
  recipe,
  str,
  toSchema,
} from "commontools";

interface DynamicHandlerArgs {
  values: Default<number[], []>;
}

interface AdjustmentRecord {
  index: number;
  amount: number;
  nextValue: number;
}

type AdjustmentTracker = {
  lastAdjustment: Cell<AdjustmentRecord>;
  history: Cell<AdjustmentRecord[]>;
  sequence: Cell<number>;
};

const adjustmentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["index", "amount", "nextValue"],
  properties: {
    index: { type: "number" },
    amount: { type: "number" },
    nextValue: { type: "number" },
  },
} as const;

const toInteger = (input: unknown, fallback = 0): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return Math.trunc(input);
};

const bumpSequence = (sequence: Cell<number>): number => {
  const current = toInteger(sequence.get(), 0);
  const next = current + 1;
  sequence.set(next);
  return next;
};

const recordAdjustment = (
  tracker: AdjustmentTracker,
  record: AdjustmentRecord,
) => {
  tracker.lastAdjustment.set(record);
  tracker.history.push(record);
  const id = bumpSequence(tracker.sequence);
  createCell<AdjustmentRecord>(
    adjustmentSchema,
    `dynamicHandlerRecord-${id}`,
    record,
  );
};

const adjustValue = handler(
  (
    event: { amount?: number } | undefined,
    context: AdjustmentTracker & {
      values: Cell<number[]>;
      slotIndex: number;
    },
  ) => {
    const collection = context.values.get();
    const list = Array.isArray(collection) ? collection : [];
    const size = list.length;
    const requested = toInteger(context.slotIndex, -1);
    if (requested < 0 || requested >= size) {
      return;
    }

    const amount = toInteger(event?.amount, 1);
    const target = context.values.key(requested) as Cell<number>;
    const current = toInteger(target.get(), 0);
    const nextValue = current + amount;
    target.set(nextValue);

    recordAdjustment(context, { index: requested, amount, nextValue });
  },
);

const appendValue = handler(
  (
    event: { initial?: number } | undefined,
    context: AdjustmentTracker & {
      values: Cell<number[]>;
    },
  ) => {
    const collection = context.values.get();
    const nextIndex = Array.isArray(collection) ? collection.length : 0;
    const initial = toInteger(event?.initial, 0);

    context.values.push(initial);
    recordAdjustment(context, {
      index: nextIndex,
      amount: 0,
      nextValue: initial,
    });
  },
);

export const counterWithDynamicHandlerList = recipe<DynamicHandlerArgs>(
  "Counter With Dynamic Handler List",
  ({ values }) => {
    const lastAdjustment = cell<AdjustmentRecord>({
      index: -1,
      amount: 0,
      nextValue: 0,
    });
    const history = cell<AdjustmentRecord[]>([]);
    const sequence = cell(0);

    const normalizedValues = lift((entries: number[] | undefined) => {
      if (!Array.isArray(entries)) return [] as number[];
      return entries.map((item) => toInteger(item, 0));
    })(values);

    const count = derive(normalizedValues, (entries) => entries.length);
    const total = derive(
      normalizedValues,
      (entries) => entries.reduce((sum, value) => sum + value, 0),
    );
    const average = lift((entries: number[] | undefined) => {
      const list = Array.isArray(entries) ? entries : [];
      if (list.length === 0) return 0;
      const sum = list.reduce((acc, value) => acc + value, 0);
      const rawAverage = sum / list.length;
      return Math.round(rawAverage * 100) / 100;
    })(normalizedValues);

    const slots = lift(
      toSchema<
        {
          values: Cell<number[]>;
          view: Cell<number[]>;
          lastAdjustment: Cell<AdjustmentRecord>;
          history: Cell<AdjustmentRecord[]>;
          sequence: Cell<number>;
        }
      >(),
      toSchema<unknown>(),
      ({ values, view, lastAdjustment, history, sequence }) => {
        const snapshot = view.get();
        const list = Array.isArray(snapshot) ? snapshot : [];
        return list.map((rawValue, index) => {
          const value = toInteger(rawValue, 0);
          const name = `Slot ${index + 1}`;
          return {
            index,
            value,
            label: `${name}: ${value}`,
            adjust: adjustValue({
              values,
              slotIndex: index,
              lastAdjustment,
              history,
              sequence,
            }),
          };
        });
      },
    )({
      values,
      view: normalizedValues,
      lastAdjustment,
      history,
      sequence,
    });

    const handlers = lift((entries: unknown) => {
      if (!Array.isArray(entries)) return [] as unknown[];
      return entries.map((item: any) => item?.adjust);
    })(slots);

    const historyView = lift((entries: AdjustmentRecord[] | undefined) => {
      return Array.isArray(entries) ? entries : [];
    })(history);
    const lastAdjustmentView = lift(
      (record: AdjustmentRecord | undefined) =>
        record ?? { index: -1, amount: 0, nextValue: 0 },
    )(lastAdjustment);
    const sequenceView = lift((count: number | undefined) =>
      Math.max(0, toInteger(count, 0))
    )(sequence);

    const summary = str`${count} counter slots total ${total}`;
    const averageLabel = str`Average ${average}`;
    const add = appendValue({
      values,
      lastAdjustment,
      history,
      sequence,
    });

    return {
      values: normalizedValues,
      slots,
      handlers,
      count,
      total,
      average,
      summary,
      averageLabel,
      lastAdjustment: lastAdjustmentView,
      history: historyView,
      sequence: sequenceView,
      controls: {
        add,
      },
    };
  },
);
