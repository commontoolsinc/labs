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

interface OpaqueMapArgs {
  value: Default<number, 0>;
  history: Default<number[], []>;
  labelPrefix: Default<string, "Value">;
}

interface RecordEvent {
  delta?: number;
}

interface RewriteEvent {
  index?: number;
  value?: number;
}

const recordValue = handler(
  (
    event: RecordEvent | undefined,
    context: { value: Cell<number>; history: Cell<number[]> },
  ) => {
    const delta = typeof event?.delta === "number" ? event.delta : 1;
    const current = context.value.get() ?? 0;
    const next = current + delta;
    context.value.set(next);
    context.history.push(next);
  },
);

const rewriteHistoryEntry = handler(
  (
    event: RewriteEvent | undefined,
    context: { history: Cell<number[]> },
  ) => {
    if (typeof event?.value !== "number") return;
    const targetIndex = typeof event.index === "number" ? event.index : 0;
    const values = context.history.get();
    if (!Array.isArray(values)) return;
    if (targetIndex < 0 || targetIndex >= values.length) return;

    const entryCell = context.history.key(targetIndex) as Cell<number>;
    entryCell.set(event.value);
  },
);

const clampToNumberArray = (entries: number[] | undefined) => {
  if (!Array.isArray(entries)) return [] as number[];
  return entries.filter((item): item is number => typeof item === "number");
};

