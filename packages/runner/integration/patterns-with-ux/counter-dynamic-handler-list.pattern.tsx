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
  bumpSequence(tracker.sequence);
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

const appendFromField = handler<
  unknown,
  AdjustmentTracker & {
    values: Cell<number[]>;
    valueField: Cell<string>;
  }
>((_event, context) => {
  const text = context.valueField.get();
  const parsed = Number(text);
  const initial = Number.isFinite(parsed) ? parsed : 0;

  const collection = context.values.get();
  const nextIndex = Array.isArray(collection) ? collection.length : 0;

  context.values.push(initial);
  recordAdjustment(context, {
    index: nextIndex,
    amount: 0,
    nextValue: initial,
  });

  context.valueField.set("");
});

const clearValues = handler<
  unknown,
  {
    values: Cell<number[]>;
    valueField: Cell<string>;
  }
>((_event, context) => {
  context.values.set([]);
  context.valueField.set("");
});

const adjustSlotFromFields = handler<
  unknown,
  AdjustmentTracker & {
    values: Cell<number[]>;
    slotIndexField: Cell<string>;
    amountField: Cell<string>;
  }
>((_event, context) => {
  const indexText = context.slotIndexField.get();
  const amountText = context.amountField.get();

  const parsedIndex = Number(indexText);
  const parsedAmount = Number(amountText);

  const collection = context.values.get();
  const list = Array.isArray(collection) ? collection : [];
  const size = list.length;
  const requested = Number.isFinite(parsedIndex) ? Math.trunc(parsedIndex) : -1;

  if (requested < 0 || requested >= size) {
    return;
  }

  const amount = Number.isFinite(parsedAmount) ? Math.trunc(parsedAmount) : 1;
  const target = context.values.key(requested) as Cell<number>;
  const current = toInteger(target.get(), 0);
  const nextValue = current + amount;
  target.set(nextValue);

  recordAdjustment(context, { index: requested, amount, nextValue });
});

