/// <cts-enable />
import { Cell, handler, lift, recipe } from "commontools";

interface LiftFormattingArgs {
  value?: number;
}

const addOne = handler(
  (
    event: { amount?: number } | undefined,
    context: { value: Cell<number> },
  ) => {
    const amount = typeof event?.amount === "number" ? event.amount : 1;
    const next = (context.value.get() ?? 0) + amount;
    context.value.set(next);
  },
);

export const counterWithLiftFormatting = recipe<LiftFormattingArgs>(
  "Counter With Lift Formatting",
  ({ value }) => {
    value.setDefault(0);

    const formatted = lift((count: number) => `Value: ${count.toFixed(2)}`)(
      value,
    );

    return {
      value,
      formatted,
      increment: addOne({ value }),
    };
  },
);
