/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

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

const incrementByIndex = handler(
  (
    event: { index?: number } | undefined,
    context: { counters: Cell<CounterEntry[]> },
  ) => {
    if (!event || typeof event.index !== "number") {
      return;
    }

    const list = context.counters.get() ?? [];
    if (event.index < 0 || event.index >= list.length) {
      return;
    }

    const entryCell = context.counters.key(event.index) as Cell<CounterEntry>;
    const valueCell = entryCell.key("value") as Cell<number>;
    const current = typeof valueCell.get() === "number" ? valueCell.get() : 0;
    valueCell.set(current + 1);
  },
);

const decrementByIndex = handler(
  (
    event: { index?: number } | undefined,
    context: { counters: Cell<CounterEntry[]> },
  ) => {
    if (!event || typeof event.index !== "number") {
      return;
    }

    const list = context.counters.get() ?? [];
    if (event.index < 0 || event.index >= list.length) {
      return;
    }

    const entryCell = context.counters.key(event.index) as Cell<CounterEntry>;
    const valueCell = entryCell.key("value") as Cell<number>;
    const current = typeof valueCell.get() === "number" ? valueCell.get() : 0;
    valueCell.set(current - 1);
  },
);

export const counterAggregatorUx = recipe<CounterAggregatorArgs>(
  "Counter Aggregator (UX)",
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

    const smallest = lift((numbers: number[]) => {
      if (numbers.length === 0) {
        return 0;
      }

      return numbers.reduce(
        (min, value) => value < min ? value : min,
        numbers[0],
      );
    })(values);

    const average = lift(
      ({ total, count }: { total: number; count: number }) => {
        if (count === 0) return 0;
        return Math.round((total / count) * 100) / 100;
      },
    )({ total, count });

    const name = str`Counter Aggregator: ${count} counters`;

    const labelField = cell<string>("");
    const valueField = cell<string>("");

    const addCounterHandler = handler(
      (
        _event: unknown,
        context: {
          counters: Cell<CounterEntry[]>;
          labelField: Cell<string>;
          valueField: Cell<string>;
        },
      ) => {
        const list = context.counters.get() ?? [];
        const label = context.labelField.get() ?? "";
        const valueStr = context.valueField.get() ?? "";
        const value = valueStr.trim() !== "" ? parseInt(valueStr, 10) : 0;

        const finalLabel = label.trim() !== ""
          ? label.trim()
          : `Counter ${list.length + 1}`;
        const id = `counter-${list.length + 1}`;

        context.counters.set([
          ...list,
          { id, label: finalLabel, value: isNaN(value) ? 0 : value },
        ]);

        context.labelField.set("");
        context.valueField.set("");
      },
    );

    const indexField = cell<string>("");
    const adjustAmountField = cell<string>("");

    const addHandler = addCounterHandler({ counters, labelField, valueField });
    const incrementHandler = incrementByIndex({ counters });
    const decrementHandler = decrementByIndex({ counters });

    const adjustByFieldHandler = handler(
      (
        _event: unknown,
        context: {
          counters: Cell<CounterEntry[]>;
          indexField: Cell<string>;
          adjustAmountField: Cell<string>;
        },
      ) => {
        const indexStr = context.indexField.get() ?? "";
        const amountStr = context.adjustAmountField.get() ?? "";
        const index = parseInt(indexStr, 10);
        const amount = parseInt(amountStr, 10);

        if (isNaN(index) || isNaN(amount)) {
          return;
        }

        const list = context.counters.get() ?? [];
        if (index < 0 || index >= list.length) {
          return;
        }

        const entryCell = context.counters.key(index) as Cell<CounterEntry>;
        const valueCell = entryCell.key("value") as Cell<number>;
        const current = typeof valueCell.get() === "number"
          ? valueCell.get()
          : 0;
        valueCell.set(current + amount);

        context.adjustAmountField.set("");
      },
    );

    const adjustHandler = adjustByFieldHandler({
      counters,
      indexField,
      adjustAmountField,
    });

    const countersUI = lift(
      (entries: AggregatedCounter[]) => {
        if (entries.length === 0) {
          return h(
            "div",
            {
              style:
                "padding: 2rem; text-align: center; color: #64748b; font-style: italic;",
            },
            "No counters yet. Add one to get started!",
          );
        }

        const elements = [];
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];

          const valueColor = entry.value < 0
            ? "#ef4444"
            : entry.value > 0
            ? "#10b981"
            : "#64748b";

          const valueBg = entry.value < 0
            ? "#fee2e2"
            : entry.value > 0
            ? "#dcfce7"
            : "#f1f5f9";

          elements.push(
            h(
              "div",
              {
                style:
                  "background: white; border-radius: 0.5rem; padding: 1rem; border: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center;",
              },
              h(
                "div",
                {
                  style:
                    "display: flex; flex-direction: column; gap: 0.25rem; flex: 1;",
                },
                h(
                  "span",
                  {
                    style:
                      "font-weight: 600; color: #0f172a; font-size: 0.95rem;",
                  },
                  entry.label,
                ),
                h(
                  "span",
                  {
                    style:
                      "font-size: 0.75rem; color: #94a3b8; font-family: monospace;",
                  },
                  "Index: " + String(i),
                ),
              ),
              h(
                "div",
                {
                  style: "background: " + valueBg +
                    "; border-radius: 0.5rem; padding: 0.5rem 1rem; min-width: 4rem; text-align: center;",
                },
                h(
                  "span",
                  {
                    style: "font-size: 1.5rem; font-weight: 700; color: " +
                      valueColor + "; font-family: monospace;",
                  },
                  String(entry.value),
                ),
              ),
            ),
          );
        }

        return h(
          "div",
          { style: "display: flex; flex-direction: column; gap: 0.75rem;" },
          ...elements,
        );
      },
    )(sanitizedCounters);

    return {
      [NAME]: name,
      [UI]: (
        <div style="display: flex; flex-direction: column; gap: 1.5rem; max-width: 48rem;">
          <ct-card>
            <div
              slot="content"
              style="display: flex; flex-direction: column; gap: 1.5rem;"
            >
              <div style="display: flex; flex-direction: column; gap: 0.25rem;">
                <span style="color: #475569; font-size: 0.75rem; letter-spacing: 0.08em; text-transform: uppercase;">
                  Counter Aggregator
                </span>
                <h2 style="margin: 0; font-size: 1.3rem; color: #0f172a;">
                  Manage multiple counters with aggregate statistics
                </h2>
              </div>

              <div style="background: linear-gradient(135deg, #dbeafe, #bfdbfe); border-radius: 0.75rem; padding: 1.5rem;">
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 1rem;">
                  <div style="display: flex; flex-direction: column; align-items: center; gap: 0.25rem;">
                    <span style="font-size: 0.75rem; color: #1e40af; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
                      Total
                    </span>
                    <span style="font-size: 2.5rem; font-weight: 700; color: #1e3a8a; font-family: monospace;">
                      {total}
                    </span>
                  </div>

                  <div style="display: flex; flex-direction: column; align-items: center; gap: 0.25rem;">
                    <span style="font-size: 0.75rem; color: #1e40af; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
                      Count
                    </span>
                    <span style="font-size: 2.5rem; font-weight: 700; color: #1e3a8a; font-family: monospace;">
                      {count}
                    </span>
                  </div>

                  <div style="display: flex; flex-direction: column; align-items: center; gap: 0.25rem;">
                    <span style="font-size: 0.75rem; color: #1e40af; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
                      Average
                    </span>
                    <span style="font-size: 2.5rem; font-weight: 700; color: #1e3a8a; font-family: monospace;">
                      {average}
                    </span>
                  </div>

                  <div style="display: flex; flex-direction: column; align-items: center; gap: 0.25rem;">
                    <span style="font-size: 0.75rem; color: #1e40af; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
                      Largest
                    </span>
                    <span style="font-size: 2.5rem; font-weight: 700; color: #1e3a8a; font-family: monospace;">
                      {largest}
                    </span>
                  </div>

                  <div style="display: flex; flex-direction: column; align-items: center; gap: 0.25rem;">
                    <span style="font-size: 0.75rem; color: #1e40af; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;">
                      Smallest
                    </span>
                    <span style="font-size: 2.5rem; font-weight: 700; color: #1e3a8a; font-family: monospace;">
                      {smallest}
                    </span>
                  </div>
                </div>
              </div>

              <div style="background: #fefce8; border-radius: 0.5rem; padding: 1rem; border-left: 4px solid #eab308;">
                <h3 style="margin: 0 0 0.75rem 0; font-size: 0.875rem; color: #713f12; font-weight: 600;">
                  Add New Counter
                </h3>
                <div style="display: grid; grid-template-columns: 2fr 1fr auto; gap: 0.75rem; align-items: end;">
                  <div style="display: flex; flex-direction: column; gap: 0.25rem;">
                    <label style="font-size: 0.75rem; color: #713f12; font-weight: 500;">
                      Label
                    </label>
                    <ct-input
                      $value={labelField}
                      placeholder="Counter label"
                      aria-label="Counter label"
                    />
                  </div>
                  <div style="display: flex; flex-direction: column; gap: 0.25rem;">
                    <label style="font-size: 0.75rem; color: #713f12; font-weight: 500;">
                      Initial Value
                    </label>
                    <ct-input
                      $value={valueField}
                      type="number"
                      placeholder="0"
                      aria-label="Initial value"
                    />
                  </div>
                  <ct-button onClick={addHandler} aria-label="Add counter">
                    Add Counter
                  </ct-button>
                </div>
              </div>

              <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                <h3 style="margin: 0; font-size: 1rem; color: #0f172a; font-weight: 600;">
                  Counters
                </h3>
                {countersUI}
              </div>

              <div style="background: #eff6ff; border-radius: 0.5rem; padding: 1rem; border-left: 4px solid #3b82f6;">
                <h3 style="margin: 0 0 0.75rem 0; font-size: 0.875rem; color: #1e40af; font-weight: 600;">
                  Adjust Counter Value
                </h3>
                <div style="display: grid; grid-template-columns: 1fr 1fr auto; gap: 0.75rem; align-items: end;">
                  <div style="display: flex; flex-direction: column; gap: 0.25rem;">
                    <label style="font-size: 0.75rem; color: #1e40af; font-weight: 500;">
                      Counter Index
                    </label>
                    <ct-input
                      $value={indexField}
                      type="number"
                      placeholder="0"
                      aria-label="Counter index"
                    />
                  </div>
                  <div style="display: flex; flex-direction: column; gap: 0.25rem;">
                    <label style="font-size: 0.75rem; color: #1e40af; font-weight: 500;">
                      Amount (+/-)
                    </label>
                    <ct-input
                      $value={adjustAmountField}
                      type="number"
                      placeholder="1"
                      aria-label="Adjustment amount"
                    />
                  </div>
                  <ct-button
                    onClick={adjustHandler}
                    aria-label="Adjust counter"
                  >
                    Adjust
                  </ct-button>
                </div>
              </div>

              <div style="background: #f8fafc; border-radius: 0.5rem; padding: 1rem; font-size: 0.85rem; color: #475569; line-height: 1.5;">
                <strong>Pattern:</strong>{" "}
                This demonstrates managing multiple counters with real-time
                aggregate statistics. Add counters with initial values, then
                adjust them by specifying the counter index (shown in each card)
                and an adjustment amount (positive to increment, negative to
                decrement). The system tracks total, count, average, largest,
                and smallest values across all counters. Color-coded values show
                negative (red), zero (gray), and positive (green) states.
              </div>
            </div>
          </ct-card>
        </div>
      ),
      counters: sanitizedCounters,
      values,
      total,
      count,
      largest,
      summary: str`Aggregate total ${total} across ${count} counters`,
      adjust: adjustCounter({ counters }),
      append: appendCounter({ counters }),
    };
  },
);

export default counterAggregatorUx;
