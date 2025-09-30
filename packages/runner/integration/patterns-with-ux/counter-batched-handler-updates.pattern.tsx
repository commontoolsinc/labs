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

interface BatchedCounterArgs {
  value: Default<number, 0>;
}

interface BatchEvent {
  amounts?: unknown;
  note?: unknown;
}

const toNumber = (input: unknown, fallback = 0): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fallback;
  }
  return input;
};

const sanitizeAmounts = (input: unknown): number[] => {
  if (!Array.isArray(input)) {
    return [];
  }
  const result: number[] = [];
  for (const value of input) {
    const coerced = toNumber(value, Number.NaN);
    if (Number.isFinite(coerced)) {
      result.push(coerced);
    }
  }
  return result;
};

const applyBatchedIncrement = handler(
  (
    event: BatchEvent | undefined,
    context: {
      value: Cell<number>;
      processedIncrements: Cell<number>;
      batchCount: Cell<number>;
      history: Cell<number[]>;
      lastNote: Cell<string>;
    },
  ) => {
    const amounts = sanitizeAmounts(event?.amounts);
    const currentRaw = context.value.get();
    const currentValue = toNumber(currentRaw, 0);

    if (amounts.length === 0) {
      const fallbackNote =
        typeof event?.note === "string" && event.note.length > 0
          ? event.note
          : "no-op batch";
      context.lastNote.set(fallbackNote);
      return;
    }

    const sum = amounts.reduce((total, item) => total + item, 0);
    const nextValue = currentValue + sum;
    context.value.set(nextValue);

    const processedRaw = context.processedIncrements.get();
    const processed = toNumber(processedRaw, 0);
    context.processedIncrements.set(processed + amounts.length);

    const batchesRaw = context.batchCount.get();
    const batches = toNumber(batchesRaw, 0);
    context.batchCount.set(batches + 1);

    const historyRaw = context.history.get();
    const history = Array.isArray(historyRaw) ? historyRaw : [];
    context.history.set([...history, nextValue]);

    const note = typeof event?.note === "string" && event.note.length > 0
      ? event.note
      : `batch ${amounts.length}`;
    context.lastNote.set(note);
  },
);

const applyBatchFromUI = handler(
  (
    _event: unknown,
    context: {
      value: Cell<number>;
      processedIncrements: Cell<number>;
      batchCount: Cell<number>;
      history: Cell<number[]>;
      lastNote: Cell<string>;
      amountsInput: Cell<string>;
      noteInput: Cell<string>;
    },
  ) => {
    const amountsRaw = context.amountsInput.get();
    const amountsStr = typeof amountsRaw === "string" ? amountsRaw : "";
    const amounts = amountsStr
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => parseFloat(s))
      .filter((n) => Number.isFinite(n));

    const noteRaw = context.noteInput.get();
    const note = typeof noteRaw === "string" && noteRaw.trim() !== ""
      ? noteRaw
      : "";

    const currentRaw = context.value.get();
    const currentValue = toNumber(currentRaw, 0);

    if (amounts.length === 0) {
      const fallbackNote = note.length > 0 ? note : "no-op batch";
      context.lastNote.set(fallbackNote);
      context.amountsInput.set("");
      context.noteInput.set("");
      return;
    }

    const sum = amounts.reduce((total, item) => total + item, 0);
    const nextValue = currentValue + sum;
    context.value.set(nextValue);

    const processedRaw = context.processedIncrements.get();
    const processed = toNumber(processedRaw, 0);
    context.processedIncrements.set(processed + amounts.length);

    const batchesRaw = context.batchCount.get();
    const batches = toNumber(batchesRaw, 0);
    context.batchCount.set(batches + 1);

    const historyRaw = context.history.get();
    const history = Array.isArray(historyRaw) ? historyRaw : [];
    context.history.set([...history, nextValue]);

    const finalNote = note.length > 0 ? note : `batch ${amounts.length}`;
    context.lastNote.set(finalNote);

    context.amountsInput.set("");
    context.noteInput.set("");
  },
);