export const counterWithDynamicHandlerListUx = recipe<DynamicHandlerArgs>(
  "Counter With Dynamic Handler List (UX)",
  ({ values }) => {
    const valueField = cell<string>("");
    const slotIndexField = cell<string>("0");
    const amountField = cell<string>("1");

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

    const slots = lift((view: number[]) => {
      const list = Array.isArray(view) ? view : [];
      return list.map((rawValue, index) => {
        const value = toInteger(rawValue, 0);
        const name = "Slot " + String(index + 1);
        return {
          index,
          value,
          label: name + ": " + String(value),
          adjust: adjustValue({
            values,
            slotIndex: index,
            lastAdjustment,
            history,
            sequence,
          }),
        };
      });
    })(normalizedValues);

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
    const sequenceView = lift((countValue: number | undefined) =>
      Math.max(0, toInteger(countValue, 0))
    )(sequence);

    const summary = str`${count} counter slots total ${total}`;
    const averageLabel = str`Average ${average}`;
    const add = appendFromField({
      values,
      lastAdjustment,
      history,
      sequence,
      valueField,
    });
    const clear = clearValues({ values, valueField });
    const adjustFromFields = adjustSlotFromFields({
      values,
      lastAdjustment,
      history,
      sequence,
      slotIndexField,
      amountField,
    });

    const name = str`Dynamic Handlers (${count} slots)`;

    const slotsUi = lift((entries: unknown[]) => {
      if (!Array.isArray(entries) || entries.length === 0) {
        return (
          <div style="
              text-align: center;
              padding: 2rem;
              color: #64748b;
              font-style: italic;
            ">
            No slots yet. Add a value to create the first slot.
          </div>
        );
      }

      const items = entries.map((item: any, idx: number) => {
        const slotValue = toInteger(item?.value, 0);
        const slotLabel = item?.label || "Slot " + String(idx + 1);
        const bgColor = "#f0f9ff";
        const borderColor = "#38bdf8";
        const textColor = "#0c4a6e";

        return (
          <div
            key={String(idx)}
            style={"background: " + bgColor +
              "; border: 2px solid " + borderColor +
              "; border-radius: 0.75rem; padding: 1rem; display: flex; flex-direction: column; align-items: center; gap: 0.5rem;"}
          >
            <div
              style={"font-size: 0.75rem; font-weight: 600; color: " +
                textColor +
                "; text-transform: uppercase; letter-spacing: 0.05em;"}
            >
              {slotLabel}
            </div>
            <div style="
                font-size: 2rem;
                font-weight: 700;
                color: #0f172a;
              ">
              {String(slotValue)}
            </div>
          </div>
        );
      });

      return (
        <div style="
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
            gap: 0.75rem;
          ">
          {items}
        </div>
      );
    })(slots);

    const historyUi = lift((entries: AdjustmentRecord[]) => {
      if (!Array.isArray(entries) || entries.length === 0) {
        return (
          <div style="
              text-align: center;
              padding: 1.5rem;
              color: #94a3b8;
              font-size: 0.85rem;
              font-style: italic;
            ">
            No adjustments yet
          </div>
        );
      }

      const items = entries
        .slice()
        .reverse()
        .slice(0, 5)
        .map((record, idx) => {
          const amountColor = record.amount === 0
            ? "#64748b"
            : (record.amount > 0 ? "#22c55e" : "#ef4444");
          const amountSign = record.amount > 0
            ? "+"
            : (record.amount < 0 ? "" : "±");

          return (
            <div
              key={String(idx)}
              style="
                background: #f8fafc;
                border: 1px solid #e2e8f0;
                border-radius: 0.5rem;
                padding: 0.75rem;
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 1rem;
              "
            >
              <div style="
                  font-size: 0.85rem;
                  color: #334155;
                ">
                <strong>Slot {String(record.index)}</strong>
              </div>
              <div style="
                  display: flex;
                  align-items: center;
                  gap: 0.5rem;
                ">
                <span
                  style={"font-weight: 600; color: " + amountColor + ";"}
                >
                  {amountSign + String(record.amount)}
                </span>
                <span style="color: #94a3b8;">→</span>
                <span style="
                    font-weight: 700;
                    color: #0f172a;
                  ">
                  {String(record.nextValue)}
                </span>
              </div>
            </div>
          );
        });

      return (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 0.5rem;
          ">
          {items}
        </div>
      );
    })(historyView);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 56rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1.5rem;
              "
            >
              <div style="display: flex; flex-direction: column; gap: 0.35rem;">
                <span style="
                    color: #475569;
                    font-size: 0.75rem;
                    text-transform: uppercase;
                    letter-spacing: 0.08em;
                  ">
                  Dynamic handler list pattern
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.25rem;
                    line-height: 1.4;
                    color: #0f172a;
                  ">
                  Counter slots with dynamic handlers
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #64748b;
                    line-height: 1.5;
                  ">
                  Demonstrates creating handlers on-the-fly for each slot in a
                  dynamic collection. Each slot gets its own adjust handler, and
                  all adjustments are tracked in a shared history log.
                </p>
              </div>

              <div style="
                  display: grid;
                  gap: 0.75rem;
                  grid-template-columns: repeat(4, minmax(0, 1fr));
                ">
                <div style="
                    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                    color: white;
                  ">
                  <span style="
                      font-size: 0.75rem;
                      opacity: 0.9;
                    ">
                    Slots
                  </span>
                  <strong
                    data-testid="slot-count"
                    style="font-size: 2rem; line-height: 1;"
                  >
                    {count}
                  </strong>
                </div>

                <div style="
                    background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                    color: white;
                  ">
                  <span style="
                      font-size: 0.75rem;
                      opacity: 0.9;
                    ">
                    Total
                  </span>
                  <strong
                    data-testid="total-value"
                    style="font-size: 2rem; line-height: 1;"
                  >
                    {total}
                  </strong>
                </div>

                <div style="
                    background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                    color: white;
                  ">
                  <span style="
                      font-size: 0.75rem;
                      opacity: 0.9;
                    ">
                    Average
                  </span>
                  <strong
                    data-testid="average-value"
                    style="font-size: 2rem; line-height: 1;"
                  >
                    {average}
                  </strong>
                </div>

                <div style="
                    background: linear-gradient(135deg, #ec4899 0%, #db2777 100%);
                    border-radius: 0.75rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                    color: white;
                  ">
                  <span style="
                      font-size: 0.75rem;
                      opacity: 0.9;
                    ">
                    Changes
                  </span>
                  <strong
                    data-testid="sequence-count"
                    style="font-size: 2rem; line-height: 1;"
                  >
                    {sequenceView}
                  </strong>
                </div>
              </div>

              <div style="
                  background: #f8fafc;
                  border-radius: 0.75rem;
                  padding: 1rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <h3 style="
                    margin: 0;
                    font-size: 0.95rem;
                    color: #0f172a;
                    font-weight: 600;
                  ">
                  Add slot
                </h3>
                <div style="
                    display: flex;
                    gap: 0.5rem;
                    align-items: center;
                  ">
                  <ct-input
                    data-testid="value-input"
                    type="number"
                    placeholder="Initial value"
                    $value={valueField}
                    aria-label="Enter initial value"
                    style="flex: 1;"
                  >
                  </ct-input>
                  <ct-button
                    data-testid="add-button"
                    onClick={add}
                    variant="primary"
                  >
                    Add Slot
                  </ct-button>
                  <ct-button
                    data-testid="clear-button"
                    onClick={clear}
                    variant="secondary"
                  >
                    Clear All
                  </ct-button>
                </div>
              </div>

              <div style="
                  border-top: 1px solid #e2e8f0;
                  padding-top: 1rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <h3 style="
                    margin: 0;
                    font-size: 0.95rem;
                    color: #0f172a;
                    font-weight: 600;
                  ">
                  Adjust slot
                </h3>
                <div style="
                    display: grid;
                    grid-template-columns: 120px 120px 1fr;
                    gap: 0.5rem;
                    align-items: center;
                  ">
                  <ct-input
                    data-testid="slot-index-input"
                    type="number"
                    placeholder="Slot #"
                    $value={slotIndexField}
                    aria-label="Slot index"
                  >
                  </ct-input>
                  <ct-input
                    data-testid="amount-input"
                    type="number"
                    placeholder="Amount"
                    $value={amountField}
                    aria-label="Amount to adjust"
                  >
                  </ct-input>
                  <ct-button
                    data-testid="adjust-button"
                    onClick={adjustFromFields}
                    variant="primary"
                  >
                    Adjust Slot
                  </ct-button>
                </div>
                <span style="font-size: 0.75rem; color: #64748b;">
                  Enter a slot index (0-based) and amount to adjust that slot's
                  value.
                </span>
              </div>

              <div style="
                  border-top: 1px solid #e2e8f0;
                  padding-top: 1rem;
                ">
                <h3 style="
                    margin: 0 0 0.75rem 0;
                    font-size: 0.95rem;
                    color: #0f172a;
                    font-weight: 600;
                  ">
                  Counter slots
                </h3>
                {slotsUi}
              </div>

              <div style="
                  border-top: 1px solid #e2e8f0;
                  padding-top: 1rem;
                ">
                <h3 style="
                    margin: 0 0 0.75rem 0;
                    font-size: 0.95rem;
                    color: #0f172a;
                    font-weight: 600;
                  ">
                  Adjustment history (last 5)
                </h3>
                {historyUi}
              </div>
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.85rem; color: #475569;"
          >
            {summary}
          </div>
        </div>
      ),
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
        clear,
        adjustFromFields,
      },
      inputs: {
        valueField,
        slotIndexField,
        amountField,
      },
    };
  },
);

export default counterWithDynamicHandlerListUx;
