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

interface CounterRedoStackArgs {
  value: Default<number, 0>;
  undoStack: Default<number[], []>;
  redoStack: Default<number[], []>;
}

const sanitizeNumber = (input: unknown): number => {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return 0;
  }
  return input;
};

const sanitizeStack = (input: unknown): number[] => {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.filter((item): item is number => {
    return typeof item === "number" && Number.isFinite(item);
  });
};

const applyChange = handler(
  (
    event: { amount?: number } | undefined,
    context: {
      value: Cell<number>;
      undoStack: Cell<number[]>;
      redoStack: Cell<number[]>;
    },
  ) => {
    const amount =
      typeof event?.amount === "number" && Number.isFinite(event.amount)
        ? event.amount
        : 1;

    const currentValue = sanitizeNumber(context.value.get());
    const nextValue = currentValue + amount;

    const undoEntries = sanitizeStack(context.undoStack.get());
    context.undoStack.set([...undoEntries, currentValue]);

    context.value.set(nextValue);
    context.redoStack.set([]);
  },
);

const undoLast = handler(
  (
    _event: unknown,
    context: {
      value: Cell<number>;
      undoStack: Cell<number[]>;
      redoStack: Cell<number[]>;
    },
  ) => {
    const undoEntries = sanitizeStack(context.undoStack.get());
    if (undoEntries.length === 0) {
      return;
    }

    const redoEntries = sanitizeStack(context.redoStack.get());
    const currentValue = sanitizeNumber(context.value.get());
    const previousValue = undoEntries[undoEntries.length - 1];

    context.undoStack.set(undoEntries.slice(0, undoEntries.length - 1));
    context.redoStack.set([...redoEntries, currentValue]);
    context.value.set(previousValue);
  },
);

const redoNext = handler(
  (
    _event: unknown,
    context: {
      value: Cell<number>;
      undoStack: Cell<number[]>;
      redoStack: Cell<number[]>;
    },
  ) => {
    const redoEntries = sanitizeStack(context.redoStack.get());
    if (redoEntries.length === 0) {
      return;
    }

    const undoEntries = sanitizeStack(context.undoStack.get());
    const currentValue = sanitizeNumber(context.value.get());
    const nextValue = redoEntries[redoEntries.length - 1];

    context.redoStack.set(redoEntries.slice(0, redoEntries.length - 1));
    context.undoStack.set([...undoEntries, currentValue]);
    context.value.set(nextValue);
  },
);

