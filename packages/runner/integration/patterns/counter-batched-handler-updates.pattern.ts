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
      createCell(
        {
          type: "object",
          additionalProperties: false,
          required: ["note", "applied"],
          properties: {
            note: { type: "string" },
            applied: { type: "number" },
          },
        },
        "counterBatchedHandlerAudit",
        { note: fallbackNote, applied: 0 },
      );
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

    createCell(
      {
        type: "object",
        additionalProperties: false,
        required: ["note", "applied", "increments"],
        properties: {
          note: { type: "string" },
          applied: { type: "number" },
          increments: { type: "number" },
        },
      },
      "counterBatchedHandlerAudit",
      { note, applied: nextValue, increments: amounts.length },
    );
  },
);

export const counterWithBatchedHandlerUpdates = recipe<BatchedCounterArgs>(
  "Counter With Batched Handler Updates",
  ({ value }) => {
    const processedIncrements = cell(0);
    const batchCount = cell(0);
    const history = cell<number[]>([]);
    const lastNote = cell("idle");

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

    const lastTotal = derive(historyView, (entries) => {
      if (entries.length === 0) {
        return currentValue.get();
      }
      return entries[entries.length - 1];
    });

    const summary =
      str`Processed ${processed} increments over ${batches} batches (${noteView})`;

    return {
      value,
      currentValue,
      processed,
      batches,
      history: historyView,
      note: noteView,
      lastTotal,
      summary,
      applyBatch: applyBatchedIncrement({
        value,
        processedIncrements,
        batchCount,
        history,
        lastNote,
      }),
    };
  },
);