export const counterWithBatchedHandlerUpdatesUx = recipe<BatchedCounterArgs>(
  "Counter With Batched Handler Updates (UX)",
  ({ value }) => {
    const processedIncrements = cell(0);
    const batchCount = cell(0);
    const history = cell<number[]>([]);
    const lastNote = cell("idle");

    const amountsInput = cell("");
    const noteInput = cell("");

    const currentValue = lift((input: number | undefined) =>
      toNumber(input, 0)
    )(
      value,
    );
    const processed = lift((input: number | undefined) => toNumber(input, 0))(
      processedIncrements,
    );
    const batches = lift((input: number | undefined) => toNumber(input, 0))(
      batchCount,
    );
    const historyView = lift((input: number[] | undefined) =>
      Array.isArray(input) ? input : []
    )(history);
    const noteView = lift((input: string | undefined) =>
      typeof input === "string" && input.length > 0 ? input : "idle"
    )(lastNote);

    const lastTotal = lift((entries: number[]) => {
      if (entries.length === 0) {
        return currentValue.get();
      }
      return entries[entries.length - 1];
    })(historyView);

    const summary =
      str`Processed ${processed} increments over ${batches} batches (${noteView})`;

    const name = str`Batched Counter: ${value}`;

    const applyBatch = applyBatchedIncrement({
      value,
      processedIncrements,
      batchCount,
      history,
      lastNote,
    });

    const applyUIBatch = applyBatchFromUI({
      value,
      processedIncrements,
      batchCount,
      history,
      lastNote,
      amountsInput,
      noteInput,
    });

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 48rem;
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
                  Batched Handler Updates
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Counter with batch processing
                </h2>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(3, 1fr);
                  gap: 1rem;
                ">
                <div style="
                    background: linear-gradient(135deg, #dbeafe, #bfdbfe);
                    border-radius: 0.5rem;
                    padding: 1.5rem;
                    text-align: center;
                  ">
                  <div style="
                      font-size: 0.75rem;
                      text-transform: uppercase;
                      letter-spacing: 0.05em;
                      color: #1e40af;
                      font-weight: 600;
                      margin-bottom: 0.5rem;
                    ">
                    Current Value
                  </div>
                  <div style="
                      font-size: 2.5rem;
                      font-weight: 700;
                      color: #1e3a8a;
                      font-family: monospace;
                    ">
                    {value}
                  </div>
                </div>

                <div style="
                    background: linear-gradient(135deg, #dcfce7, #bbf7d0);
                    border-radius: 0.5rem;
                    padding: 1.5rem;
                    text-align: center;
                  ">
                  <div style="
                      font-size: 0.75rem;
                      text-transform: uppercase;
                      letter-spacing: 0.05em;
                      color: #15803d;
                      font-weight: 600;
                      margin-bottom: 0.5rem;
                    ">
                    Total Increments
                  </div>
                  <div style="
                      font-size: 2.5rem;
                      font-weight: 700;
                      color: #14532d;
                      font-family: monospace;
                    ">
                    {processed}
                  </div>
                </div>

                <div style="
                    background: linear-gradient(135deg, #fef3c7, #fde68a);
                    border-radius: 0.5rem;
                    padding: 1.5rem;
                    text-align: center;
                  ">
                  <div style="
                      font-size: 0.75rem;
                      text-transform: uppercase;
                      letter-spacing: 0.05em;
                      color: #92400e;
                      font-weight: 600;
                      margin-bottom: 0.5rem;
                    ">
                    Total Batches
                  </div>
                  <div style="
                      font-size: 2.5rem;
                      font-weight: 700;
                      color: #78350f;
                      font-family: monospace;
                    ">
                    {batches}
                  </div>
                </div>
              </div>

              <div style="
                  background: #f8fafc;
                  border: 2px solid #e2e8f0;
                  border-radius: 0.5rem;
                  padding: 1rem;
                ">
                <div style="
                    font-size: 0.875rem;
                    color: #64748b;
                    font-weight: 500;
                    margin-bottom: 0.5rem;
                  ">
                  Last Note:
                </div>
                <div style="
                    font-size: 1rem;
                    color: #0f172a;
                    font-family: monospace;
                  ">
                  {noteView}
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
              <h3 style="
                  margin: 0;
                  font-size: 1.1rem;
                  color: #0f172a;
                ">
                Apply Batch
              </h3>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <label style="
                    font-size: 0.875rem;
                    color: #475569;
                    font-weight: 500;
                  ">
                  Amounts (comma-separated numbers):
                </label>
                <ct-input
                  $value={amountsInput}
                  placeholder="e.g., 1, 5, 10, 2"
                />
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                ">
                <label style="
                    font-size: 0.875rem;
                    color: #475569;
                    font-weight: 500;
                  ">
                  Note (optional):
                </label>
                <ct-input
                  $value={noteInput}
                  placeholder="e.g., daily increment"
                />
              </div>

              <ct-button onClick={applyUIBatch}>Apply Batch</ct-button>

              <div style="
                  background: #f1f5f9;
                  border-radius: 0.375rem;
                  padding: 0.75rem;
                  font-size: 0.8rem;
                  color: #475569;
                  line-height: 1.5;
                ">
                <strong>Example:</strong>{" "}
                Enter "1, 2, 3" to apply a batch of three increments. The
                counter will increase by 6 (1+2+3), and the system will record
                that 3 increments were processed in 1 batch.
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
              <h3 style="
                  margin: 0;
                  font-size: 1.1rem;
                  color: #0f172a;
                ">
                History
              </h3>

              {lift((entries: number[]) => {
                if (entries.length === 0) {
                  return (
                    <div style="
                        text-align: center;
                        padding: 2rem;
                        color: #94a3b8;
                        font-size: 0.875rem;
                      ">
                      No batches processed yet
                    </div>
                  );
                }

                const elements = [];
                const reversed = entries.slice().reverse();
                for (let i = 0; i < Math.min(reversed.length, 8); i++) {
                  const entry = reversed[i];
                  const bg = i % 2 === 0 ? "#ffffff" : "#f8fafc";
                  elements.push(
                    <div
                      style={"display: flex; justify-content: space-between; align-items: center; padding: 0.75rem; background: " +
                        bg + "; border-radius: 0.375rem;"}
                    >
                      <span style="
                          font-size: 0.875rem;
                          color: #64748b;
                        ">
                        Batch {String(entries.length - i)}
                      </span>
                      <span style="
                          font-size: 1.125rem;
                          font-weight: 600;
                          color: #0f172a;
                          font-family: monospace;
                        ">
                        {String(entry)}
                      </span>
                    </div>,
                  );
                }
                return (
                  <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                    {elements}
                  </div>
                );
              })(historyView)}
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="content"
              style="
                background: #f8fafc;
                border-radius: 0.5rem;
                padding: 1rem;
                font-size: 0.85rem;
                color: #475569;
                line-height: 1.6;
              "
            >
              <strong>Pattern:</strong>{" "}
              This demonstrates batched handler updates where a single handler
              processes multiple increments at once. Instead of calling the
              handler multiple times, you pass an array of amounts that are all
              processed together. This pattern is useful for bulk operations
              where you want to track both individual increments and batch
              operations separately. The handler updates multiple cells (value,
              processedIncrements, batchCount, history) atomically, ensuring
              consistent state across all derived values.
            </div>
          </ct-card>
        </div>
      ),
      value,
      currentValue,
      processed,
      batches,
      history: historyView,
      note: noteView,
      lastTotal,
      summary,
      applyBatch,
    };
  },
);

export default counterWithBatchedHandlerUpdatesUx;