export const counterWithOpaqueRefMapUx = recipe<OpaqueMapArgs>(
  "Counter With OpaqueRef Map (UX)",
  ({ value, history, labelPrefix }) => {
    const safeHistory = lift(clampToNumberArray)(history);
    const labels = safeHistory.map((entry, index) => str`#${index}: ${entry}`);

    const count = derive(
      history,
      (entries) => clampToNumberArray(entries).length,
    );
    const total = derive(
      history,
      (entries) =>
        clampToNumberArray(entries).reduce((sum, item) => sum + item, 0),
    );
    const headline = str`${labelPrefix} ${value} (${count} entries)`;

    // UI-specific handlers and cells
    const deltaField = cell<string>("1");
    const deltaAmount = derive(deltaField, (text) => {
      const parsed = Number(text);
      return Number.isFinite(parsed) ? Math.trunc(parsed) : 1;
    });

    const indexField = cell<string>("");
    const newValueField = cell<string>("");

    const recordHandler = handler<
      unknown,
      {
        delta: Cell<number>;
        value: Cell<number>;
        history: Cell<number[]>;
      }
    >((_event, { delta, value, history }) => {
      const amount = delta.get() ?? 1;
      const current = value.get() ?? 0;
      const next = current + amount;
      value.set(next);
      history.push(next);
      deltaField.set("1");
    })({ delta: deltaAmount, value, history });

    const rewriteHandler = handler<
      unknown,
      {
        indexField: Cell<string>;
        newValueField: Cell<string>;
        history: Cell<number[]>;
      }
    >((_event, { indexField, newValueField, history }) => {
      const indexStr = indexField.get();
      const valueStr = newValueField.get();
      if (
        typeof indexStr !== "string" || indexStr.trim() === "" ||
        typeof valueStr !== "string" || valueStr.trim() === ""
      ) {
        return;
      }

      const targetIndex = Number(indexStr);
      const newValue = Number(valueStr);
      if (!Number.isFinite(targetIndex) || !Number.isFinite(newValue)) return;

      const values = history.get();
      if (!Array.isArray(values)) return;
      const idx = Math.trunc(targetIndex);
      if (idx < 0 || idx >= values.length) return;

      const entryCell = history.key(idx) as Cell<number>;
      entryCell.set(Math.trunc(newValue));

      indexField.set("");
      newValueField.set("");
    })({ indexField, newValueField, history });

    const name = str`Opaque Ref Map (${count} entries)`;

    const historyCards = lift((entries: number[]) => {
      if (!Array.isArray(entries) || entries.length === 0) {
        return h(
          "div",
          {
            style:
              "padding: 1.5rem; background: #f8fafc; border-radius: 0.5rem; border: 2px dashed #cbd5e1; text-align: center; color: #64748b;",
          },
          "No history entries yet. Record a value to start!",
        );
      }

      const cards = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const bg = i % 2 === 0 ? "#ffffff" : "#f8fafc";
        cards.push(
          h(
            "div",
            {
              style:
                "display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 1rem; background: " +
                bg +
                "; border: 1px solid #e2e8f0; border-radius: 0.375rem;",
            },
            h(
              "div",
              { style: "display: flex; align-items: center; gap: 0.75rem;" },
              h(
                "span",
                {
                  style:
                    "font-family: monospace; font-size: 0.75rem; color: #94a3b8; font-weight: 600;",
                },
                "#" + String(i),
              ),
              h(
                "span",
                {
                  style:
                    "font-size: 1.125rem; font-weight: 600; color: #0f172a;",
                },
                String(entry),
              ),
            ),
          ),
        );
      }

      return h(
        "div",
        {
          style:
            "display: flex; flex-direction: column; gap: 0.5rem; max-height: 20rem; overflow-y: auto; padding: 0.25rem;",
        },
        ...cards,
      );
    })(safeHistory);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 36rem;
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
                  OpaqueRef Map Pattern
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Track history with rewritable entries
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.875rem;
                    color: #64748b;
                    line-height: 1.5;
                  ">
                  This pattern demonstrates using opaque refs to track array
                  entries. Each history entry can be individually rewritten by
                  accessing its cell reference through
                  <code>history.key(index)</code>.
                </p>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(3, minmax(0, 1fr));
                  gap: 1rem;
                ">
                <div style="
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    padding: 1rem;
                    border-radius: 0.5rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="font-size: 0.75rem; opacity: 0.9;">
                    Current Value
                  </span>
                  <span style="font-size: 2rem; font-weight: 700;">
                    {value}
                  </span>
                </div>
                <div style="
                    background: #f1f5f9;
                    padding: 1rem;
                    border-radius: 0.5rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="font-size: 0.75rem; color: #64748b;">
                    Entries
                  </span>
                  <span style="font-size: 2rem; font-weight: 700; color: #0f172a;">
                    {count}
                  </span>
                </div>
                <div style="
                    background: #f1f5f9;
                    padding: 1rem;
                    border-radius: 0.5rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="font-size: 0.75rem; color: #64748b;">
                    Total Sum
                  </span>
                  <span style="font-size: 2rem; font-weight: 700; color: #0f172a;">
                    {total}
                  </span>
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
                Record new value
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                gap: 0.75rem;
                align-items: flex-end;
              "
            >
              <div style="
                  flex: 1;
                  display: flex;
                  flex-direction: column;
                  gap: 0.4rem;
                ">
                <label
                  for="delta-amount"
                  style="
                    font-size: 0.85rem;
                    font-weight: 500;
                    color: #334155;
                  "
                >
                  Delta amount
                </label>
                <ct-input
                  id="delta-amount"
                  type="number"
                  step="1"
                  $value={deltaField}
                  aria-label="Amount to add to current value"
                >
                </ct-input>
              </div>
              <ct-button onClick={recordHandler} aria-label="Record value">
                Record +{deltaAmount}
              </ct-button>
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
                History entries
              </h3>
              <span style="
                  font-size: 0.75rem;
                  color: #64748b;
                  background: #f1f5f9;
                  padding: 0.25rem 0.5rem;
                  border-radius: 0.25rem;
                ">
                {count} total
              </span>
            </div>
            <div slot="content">{historyCards}</div>
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
                Rewrite history entry
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
              "
            >
              <p style="
                  margin: 0;
                  font-size: 0.85rem;
                  color: #64748b;
                  line-height: 1.5;
                ">
                Use <code>history.key(index)</code>{" "}
                to get a cell reference to a specific entry, then call{" "}
                <code>.set()</code> to modify it directly.
              </p>
              <div style="
                  display: grid;
                  grid-template-columns: 1fr 1fr auto;
                  gap: 0.75rem;
                  align-items: flex-end;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="entry-index"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Entry index
                  </label>
                  <ct-input
                    id="entry-index"
                    type="number"
                    step="1"
                    min="0"
                    $value={indexField}
                    placeholder="e.g., 0"
                    aria-label="Index of entry to rewrite"
                  >
                  </ct-input>
                </div>
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="new-value"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    New value
                  </label>
                  <ct-input
                    id="new-value"
                    type="number"
                    step="1"
                    $value={newValueField}
                    placeholder="e.g., 42"
                    aria-label="New value for entry"
                  >
                  </ct-input>
                </div>
                <ct-button
                  variant="secondary"
                  onClick={rewriteHandler}
                  aria-label="Rewrite history entry"
                >
                  Rewrite entry
                </ct-button>
              </div>
            </div>
          </ct-card>
        </div>
      ),
      value,
      history,
      count,
      total,
      headline,
      labels,
      record: recordValue({ value, history }),
      rewrite: rewriteHistoryEntry({ history }),
    };
  },
);

export default counterWithOpaqueRefMapUx;