export const counterRedoStackUx = recipe<CounterRedoStackArgs>(
  "Counter Redo Stack (UX)",
  ({ value, undoStack, redoStack }) => {
    const currentValue = lift((raw: number | undefined) => sanitizeNumber(raw))(
      value,
    );

    const undoHistory = lift((entries: number[] | undefined) =>
      sanitizeStack(entries)
    )(undoStack);

    const redoHistory = lift((entries: number[] | undefined) =>
      sanitizeStack(entries)
    )(redoStack);

    const undoCount = lift((entries: number[]) => entries.length)(undoHistory);
    const redoCount = lift((entries: number[]) => entries.length)(redoHistory);

    const canUndo = lift((entries: number[]) => entries.length > 0)(
      undoHistory,
    );
    const canRedo = lift((entries: number[]) => entries.length > 0)(
      redoHistory,
    );

    const status =
      str`Value ${currentValue} | undo ${undoCount} | redo ${redoCount}`;

    const amountField = cell<string>("1");

    const applyChangeUi = handler<
      unknown,
      {
        value: Cell<number>;
        undoStack: Cell<number[]>;
        redoStack: Cell<number[]>;
        amountField: Cell<string>;
      }
    >((_event, { value, undoStack, redoStack, amountField }) => {
      const amountStr = amountField.get();
      const amount = Number(amountStr);
      const sanitizedAmount =
        typeof amount === "number" && Number.isFinite(amount) ? amount : 1;

      const currentValue = sanitizeNumber(value.get());
      const nextValue = currentValue + sanitizedAmount;

      const undoEntries = sanitizeStack(undoStack.get());
      undoStack.set([...undoEntries, currentValue]);

      value.set(nextValue);
      redoStack.set([]);
    })({ value, undoStack, redoStack, amountField });

    const undoLastUi = handler<
      unknown,
      {
        value: Cell<number>;
        undoStack: Cell<number[]>;
        redoStack: Cell<number[]>;
      }
    >((_event, { value, undoStack, redoStack }) => {
      const undoEntries = sanitizeStack(undoStack.get());
      if (undoEntries.length === 0) {
        return;
      }

      const redoEntries = sanitizeStack(redoStack.get());
      const currentValue = sanitizeNumber(value.get());
      const previousValue = undoEntries[undoEntries.length - 1];

      undoStack.set(undoEntries.slice(0, undoEntries.length - 1));
      redoStack.set([...redoEntries, currentValue]);
      value.set(previousValue);
    })({ value, undoStack, redoStack });

    const redoNextUi = handler<
      unknown,
      {
        value: Cell<number>;
        undoStack: Cell<number[]>;
        redoStack: Cell<number[]>;
      }
    >((_event, { value, undoStack, redoStack }) => {
      const redoEntries = sanitizeStack(redoStack.get());
      if (redoEntries.length === 0) {
        return;
      }

      const undoEntries = sanitizeStack(undoStack.get());
      const currentValue = sanitizeNumber(value.get());
      const nextValue = redoEntries[redoEntries.length - 1];

      redoStack.set(redoEntries.slice(0, redoEntries.length - 1));
      undoStack.set([...undoEntries, currentValue]);
      value.set(nextValue);
    })({ value, undoStack, redoStack });

    const name = str`Undo/Redo Counter (${currentValue})`;

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 42rem;
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
                  Undo/Redo Stack
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Counter with undo and redo operations
                </h2>
              </div>

              <div style="
                  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                  border-radius: 0.75rem;
                  padding: 1.5rem;
                  display: flex;
                  flex-direction: column;
                  gap: 0.5rem;
                  color: white;
                ">
                <span style="
                    font-size: 0.85rem;
                    opacity: 0.9;
                  ">
                  Current value
                </span>
                <strong style="
                    font-size: 3rem;
                    font-weight: 700;
                    letter-spacing: -0.02em;
                  ">
                  {currentValue}
                </strong>
              </div>

              <div style="
                  display: grid;
                  grid-template-columns: repeat(2, 1fr);
                  gap: 0.75rem;
                ">
                <div style="
                    background: #f1f5f9;
                    border-radius: 0.5rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="
                      font-size: 0.75rem;
                      color: #64748b;
                      text-transform: uppercase;
                      letter-spacing: 0.05em;
                    ">
                    Undo stack
                  </span>
                  <div style="
                      display: flex;
                      align-items: baseline;
                      gap: 0.5rem;
                    ">
                    <span style="
                        font-size: 1.5rem;
                        font-weight: 600;
                        color: #0f172a;
                      ">
                      {undoCount}
                    </span>
                    <span style="
                        font-size: 0.85rem;
                        color: #64748b;
                      ">
                      entries
                    </span>
                  </div>
                </div>

                <div style="
                    background: #f1f5f9;
                    border-radius: 0.5rem;
                    padding: 1rem;
                    display: flex;
                    flex-direction: column;
                    gap: 0.25rem;
                  ">
                  <span style="
                      font-size: 0.75rem;
                      color: #64748b;
                      text-transform: uppercase;
                      letter-spacing: 0.05em;
                    ">
                    Redo stack
                  </span>
                  <div style="
                      display: flex;
                      align-items: baseline;
                      gap: 0.5rem;
                    ">
                    <span style="
                        font-size: 1.5rem;
                        font-weight: 600;
                        color: #0f172a;
                      ">
                      {redoCount}
                    </span>
                    <span style="
                        font-size: 0.85rem;
                        color: #64748b;
                      ">
                      entries
                    </span>
                  </div>
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <div style="
                    display: grid;
                    grid-template-columns: 1fr 2fr;
                    gap: 0.75rem;
                    align-items: flex-end;
                  ">
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.4rem;
                    ">
                    <label
                      for="change-amount"
                      style="
                        font-size: 0.85rem;
                        font-weight: 500;
                        color: #334155;
                      "
                    >
                      Amount
                    </label>
                    <ct-input
                      id="change-amount"
                      type="number"
                      step="1"
                      $value={amountField}
                      aria-label="Enter amount to add or subtract"
                    >
                    </ct-input>
                  </div>
                  <ct-button
                    onClick={applyChangeUi}
                    aria-label="Apply change and record in undo stack"
                  >
                    Apply change
                  </ct-button>
                </div>

                <div style="
                    display: grid;
                    grid-template-columns: repeat(2, 1fr);
                    gap: 0.75rem;
                  ">
                  <ct-button
                    variant="secondary"
                    disabled={lift((can: boolean) => !can)(canUndo)}
                    onClick={undoLastUi}
                    aria-label="Undo last change"
                  >
                    ← Undo
                  </ct-button>
                  <ct-button
                    variant="secondary"
                    disabled={lift((can: boolean) => !can)(canRedo)}
                    onClick={redoNextUi}
                    aria-label="Redo next change"
                  >
                    Redo →
                  </ct-button>
                </div>
              </div>
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="
              font-size: 0.85rem;
              color: #475569;
              text-align: center;
            "
          >
            {status}
          </div>
        </div>
      ),
      value,
      undoStack,
      redoStack,
      currentValue,
      undoHistory,
      redoHistory,
      undoCount,
      redoCount,
      canUndo,
      canRedo,
      status,
      apply: applyChange({ value, undoStack, redoStack }),
      undo: undoLast({ value, undoStack, redoStack }),
      redo: redoNext({ value, undoStack, redoStack }),
    };
  },
);

export default counterRedoStackUx;
