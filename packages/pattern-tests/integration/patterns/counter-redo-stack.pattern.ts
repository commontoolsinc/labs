/// <cts-enable />
import { Cell, Default, handler, lift, recipe, str } from "commontools";

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

export const counterRedoStack = recipe<CounterRedoStackArgs>(
  "Counter Redo Stack",
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

    return {
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
